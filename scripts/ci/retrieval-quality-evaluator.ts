import {
  normalizeRetrievedPath,
  type RetrievalQualityCase,
  type RetrievalQualityJudgment,
} from './retrieval-quality-fixture.js';

export interface RetrievalEvalHit {
  rank: number;
  path: string;
  grade: number;
  relevant: boolean;
}

export interface RetrievalEvalCaseMetrics {
  p_at_1: number;
  reciprocal_rank_at_10: number;
  recall_at_10: number;
  ndcg_at_10: number;
  relevant_hit_count_at_10: number;
  first_relevant_rank: number | null;
}

export interface RetrievalEvalCaseResult {
  id: string;
  query: string;
  expected_paths: RetrievalQualityJudgment[];
  actual_paths: string[];
  hits_at_10: RetrievalEvalHit[];
  metrics: RetrievalEvalCaseMetrics;
}

export interface RetrievalEvalAggregateMetrics {
  mrr_at_10: number;
  ndcg_at_10: number;
  recall_at_10: number;
  p_at_1: number;
  case_count: number;
  judged_path_count: number;
}

function discount(rank: number): number {
  return Math.log2(rank + 1);
}

function gain(grade: number): number {
  return (2 ** grade) - 1;
}

function dcgAtK(grades: number[], k: number): number {
  return grades
    .slice(0, k)
    .reduce((sum, grade, index) => sum + (grade > 0 ? gain(grade) / discount(index + 1) : 0), 0);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of paths) {
    const normalized = normalizeRetrievedPath(entry);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

export function evaluateRetrievalCase(
  caseDef: RetrievalQualityCase,
  actualPaths: string[],
  k = 10
): RetrievalEvalCaseResult {
  const expectedPaths = [...caseDef.judgments].sort((left, right) => left.path.localeCompare(right.path));
  const judgmentMap = new Map(expectedPaths.map((entry) => [entry.path, entry.grade]));
  const dedupedActualPaths = dedupePaths(actualPaths);
  const topKPaths = dedupedActualPaths.slice(0, k);
  const gains = topKPaths.map((entry) => judgmentMap.get(entry) ?? 0);
  const hitsAt10 = topKPaths.map((entry, index) => {
    const grade = judgmentMap.get(entry) ?? 0;
    return {
      rank: index + 1,
      path: entry,
      grade,
      relevant: grade > 0,
    } satisfies RetrievalEvalHit;
  });
  const firstRelevantRank =
    hitsAt10.find((entry) => entry.relevant)?.rank ??
    null;
  const relevantHitCount = hitsAt10.filter((entry) => entry.relevant).length;
  const idealGrades = expectedPaths
    .map((entry) => entry.grade)
    .sort((left, right) => right - left);
  const idealDcg = dcgAtK(idealGrades, k);
  const ndcg = idealDcg > 0 ? dcgAtK(gains, k) / idealDcg : 0;

  return {
    id: caseDef.id,
    query: caseDef.query,
    expected_paths: expectedPaths,
    actual_paths: dedupedActualPaths,
    hits_at_10: hitsAt10,
    metrics: {
      p_at_1: hitsAt10[0]?.relevant ? 1 : 0,
      reciprocal_rank_at_10: firstRelevantRank ? 1 / firstRelevantRank : 0,
      recall_at_10: expectedPaths.length > 0 ? relevantHitCount / expectedPaths.length : 0,
      ndcg_at_10: ndcg,
      relevant_hit_count_at_10: relevantHitCount,
      first_relevant_rank: firstRelevantRank,
    },
  };
}

export function aggregateRetrievalEval(caseResults: RetrievalEvalCaseResult[]): RetrievalEvalAggregateMetrics {
  const caseCount = caseResults.length;
  const mean = (values: number[]): number =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  return {
    mrr_at_10: mean(caseResults.map((entry) => entry.metrics.reciprocal_rank_at_10)),
    ndcg_at_10: mean(caseResults.map((entry) => entry.metrics.ndcg_at_10)),
    recall_at_10: mean(caseResults.map((entry) => entry.metrics.recall_at_10)),
    p_at_1: mean(caseResults.map((entry) => entry.metrics.p_at_1)),
    case_count: caseCount,
    judged_path_count: caseResults.reduce((sum, entry) => sum + entry.expected_paths.length, 0),
  };
}

export function buildQualityMetricMap(metrics: RetrievalEvalAggregateMetrics): Record<string, number> {
  return {
    'quality.mrr_at_10': metrics.mrr_at_10,
    'quality.ndcg_at_10': metrics.ndcg_at_10,
    'quality.recall_at_10': metrics.recall_at_10,
    'quality.p_at_1': metrics.p_at_1,
  };
}
