import { InternalSearchResult, RetrievalRankingMode } from './types.js';

export interface RerankOptions {
  originalQuery?: string;
  mode?: RetrievalRankingMode;
}

function resultSignature(result: InternalSearchResult): string {
  const lines = result.lines ?? '';
  const contentSnippet = result.content.slice(0, 120).replace(/\s+/g, ' ').trim();
  return `${result.path}::${lines}::${contentSnippet}`;
}

function parseStartLine(lines?: string): number {
  if (!lines) {
    return Number.MAX_SAFE_INTEGER;
  }
  const match = lines.match(/(\d+)/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const value = Number(match[1]);
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .filter(Boolean);
}

function buildPathTokenSet(path: string): Set<string> {
  return new Set(
    path
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map(token => token.trim())
      .filter(Boolean)
  );
}

function overlapScore(queryTokens: string[], pathTokens: Set<string>): number {
  if (queryTokens.length === 0 || pathTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of queryTokens) {
    if (pathTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.length;
}

function hasExactSymbolMatch(result: InternalSearchResult, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) {
    return false;
  }
  const haystack = `${result.path} ${result.content}`.toLowerCase();
  return queryTokens.some(token => token.length >= 3 && haystack.includes(token));
}

function pathDepth(path: string): number {
  const segments = path.split(/[\\/]+/g).filter(Boolean);
  return segments.length;
}

function exactPathTailMatch(path: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false;
  const normalizedPath = path.toLowerCase();
  return queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.ts`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.js`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.py`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.includes(`/${token}/`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.includes(`\\${token}\\`));
}

export function rerankResults(
  results: InternalSearchResult[],
  options: RerankOptions = {}
): InternalSearchResult[] {
  const mode: RetrievalRankingMode = options.mode ?? 'v1';
  const stats = new Map<string, { count: number; hasOriginal: boolean }>();
  const sourceStats = new Map<string, Set<InternalSearchResult['retrievalSource']>>();
  const queryTokens = tokenize(options.originalQuery ?? '');

  for (const result of results) {
    const key = resultSignature(result);
    const entry = stats.get(key) ?? { count: 0, hasOriginal: false };
    entry.count += 1;
    if (result.variantIndex === 0) {
      entry.hasOriginal = true;
    }
    stats.set(key, entry);
    const sourceSet = sourceStats.get(key) ?? new Set<InternalSearchResult['retrievalSource']>();
    sourceSet.add(result.retrievalSource);
    sourceStats.set(key, sourceSet);
  }

  const ranked = results.map((result, index) => {
    const baseScore = result.relevanceScore ?? result.score ?? 0;
    const signature = resultSignature(result);
    const entry = stats.get(signature) ?? { count: 1, hasOriginal: false };
    const frequencyBonus = Math.log2(1 + entry.count) * 0.08;
    const originalBonus = entry.hasOriginal ? 0.05 : 0;
    const variantWeightBonus = (result.variantWeight - 0.5) * 0.05;
    let combinedScore = baseScore + frequencyBonus + originalBonus + variantWeightBonus;

    if (mode === 'v2' || mode === 'v3') {
      const pathOverlap = overlapScore(queryTokens, buildPathTokenSet(result.path));
      const sourceConsensus = Math.max(0, (sourceStats.get(signature)?.size ?? 1) - 1);
      const exactSymbolBonus = hasExactSymbolMatch(result, queryTokens) ? 0.04 : 0;
      combinedScore += (pathOverlap * 0.08) + (sourceConsensus * 0.03) + exactSymbolBonus;
    }

    if (mode === 'v3') {
      const sourceConsensus = Math.max(0, (sourceStats.get(signature)?.size ?? 1) - 1);
      const lineStart = parseStartLine(result.lines);
      const lineProximityBonus = Number.isFinite(lineStart) && lineStart < 120 ? 0.03 : 0;
      const pathSpecificityBonus = exactPathTailMatch(result.path, queryTokens) ? 0.05 : 0;
      const depthPenalty = Math.max(0, pathDepth(result.path) - 8) * 0.0025;
      combinedScore += (sourceConsensus * 0.015) + lineProximityBonus + pathSpecificityBonus - depthPenalty;
    }

    return {
      result: {
        ...result,
        combinedScore,
      },
      combinedScore,
      baseScore,
      index,
    };
  });

  ranked.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) {
      return b.combinedScore - a.combinedScore;
    }
    if (b.baseScore !== a.baseScore) {
      return b.baseScore - a.baseScore;
    }
    if (a.result.path !== b.result.path) {
      return a.result.path.localeCompare(b.result.path);
    }
    const lineA = parseStartLine(a.result.lines);
    const lineB = parseStartLine(b.result.lines);
    if (lineA !== lineB) {
      return lineA - lineB;
    }
    return a.index - b.index;
  });

  return ranked.map(entry => entry.result);
}
