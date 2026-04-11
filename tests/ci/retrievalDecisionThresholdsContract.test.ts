import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type DecisionThresholdsContract = {
  version: number;
  artifact_inputs: {
    baseline: string;
    candidate: string;
  };
  metrics: Record<string, { comparator: string; threshold: number; required: boolean }>;
  required_receipts: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/retrieval-decision-thresholds.json', () => {
  it('pins decision-driving retrieval thresholds and required diagnostic receipts', () => {
    const contract = readJson<DecisionThresholdsContract>('config/ci/retrieval-decision-thresholds.json');

    expect(contract.version).toBe(1);
    expect(contract.artifact_inputs).toEqual({
      baseline: 'artifacts/bench/pr-baseline.json',
      candidate: 'artifacts/bench/pr-candidate.json',
    });
    expect(contract.metrics).toEqual({
      p95_latency_ms: { comparator: 'lte_delta_pct', threshold: 20, required: true },
      blank_result_rate_pct: { comparator: 'lte_absolute', threshold: 12, required: true },
      fallback_rate_pct: { comparator: 'lte_absolute', threshold: 25, required: true },
      scope_leakage_rate_pct: { comparator: 'lte_absolute', threshold: 2, required: true },
      large_file_metadata_only_rate_pct: { comparator: 'lte_absolute', threshold: 35, required: false },
      large_file_size_skip_rate_pct: { comparator: 'lte_absolute', threshold: 20, required: false },
    });
    expect(contract.required_receipts).toEqual({
      skip_reasons: 'ContextServiceClient.IndexResult.skipReasons',
      skip_reason_total: 'ContextServiceClient.IndexResult.skipReasonTotal',
      file_outcomes: 'ContextServiceClient.IndexResult.fileOutcomes',
      file_outcome_total: 'ContextServiceClient.IndexResult.fileOutcomeTotal',
      truncation_reasons: 'ContextBundle.metadata.truncationReasons',
    });
  });
});
