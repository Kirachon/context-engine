import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type RetrievalCalibrationContract = {
  version: string;
  frozen_contracts: Record<string, string>;
  artifacts: Record<string, string>;
  quality_gate_perf_profile: string;
  measurable_metrics: {
    compare_metric_path: string;
    quality_ids: string[];
    diagnostic_ids: string[];
  };
  diagnostic_receipts: {
    skip_reasons: string;
    truncation_reasons: string;
  };
  runtime_change_policy: {
    allow_default_profile_changes: boolean;
    allow_large_file_behavior_changes: boolean;
  };
  validation: {
    scripts: string[];
    tests: string[];
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/retrieval-calibration-contract.json', () => {
  it('pins calibration receipts to the frozen benchmark contract and existing diagnostics surfaces', () => {
    const contract = readJson<RetrievalCalibrationContract>('config/ci/retrieval-calibration-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const scripts = packageJson.scripts ?? {};

    expect(contract.version).toBeTruthy();
    expect(contract.frozen_contracts).toEqual({
      benchmark_eval: 'config/ci/benchmark-eval-contract.json',
      gate_tiers: 'config/ci/gate-tier-contract.json',
      decision_thresholds: 'config/ci/retrieval-decision-thresholds.json',
      rollback_evidence: 'config/ci/retrieval-rollback-evidence-contract.json',
    });
    expect(contract.artifacts).toEqual({
      baseline: 'artifacts/bench/pr-baseline.json',
      candidate: 'artifacts/bench/pr-candidate.json',
      holdout_check: 'artifacts/bench/retrieval-holdout-check.json',
      quality_report: 'artifacts/bench/retrieval-quality-report.json',
      quality_telemetry: 'artifacts/bench/retrieval-quality-telemetry.json',
      shadow_canary_gate: 'artifacts/bench/retrieval-shadow-canary-gate.json',
    });
    expect(contract.quality_gate_perf_profile).toBe('quality');
    expect(contract.measurable_metrics.compare_metric_path).toBe('payload.timing.p95_ms');
    expect(contract.measurable_metrics.quality_ids).toEqual([
      'quality.ndcg_at_10',
      'quality.mrr_at_10',
      'quality.recall_at_10',
      'quality.p_at_1',
    ]);
    expect(contract.measurable_metrics.diagnostic_ids).toEqual([
      'telemetry.skipped_docs_rate_pct',
      'telemetry.embed_batch_p95_ms',
    ]);
    expect(contract.diagnostic_receipts).toEqual({
      skip_reasons: 'ContextServiceClient.IndexResult.skipReasons',
      skip_reason_total: 'ContextServiceClient.IndexResult.skipReasonTotal',
      file_outcomes: 'ContextServiceClient.IndexResult.fileOutcomes',
      file_outcome_total: 'ContextServiceClient.IndexResult.fileOutcomeTotal',
      truncation_reasons: 'ContextBundle.metadata.truncationReasons',
      memory_candidate_count: 'ContextBundle.metadata.memoryCandidates',
    });
    expect(contract.runtime_change_policy).toEqual({
      allow_default_profile_changes: false,
      allow_large_file_behavior_changes: false,
    });

    for (const filePath of Object.values(contract.frozen_contracts)) {
      expect(fs.existsSync(path.join(process.cwd(), filePath))).toBe(true);
    }
    for (const scriptName of contract.validation.scripts) {
      expect(scripts[scriptName]).toEqual(expect.any(String));
    }
    for (const testPath of contract.validation.tests) {
      expect(fs.existsSync(path.join(process.cwd(), testPath))).toBe(true);
    }
  });
});
