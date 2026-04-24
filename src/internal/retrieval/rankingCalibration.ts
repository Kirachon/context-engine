import type {
  InternalSearchResult,
  RankingDiagnostics,
  RankingFallbackReason,
  RankingGateDecision,
  RankingGateSignals,
  RetrievalProfile,
  RetrievalRankingMode,
} from './types.js';
import type { EmbeddingRuntimeStatus } from './embeddingRuntime.js';

/**
 * Stable code set for the p2-calibrate quality guard. Operators watch for
 * these codes to detect silent downgrades in retrieval quality
 * (hash fallback, runtime degradation, reranker off, rerank fail-open).
 */
export type QualityWarningCode =
  | 'embedding_hash_fallback'
  | 'embedding_runtime_degraded'
  | 'reranker_disabled'
  | 'reranker_fallback';

export type QualityWarningSeverity = 'info' | 'warn' | 'error';

export interface QualityWarning {
  code: QualityWarningCode;
  severity: QualityWarningSeverity;
  detail: string;
}

export interface QualityWarningContext {
  /**
   * Current embedding runtime status as reported by
   * `describeEmbeddingRuntimeStatus`. When `undefined`, the transformer runtime
   * is not configured and the hash provider is in effect (explicit fallback).
   */
  embeddingRuntimeStatus?: EmbeddingRuntimeStatus;
  /**
   * Whether the reranker is enabled for this request. `false` means the
   * transformer rerank path was not used (feature-flagged off, gate skipped,
   * or runtime unavailable) and results are effectively un-reranked.
   */
  rerankEnabled: boolean;
  /**
   * Populated when the reranker attempted to run and fell back to the
   * heuristic path. Stable values come from the rerank tracer
   * (e.g. 'rerank_error', 'reranker_unavailable', 'rerank_skipped').
   */
  rerankFallbackReason?: string;
}

const HASH_RUNTIME_IDS = new Set(['hash', 'hash-32', 'hash-128']);

function isHashRuntime(id: string | undefined): boolean {
  if (!id) return false;
  return HASH_RUNTIME_IDS.has(id) || id.startsWith('hash');
}

/**
 * Pure helper. Given a retrieval context, returns the ordered list of quality
 * warnings that should be surfaced on the retrieval response. Never caches,
 * never dedupes across calls — callers must treat this as a per-request
 * signal.
 */
export function computeQualityWarnings(ctx: QualityWarningContext): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const status = ctx.embeddingRuntimeStatus;

  if (!status) {
    warnings.push({
      code: 'embedding_hash_fallback',
      severity: 'warn',
      detail:
        'Transformer embedding runtime is not configured; retrieval is using the hash embedding provider. Semantic quality is degraded.',
    });
  } else {
    // Prefer the runtime's own authoritative signal when available, falling
    // back to id inspection for older status shapes / test fixtures.
    const hashFallback =
      status.hashFallbackActive === true ||
      (isHashRuntime(status.active.id) && !isHashRuntime(status.configured.id));

    if (hashFallback) {
      const downgradeReason = status.downgrade?.reason;
      warnings.push({
        code: 'embedding_hash_fallback',
        severity: 'warn',
        detail:
          `Configured transformer runtime "${status.configured.id}" is unavailable; ` +
          `active runtime fell back to hash provider "${status.active.id}" ` +
          `(loadFailures=${status.loadFailures}` +
          `${downgradeReason ? `, downgradeReason="${downgradeReason}"` : ''}` +
          `${status.lastFailure ? `, lastFailure="${status.lastFailure}"` : ''}).`,
      });
    }

    if (status.state === 'degraded') {
      warnings.push({
        code: 'embedding_runtime_degraded',
        severity: 'warn',
        detail:
          `Embedding runtime "${status.configured.id}" is in degraded state ` +
          `(loadFailures=${status.loadFailures}${status.lastFailure ? `, lastFailure="${status.lastFailure}"` : ''}).`,
      });
    }
  }

  if (!ctx.rerankEnabled) {
    warnings.push({
      code: 'reranker_disabled',
      severity: 'warn',
      detail:
        'Transformer reranker is disabled for this request; results are ordered by heuristic scoring only.',
    });
  } else if (ctx.rerankFallbackReason && ctx.rerankFallbackReason !== 'none') {
    warnings.push({
      code: 'reranker_fallback',
      severity: 'warn',
      detail:
        `Transformer reranker attempted but fell back to heuristic scoring (reason="${ctx.rerankFallbackReason}").`,
    });
  }

  return warnings;
}

