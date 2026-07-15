import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import {
  buildCoverageEvidence,
  collectLiveCoverageState,
  computeConfigHash,
  computeFileSha256,
  CoverageEvidenceError,
  type CoverageThresholdContract,
  readCoverageThresholdContract,
  readCoverageSummaryTotals,
  readJson,
  thresholdViolations,
  validateCoverageEvidence,
} from '../../scripts/ci/lib/coverageEvidence';

type Workflow = {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }> }>;
};

function readWorkflow(relativePath: string): Workflow {
  return parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as Workflow;
}

describe('config/ci/coverage-threshold-contract.json', () => {
  const contract = readCoverageThresholdContract();

  it('declares thresholds, report paths, and evidence path', () => {
    expect(contract.version).toBe(1);
    expect(contract.thresholds).toEqual({ global: { branches: 70, functions: 75, lines: 75 } });
    expect(contract.lcov_path).toBe('coverage/lcov.info');
    expect(contract.summary_path).toBe('coverage/coverage-summary.json');
    expect(contract.evidence_path).toBe('artifacts/ci/coverage-evidence.json');
  });

  it('is reconciled with the live test.yml quality-gates job so thresholds cannot silently drift', () => {
    const workflow = readWorkflow('.github/workflows/test.yml');
    const job = workflow.jobs?.['quality-gates'];
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];

    const generateStep = steps.find((step) => step.name === 'Coverage threshold check');
    expect(generateStep).toBeDefined();
    const match = generateStep?.run?.match(/--coverageThreshold='([^']+)'/);
    expect(match).not.toBeNull();
    const inlineThreshold = JSON.parse(match?.[1] ?? '{}') as unknown;
    expect(inlineThreshold).toEqual(contract.thresholds);

    const evidenceStep = steps.find((step) => step.name === 'Generate coverage evidence');
    expect(evidenceStep?.run).toContain('ci:generate:coverage-evidence');

    const verifyStep = steps.find((step) => step.name === 'Verify coverage evidence provenance');
    expect(verifyStep?.run).toContain('ci:check:coverage-evidence');

    const uploadStep = steps.find((step) => step.name === 'Upload coverage');
    expect(uploadStep?.uses).toMatch(/^codecov\/codecov-action@/);
    expect(uploadStep?.with?.files).toBe(`./${contract.lcov_path}`);

    // Generation, verification, and upload all happen in the same job, after the
    // Jest coverage run and in this order, so nothing uploads a stale/different report.
    const names = steps.map((step) => step.name);
    const generateIndex = names.indexOf('Coverage threshold check');
    const evidenceIndex = names.indexOf('Generate coverage evidence');
    const verifyIndex = names.indexOf('Verify coverage evidence provenance');
    const uploadIndex = names.indexOf('Upload coverage');
    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(evidenceIndex).toBeGreaterThan(generateIndex);
    expect(verifyIndex).toBeGreaterThan(evidenceIndex);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
  });

  it('never uploads coverage from the per-node test matrix job', () => {
    const workflow = readWorkflow('.github/workflows/test.yml');
    const testJobSteps = workflow.jobs?.test?.steps ?? [];
    expect(testJobSteps.some((step) => step.uses?.startsWith('codecov/'))).toBe(false);
  });

  it('is only reachable through the checked-in npm scripts', () => {
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const scripts = packageJson.scripts ?? {};
    expect(scripts['ci:generate:coverage-evidence']).toBe('node --import tsx scripts/ci/generate-coverage-evidence.ts');
    expect(scripts['ci:check:coverage-evidence']).toBe('node --import tsx scripts/ci/check-coverage-evidence.ts');
  });
});

