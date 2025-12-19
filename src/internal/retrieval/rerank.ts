import { InternalSearchResult } from './types.js';

export interface RerankOptions {
  originalQuery?: string;
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

export function rerankResults(
  results: InternalSearchResult[],
  options: RerankOptions = {}
): InternalSearchResult[] {
  const stats = new Map<string, { count: number; hasOriginal: boolean }>();

  for (const result of results) {
    const key = resultSignature(result);
    const entry = stats.get(key) ?? { count: 0, hasOriginal: false };
    entry.count += 1;
    if (result.variantIndex === 0) {
      entry.hasOriginal = true;
    }
    stats.set(key, entry);
  }

  const ranked = results.map((result, index) => {
    const baseScore = result.relevanceScore ?? result.score ?? 0;
    const entry = stats.get(resultSignature(result)) ?? { count: 1, hasOriginal: false };
    const frequencyBonus = Math.log2(1 + entry.count) * 0.08;
    const originalBonus = entry.hasOriginal ? 0.05 : 0;
    const variantWeightBonus = (result.variantWeight - 0.5) * 0.05;
    const combinedScore = baseScore + frequencyBonus + originalBonus + variantWeightBonus;

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