/**
 * Side-effecting emit helper. Logs each warning with the stable
 * `[retrieval:quality]` prefix so operators can grep for silent downgrades.
 * Intentionally writes on every invocation — do NOT add caching or
 * suppression here; the guard is meant to be noisy when degraded.
 */
export function emitQualityWarnings(warnings: readonly QualityWarning[]): void {
  for (const warning of warnings) {
    // Stable log shape: `[retrieval:quality] <code> severity=<s> detail=<d>`
    // Using console.warn per spec — no new telemetry libs.
    // eslint-disable-next-line no-console
    console.warn(
      `[retrieval:quality] ${warning.code} severity=${warning.severity} detail=${warning.detail}`
    );
  }
}

export interface RankingCalibrationWeights {
  frequencyBonusScale: number;
  originalBonus: number;
  variantWeightBonusScale: number;
  v2PathOverlapScale: number;
  v2SourceConsensusScale: number;
  v2ExactSymbolBonus: number;
  v3SourceConsensusScale: number;
  v3LineProximityBonus: number;
  v3PathSpecificityBonus: number;
  v3DepthPenaltyPerLevel: number;
}

export interface RankingGateThresholds {
  minCandidateCount: number;
  maxTop1Top2Gap: number;
  maxTopKSpread: number;
  maxDominantSourceShare: number;
  minAmbiguousSignals: number;
}

export const RANKING_V3_WEIGHT_SNAPSHOT: RankingCalibrationWeights = {
  frequencyBonusScale: 0.08,
  originalBonus: 0.05,
  variantWeightBonusScale: 0.05,
  v2PathOverlapScale: 0.08,
  v2SourceConsensusScale: 0.03,
  v2ExactSymbolBonus: 0.04,
  v3SourceConsensusScale: 0.015,
  v3LineProximityBonus: 0.03,
  v3PathSpecificityBonus: 0.05,
  v3DepthPenaltyPerLevel: 0.0025,
};

// p2-calibrate: rerank-acceptance / score-floor thresholds are intentionally
// left at their current values. Tightening requires the fixture-pack baseline
// (tracked separately) to avoid regressions in sibling retrieval tests. The
// quality-guard warnings surfaced via `computeQualityWarnings` are the
// telemetry hook that will drive the next bump.
export const RANKING_HARD_QUERY_GATE: RankingGateThresholds = {
  minCandidateCount: 5,
  maxTop1Top2Gap: 0.072,
  maxTopKSpread: 0.198,
  maxDominantSourceShare: 0.7,
  minAmbiguousSignals: 2,
};

export type RerankPath = 'heuristic' | 'transformer' | 'provider';

export interface RankingDiagnosticsBuildOptions {
  rankingMode: RetrievalRankingMode;
  profile: RetrievalProfile;
  fallbackReason?: RankingFallbackReason;
  rerankPath: RerankPath;
  gateDecision: RankingGateDecision;
}

function scoreOf(result: InternalSearchResult): number {
  return result.combinedScore ?? result.relevanceScore ?? result.score ?? 0;
}

function sourceOf(result: InternalSearchResult): string {
  return (result.retrievalSource ?? result.matchType ?? 'semantic').toLowerCase();
}

function cloneSorted(results: InternalSearchResult[]): InternalSearchResult[] {
  return [...results].sort((a, b) => scoreOf(b) - scoreOf(a));
}

