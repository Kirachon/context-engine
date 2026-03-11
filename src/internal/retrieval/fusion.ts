import type { InternalSearchResult } from './types.js';

function parseLineStart(lines?: string): number {
  if (!lines) return Number.MAX_SAFE_INTEGER;
  const match = lines.match(/(\d+)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function fusionKey(result: InternalSearchResult): string {
  const normalized = (result.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${result.path}::${result.lines ?? ''}::${normalized}`;
}

function clampWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export interface FusionOptions {
  semanticWeight?: number;
  lexicalWeight?: number;
}

export function fuseCandidates(
  results: InternalSearchResult[],
  options: FusionOptions = {}
): InternalSearchResult[] {
  if (results.length === 0) return [];

  const semanticWeight = clampWeight(options.semanticWeight, 0.7);
  const lexicalWeight = clampWeight(options.lexicalWeight, 0.3);
  const totalWeight = semanticWeight + lexicalWeight || 1;
  const semanticNormWeight = semanticWeight / totalWeight;
  const lexicalNormWeight = lexicalWeight / totalWeight;

  const maxSemantic = results.reduce((max, item) => {
    const score = item.semanticScore ?? item.relevanceScore ?? item.score ?? 0;
    return Math.max(max, score);
  }, 0);
  const maxLexical = results.reduce((max, item) => {
    const score = item.lexicalScore ?? (item.retrievalSource === 'lexical' ? item.relevanceScore ?? 0 : 0);
    return Math.max(max, score);
  }, 0);

  const groups = new Map<string, InternalSearchResult[]>();
  for (const result of results) {
    const key = fusionKey(result);
    const existing = groups.get(key) ?? [];
    existing.push(result);
    groups.set(key, existing);
  }

  const fused: InternalSearchResult[] = [];

  for (const group of groups.values()) {
    const representative = group[0];
    const semanticScore = group.reduce((max, item) => {
      const value = item.semanticScore ?? (item.retrievalSource !== 'lexical' ? item.relevanceScore ?? item.score ?? 0 : 0);
      return Math.max(max, value);
    }, 0);
    const lexicalScore = group.reduce((max, item) => {
      const value = item.lexicalScore ?? (item.retrievalSource === 'lexical' ? item.relevanceScore ?? item.score ?? 0 : 0);
      return Math.max(max, value);
    }, 0);

    const normalizedSemantic = maxSemantic > 0 ? semanticScore / maxSemantic : 0;
    const normalizedLexical = maxLexical > 0 ? lexicalScore / maxLexical : 0;
    const fusedScore = (normalizedSemantic * semanticNormWeight) + (normalizedLexical * lexicalNormWeight);

    const hasSemantic = semanticScore > 0;
    const hasLexical = lexicalScore > 0;
    const retrievalSource = hasSemantic && hasLexical
      ? 'hybrid'
      : hasSemantic
        ? 'semantic'
        : 'lexical';

    const bestVariant = group.reduce((best, item) => {
      if (item.variantWeight > best.variantWeight) return item;
      return best;
    }, representative);

    fused.push({
      ...bestVariant,
      retrievalSource,
      semanticScore,
      lexicalScore,
      fusedScore,
      combinedScore: fusedScore,
      relevanceScore: fusedScore,
      tieBreakPath: bestVariant.path,
      tieBreakLine: parseLineStart(bestVariant.lines),
    });
  }

  fused.sort((a, b) => {
    const aCombined = a.combinedScore ?? 0;
    const bCombined = b.combinedScore ?? 0;
    if (bCombined !== aCombined) return bCombined - aCombined;

    const aSemantic = a.semanticScore ?? 0;
    const bSemantic = b.semanticScore ?? 0;
    if (bSemantic !== aSemantic) return bSemantic - aSemantic;

    const aLexical = a.lexicalScore ?? 0;
    const bLexical = b.lexicalScore ?? 0;
    if (bLexical !== aLexical) return bLexical - aLexical;

    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.tieBreakLine ?? Number.MAX_SAFE_INTEGER) - (b.tieBreakLine ?? Number.MAX_SAFE_INTEGER);
  });

  return fused;
}
