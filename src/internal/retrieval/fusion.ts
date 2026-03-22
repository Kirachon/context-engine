import type { InternalSearchResult } from './types.js';

function parseLineStart(lines?: string): number {
  if (!lines) return Number.MAX_SAFE_INTEGER;
  const match = lines.match(/(\d+)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function parseLineSpan(lines?: string): number | null {
  if (!lines) return null;
  const match = lines.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start + 1;
}

function fusionKey(result: InternalSearchResult): string {
  const normalized = (result.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${result.path}::${result.lines ?? ''}::${normalized}`;
}

const FUSION_CALIBRATION = {
  chunkIdBonus: 0.02,
  spanBonuses: [
    { maxSpan: 8, bonus: 0.05 },
    { maxSpan: 24, bonus: 0.03 },
    { maxSpan: 60, bonus: 0.015 },
  ],
  maxChunkAffinityBonus: 0.08,
} as const;

function clampWeight(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function chunkAffinityBonus(result: InternalSearchResult): number {
  let bonus = 0;
  if (typeof result.chunkId === 'string' && result.chunkId.trim().length > 0) {
    bonus += FUSION_CALIBRATION.chunkIdBonus;
  }
  const span = parseLineSpan(result.lines);
  if (span !== null) {
    for (const entry of FUSION_CALIBRATION.spanBonuses) {
      if (span <= entry.maxSpan) {
        bonus += entry.bonus;
        break;
      }
    }
  }
  return Math.min(FUSION_CALIBRATION.maxChunkAffinityBonus, bonus);
}

export interface FusionOptions {
  semanticWeight?: number;
  lexicalWeight?: number;
  denseWeight?: number;
}

export function fuseCandidates(
  results: InternalSearchResult[],
  options: FusionOptions = {}
): InternalSearchResult[] {
  if (results.length === 0) return [];

  const semanticWeight = clampWeight(options.semanticWeight, 0.7);
  const lexicalWeight = clampWeight(options.lexicalWeight, 0.3);
  const denseWeight = clampWeight(options.denseWeight, 0);
  const totalWeight = semanticWeight + lexicalWeight + denseWeight || 1;
  const semanticNormWeight = semanticWeight / totalWeight;
  const lexicalNormWeight = lexicalWeight / totalWeight;
  const denseNormWeight = denseWeight / totalWeight;

  const maxSemantic = results.reduce((max, item) => {
    const score = item.semanticScore ?? (
      item.retrievalSource === 'semantic' || item.retrievalSource === 'hybrid'
        ? item.relevanceScore ?? item.score ?? 0
        : 0
    );
    return Math.max(max, score);
  }, 0);
  const maxLexical = results.reduce((max, item) => {
    const score = item.lexicalScore ?? (item.retrievalSource === 'lexical' ? item.relevanceScore ?? 0 : 0);
    return Math.max(max, score);
  }, 0);
  const maxDense = results.reduce((max, item) => {
    const score = item.denseScore ?? (item.retrievalSource === 'dense' ? item.relevanceScore ?? 0 : 0);
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
      const value = item.semanticScore ?? (
        item.retrievalSource === 'semantic' || item.retrievalSource === 'hybrid'
          ? item.relevanceScore ?? item.score ?? 0
          : 0
      );
      return Math.max(max, value);
    }, 0);
    const lexicalScore = group.reduce((max, item) => {
      const value = item.lexicalScore ?? (item.retrievalSource === 'lexical' ? item.relevanceScore ?? item.score ?? 0 : 0);
      return Math.max(max, value);
    }, 0);
    const denseScore = group.reduce((max, item) => {
      const value = item.denseScore ?? (item.retrievalSource === 'dense' ? item.relevanceScore ?? item.score ?? 0 : 0);
      return Math.max(max, value);
    }, 0);

    const normalizedSemantic = maxSemantic > 0 ? semanticScore / maxSemantic : 0;
    const normalizedLexical = maxLexical > 0 ? lexicalScore / maxLexical : 0;
    const normalizedDense = maxDense > 0 ? denseScore / maxDense : 0;
    const chunkBonus = chunkAffinityBonus(representative);
    const fusedScore =
      (normalizedSemantic * semanticNormWeight) +
      (normalizedLexical * lexicalNormWeight) +
      (normalizedDense * denseNormWeight) +
      chunkBonus;

    const hasSemantic = semanticScore > 0;
    const hasLexical = lexicalScore > 0;
    const hasDense = denseScore > 0;
    const sourceCount = Number(hasSemantic) + Number(hasLexical) + Number(hasDense);
    const retrievalSource = sourceCount > 1
      ? 'hybrid'
      : hasSemantic
        ? 'semantic'
        : hasLexical
          ? 'lexical'
          : 'dense';

    const bestVariant = group.reduce((best, item) => {
      if (item.variantWeight > best.variantWeight) return item;
      return best;
    }, representative);

    fused.push({
      ...bestVariant,
      retrievalSource,
      semanticScore,
      lexicalScore,
      denseScore,
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