function summarizeSignals(results: InternalSearchResult[], rankingMode: RetrievalRankingMode, profile: RetrievalProfile): RankingGateSignals {
  const sorted = cloneSorted(results);
  const candidateCount = sorted.length;
  const topScore = scoreOf(sorted[0] ?? ({} as InternalSearchResult));
  const secondScore = scoreOf(sorted[1] ?? ({} as InternalSearchResult));
  const topKScore = scoreOf(sorted[sorted.length - 1] ?? ({} as InternalSearchResult));

  const sources = new Map<string, number>();
  for (const result of sorted) {
    const source = sourceOf(result);
    sources.set(source, (sources.get(source) ?? 0) + 1);
  }
  const sourceDiversity = sources.size;
  const dominantSourceCount = sources.size > 0 ? Math.max(...sources.values()) : 0;
  const sourceConsensus = candidateCount > 0 ? dominantSourceCount / candidateCount : 0;

  return {
    rankingMode,
    profile,
    candidateCount,
    topScore,
    secondScore,
    top1Top2Gap: Math.max(0, topScore - secondScore),
    topKScore,
    topKSpread: Math.max(0, topScore - topKScore),
    sourceConsensus,
    sourceDiversity,
  };
}

export function evaluateRankingGate(
  results: InternalSearchResult[],
  options: { rankingMode: RetrievalRankingMode; profile: RetrievalProfile }
): RankingGateDecision {
  const signals = summarizeSignals(results, options.rankingMode, options.profile);
  const reasons: string[] = [];

  if (signals.profile === 'fast') {
    reasons.push('profile=fast');
  }
  if (signals.candidateCount < RANKING_HARD_QUERY_GATE.minCandidateCount) {
    reasons.push(`candidate_count=${signals.candidateCount} < ${RANKING_HARD_QUERY_GATE.minCandidateCount}`);
  }

  const ambiguousSignals: string[] = [];
  if (signals.top1Top2Gap <= RANKING_HARD_QUERY_GATE.maxTop1Top2Gap) {
    ambiguousSignals.push(`top1_top2_gap=${signals.top1Top2Gap.toFixed(3)}`);
  }
  if (signals.topKSpread <= RANKING_HARD_QUERY_GATE.maxTopKSpread) {
    ambiguousSignals.push(`topk_spread=${signals.topKSpread.toFixed(3)}`);
  }
  if (signals.sourceConsensus <= RANKING_HARD_QUERY_GATE.maxDominantSourceShare) {
    ambiguousSignals.push(`source_consensus=${signals.sourceConsensus.toFixed(3)}`);
  }
  if (signals.sourceDiversity >= 2) {
    ambiguousSignals.push(`source_diversity=${signals.sourceDiversity}`);
  }

  const shouldUseTransformerRerank =
    signals.profile !== 'fast' &&
    signals.candidateCount >= RANKING_HARD_QUERY_GATE.minCandidateCount &&
    ambiguousSignals.length >= RANKING_HARD_QUERY_GATE.minAmbiguousSignals;

  if (shouldUseTransformerRerank) {
    reasons.push(...ambiguousSignals.slice(0, RANKING_HARD_QUERY_GATE.minAmbiguousSignals));
  } else if (ambiguousSignals.length === 0) {
    reasons.push('query_is_not_ambiguous_enough_for_transformer_rerank');
  } else {
    reasons.push(...ambiguousSignals);
  }

  return {
    shouldUseTransformerRerank,
    reasons,
    signals,
  };
}

export function buildRankingDiagnostics(
  results: InternalSearchResult[],
  options: RankingDiagnosticsBuildOptions
): RankingDiagnostics {
  const gateDecision = options.gateDecision;
  const signals = gateDecision.signals;

  return {
    rankingMode: options.rankingMode,
    profile: options.profile,
    candidateCount: signals.candidateCount,
    topScore: signals.topScore,
    secondScore: signals.secondScore,
    top1Top2Gap: signals.top1Top2Gap,
    topKScore: signals.topKScore,
    topKSpread: signals.topKSpread,
    sourceConsensus: signals.sourceConsensus,
    sourceDiversity: signals.sourceDiversity,
    rerankPath: options.rerankPath,
    fallbackReason: options.fallbackReason ?? 'none',
    gate: gateDecision,
  };
}
