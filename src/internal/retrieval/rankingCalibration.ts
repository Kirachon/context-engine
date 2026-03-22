import type {
  InternalSearchResult,
  RankingDiagnostics,
  RankingFallbackReason,
  RankingGateDecision,
  RankingGateSignals,
  RetrievalProfile,
  RetrievalRankingMode,
} from './types.js';

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

export const RANKING_HARD_QUERY_GATE: RankingGateThresholds = {
  minCandidateCount: 4,
  maxTop1Top2Gap: 0.08,
  maxTopKSpread: 0.22,
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