describe('scripts/ci/lib/coverageEvidence', () => {
  function makeContract(overrides: Partial<CoverageThresholdContract> = {}): CoverageThresholdContract {
    return {
      version: 1,
      thresholds: { global: { branches: 70, functions: 75, lines: 75 } },
      lcov_path: 'does-not-exist/lcov.info',
      summary_path: 'does-not-exist/coverage-summary.json',
      evidence_path: 'does-not-exist/coverage-evidence.json',
      ...overrides,
    };
  }

  it('computes a stable, key-order-independent config hash', () => {
    const a = computeConfigHash({ global: { branches: 70, functions: 75, lines: 75 } });
    const b = computeConfigHash({ global: { lines: 75, branches: 70, functions: 75 } });
    const c = computeConfigHash({ global: { branches: 71, functions: 75, lines: 75 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports threshold violations for below-threshold or missing metrics', () => {
    const thresholds = { global: { branches: 70, functions: 75, lines: 75 } };
    expect(thresholdViolations(thresholds, { branches: 80, functions: 80, lines: 80 })).toEqual([]);
    const violations = thresholdViolations(thresholds, { branches: 60, functions: 80 });
    expect(violations).toContain('coverage metric "branches" is 60% which is below the required 70%');
    expect(violations).toContain('coverage summary is missing metric "lines" required by the threshold contract');
  });

  it('collectLiveCoverageState fails closed when the LCOV report is missing', () => {
    const contract = makeContract();
    expect(() => collectLiveCoverageState(contract)).toThrow(CoverageEvidenceError);
    expect(() => collectLiveCoverageState(contract)).toThrow(/Missing LCOV report/);
  });

  it('validateCoverageEvidence accepts a truthful envelope and rejects mismatched provenance', () => {
    const contract = makeContract();
    const live = { lcovSha256: 'abc123', actual: { branches: 80, functions: 80, lines: 80 } };
    const evidence = buildCoverageEvidence({
      contract,
      live,
      commitSha: 'deadbeef',
      workflow: 'Test Suite',
      job: 'quality-gates',
      runId: '42',
    });

    expect(validateCoverageEvidence(evidence, contract, live, 'deadbeef')).toEqual([]);

    // Stale LCOV content (report regenerated without re-running evidence generation).
    const staleLcov = validateCoverageEvidence(evidence, contract, { ...live, lcovSha256: 'different' }, 'deadbeef');
    expect(staleLcov).toContain(
      'coverage evidence provenance mismatch: LCOV report content changed after evidence generation; regenerate coverage evidence in this job before upload'
    );

    // Threshold contract edited after evidence was generated.
    const driftedContract = makeContract({ thresholds: { global: { branches: 90, functions: 75, lines: 75 } } });
    const mismatchedConfig = validateCoverageEvidence(evidence, driftedContract, live, 'deadbeef');
    expect(mismatchedConfig).toContain(
      'coverage evidence provenance mismatch: config_hash does not match the checked-in coverage-threshold-contract.json'
    );
    expect(mismatchedConfig).toContain(
      'coverage evidence provenance mismatch: recorded thresholds do not match the checked-in contract'
    );

    // Evidence was produced for a different commit than the one currently checked out.
    const wrongCommit = validateCoverageEvidence(evidence, contract, live, 'other-commit-sha');
    expect(wrongCommit).toContain(
      'coverage evidence provenance mismatch: recorded commit_sha (deadbeef) does not match the current checkout (other-commit-sha)'
    );

    // Live coverage regressed below the declared threshold since evidence was built.
    const regressed = validateCoverageEvidence(
      evidence,
      contract,
      { ...live, actual: { branches: 40, functions: 80, lines: 80 } },
      'deadbeef'
    );
    expect(regressed.some((message) => message.includes('coverage totals do not match'))).toBe(true);
    expect(regressed.some((message) => message.includes('is 40% which is below the required 70%'))).toBe(true);
  });

  it('flags a missing commit SHA as unverifiable provenance', () => {
    const contract = makeContract();
    const live = { lcovSha256: 'abc123', actual: { branches: 80, functions: 80, lines: 80 } };
    const evidence = buildCoverageEvidence({ contract, live, commitSha: 'unknown' });
    expect(validateCoverageEvidence(evidence, contract, live)).toContain(
      'coverage evidence provenance mismatch: commit_sha is missing or unknown'
    );
  });
});

describe('readCoverageSummaryTotals / computeFileSha256', () => {
  it('re-exports fs-backed helpers used by both CLI scripts', () => {
    expect(typeof readCoverageSummaryTotals).toBe('function');
    expect(typeof computeFileSha256).toBe('function');
  });
});
