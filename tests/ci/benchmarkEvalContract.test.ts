import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type BenchmarkEvalContract = {
  version: string;
  baseline: {
    required_provider: string;
    index_requirement: string;
    baseline_artifact: string;
    candidate_artifact: string;
    cache_modes: string[];
    scoped_runs: string[];
  };
  profiles: Record<string, { token_budget: number }>;
  workload_packs: Record<string, string>;
  calibration_contract: string;
  gate_tiers: {
    pr_blockers: string[];
    nightly_report_only: string[];
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/benchmark-eval-contract.json', () => {
  it('freezes the benchmark and eval contract using existing repo scripts and artifacts', () => {
    const contract = readJson<BenchmarkEvalContract>('config/ci/benchmark-eval-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const scripts = packageJson.scripts ?? {};

    expect(contract.version).toBeTruthy();
    expect(contract.baseline).toEqual(
      expect.objectContaining({
        required_provider: 'local_native',
        index_requirement: 'healthy',
        baseline_artifact: 'artifacts/bench/pr-baseline.json',
        candidate_artifact: 'artifacts/bench/pr-candidate.json',
        cache_modes: ['cold', 'warm'],
        scoped_runs: ['unscoped', 'scoped'],
      })
    );

    expect(contract.profiles).toEqual(
      expect.objectContaining({
        fast: expect.objectContaining({ token_budget: expect.any(Number) }),
        balanced: expect.objectContaining({ token_budget: expect.any(Number) }),
        rich: expect.objectContaining({ token_budget: expect.any(Number) }),
      })
    );

    expect(contract.workload_packs).toEqual(
      expect.objectContaining({
        retrieval_quality_fixture_pack: 'config/ci/retrieval-quality-fixture-pack.json',
        legacy_capability_matrix: 'config/ci/legacy-capability-matrix.json',
      })
    );
    expect(contract.calibration_contract).toBe('config/ci/retrieval-calibration-contract.json');

    expect(contract.gate_tiers.pr_blockers).toEqual(
      expect.arrayContaining([
        'build',
        'ci:check:mcp-smoke',
        'ci:check:retrieval-holdout-fixture',
        'ci:check:retrieval-quality-gate',
        'ci:check:retrieval-shadow-canary-gate',
        'ci:check:enhancement-error-taxonomy-report',
        'ci:check:enhance-prompt-contract',
      ])
    );

    expect(contract.gate_tiers.nightly_report_only).toEqual(
      expect.arrayContaining([
        'bench:ci:nightly',
        'ci:generate:weekly-retrieval-trend-report',
        'ci:check:weekly-retrieval-trend-report',
        'ci:generate:semantic-latency-report',
      ])
    );

    for (const scriptName of [
      ...contract.gate_tiers.pr_blockers,
      ...contract.gate_tiers.nightly_report_only,
    ]) {
      expect(scripts[scriptName]).toBeTruthy();
    }

    for (const filePath of Object.values(contract.workload_packs)) {
      expect(fs.existsSync(path.join(process.cwd(), filePath))).toBe(true);
    }
    expect(fs.existsSync(path.join(process.cwd(), contract.calibration_contract))).toBe(true);
  });
});
