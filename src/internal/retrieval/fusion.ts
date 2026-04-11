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
  rankConstant: 10,
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

type RetrievalSource = 'semantic' | 'lexical' | 'dense';

function resolveRetrievalSource(result: InternalSearchResult): RetrievalSource {
  if (result.retrievalSource === 'lexical') {
    return 'lexical';
  }
  if (result.retrievalSource === 'dense') {
    return 'dense';
  }
  return 'semantic';
}

function resolveVariantWeight(result: InternalSearchResult): number {
  return clampWeight(result.variantWeight, 1);
}

function resolveVariantListKey(result: InternalSearchResult): string {
  if (Number.isFinite(result.variantIndex)) {
    return String(result.variantIndex);
  }
  const queryVariant = typeof result.queryVariant === 'string' ? result.queryVariant.trim() : '';
  return queryVariant.length > 0 ? queryVariant : 'default';
}

function resolveRankListSources(result: InternalSearchResult): RetrievalSource[] {
  const sources = (['semantic', 'lexical', 'dense'] as const).filter((source) => sourceScore(result, source) > 0);
  return sources.length > 0 ? [...sources] : [resolveRetrievalSource(result)];
}

function sourceScore(result: InternalSearchResult, source: RetrievalSource): number {
  if (source === 'semantic') {
    return result.semanticScore ?? (
      result.retrievalSource === 'semantic' || result.retrievalSource === 'hybrid'
        ? result.relevanceScore ?? result.score ?? 0
        : 0
    );
  }
  if (source === 'lexical') {
    return result.lexicalScore ?? (result.retrievalSource === 'lexical' ? result.relevanceScore ?? result.score ?? 0 : 0);
  }
  return result.denseScore ?? (result.retrievalSource === 'dense' ? result.relevanceScore ?? result.score ?? 0 : 0);
}

function buildRankedLists(
  results: InternalSearchResult[],
  weights: Record<RetrievalSource, number>
): Array<{ weight: number; ranks: Map<string, number> }> {
  const lists = new Map<string, { source: RetrievalSource; variantWeight: number; items: InternalSearchResult[] }>();

  for (const result of results) {
    const variantKey = resolveVariantListKey(result);
    for (const source of resolveRankListSources(result)) {
      const listId = `${source}:${variantKey}`;
      const existing = lists.get(listId);
      if (existing) {
        existing.items.push(result);
        existing.variantWeight = Math.max(existing.variantWeight, resolveVariantWeight(result));
        continue;
      }
      lists.set(listId, {
        source,
        variantWeight: resolveVariantWeight(result),
        items: [result],
      });
    }
  }

  const rankedLists: Array<{ weight: number; ranks: Map<string, number> }> = [];
  for (const list of lists.values()) {
    const backendWeight = weights[list.source];
    const listWeight = backendWeight * list.variantWeight;
    if (!(listWeight > 0)) {
      continue;
    }

    const rankedItems = [...list.items].sort((left, right) => {
      const scoreDelta = sourceScore(right, list.source) - sourceScore(left, list.source);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return parseLineStart(left.lines) - parseLineStart(right.lines);
    });

    const ranks = new Map<string, number>();
    for (const [index, item] of rankedItems.entries()) {
      const key = fusionKey(item);
      if (!ranks.has(key)) {
        ranks.set(key, index + 1);
      }
    }
    rankedLists.push({ weight: listWeight, ranks });
  }

  return rankedLists;
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
  const rankedLists = buildRankedLists(results, {
    semantic: semanticNormWeight,
    lexical: lexicalNormWeight,
    dense: denseNormWeight,
  });

  const groups = new Map<string, InternalSearchResult[]>();
  for (const result of results) {
    const key = fusionKey(result);
    const existing = groups.get(key) ?? [];
    existing.push(result);
    groups.set(key, existing);
  }

  const fused: InternalSearchResult[] = [];

  for (const group of groups.values()) {
    const semanticScore = group.reduce((max, item) => {
      const value = sourceScore(item, 'semantic');
      return Math.max(max, value);
    }, 0);
    const lexicalScore = group.reduce((max, item) => {
      const value = sourceScore(item, 'lexical');
      return Math.max(max, value);
    }, 0);
    const denseScore = group.reduce((max, item) => {
      const value = sourceScore(item, 'dense');
      return Math.max(max, value);
    }, 0);
    const key = fusionKey(group[0]);
    const reciprocalRankScore = rankedLists.reduce((sum, list) => {
      const rank = list.ranks.get(key);
      if (!rank) {
        return sum;
      }
      return sum + (list.weight / (FUSION_CALIBRATION.rankConstant + rank));
    }, 0);
    const chunkBonus = group.reduce((max, item) => Math.max(max, chunkAffinityBonus(item)), 0);
    const fusedScore = reciprocalRankScore + chunkBonus;

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
      if (resolveVariantWeight(item) > resolveVariantWeight(best)) return item;
      return best;
    }, group[0]);

    fused.push({
      ...bestVariant,
      variantWeight: resolveVariantWeight(bestVariant),
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
