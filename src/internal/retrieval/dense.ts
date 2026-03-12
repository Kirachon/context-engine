import type { SearchResult } from '../../mcp/serviceClient.js';
import type { InternalSearchResult } from './types.js';

function parseLineStart(lines?: string): number {
  if (!lines) return Number.MAX_SAFE_INTEGER;
  const match = lines.match(/(\d+)/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export interface DenseScoreOptions {
  queryVariant: string;
  variantIndex: number;
  variantWeight: number;
}

export function scoreDenseCandidates(
  results: SearchResult[],
  options: DenseScoreOptions
): InternalSearchResult[] {
  return results.map((result) => {
    const denseScore = clampScore(result.relevanceScore ?? result.score ?? 0);
    return {
      ...result,
      retrievalSource: 'dense',
      denseScore,
      relevanceScore: denseScore,
      combinedScore: denseScore,
      tieBreakPath: result.path,
      tieBreakLine: parseLineStart(result.lines),
      queryVariant: options.queryVariant,
      variantIndex: options.variantIndex,
      variantWeight: options.variantWeight,
    };
  });
}

