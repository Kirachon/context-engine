/**
 * Q3b — Required-lane catch-rate evaluator tests.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  buildCatchRateReport,
  computeCatchRateMetrics,
  createDefaultDetectors,
  evaluateCase,
  type CaseEvaluation,
  type CategoryDetector,
  type SeededFailureCase,
} from '../../scripts/ci/lib/requiredLaneCatchRate.js';

const REPO_ROOT = process.cwd();

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'required-lane-catch-rate.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('required-lane catch-rate evaluator (Q3b)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('computes catch_rate_pct rather than printing a hardcoded 95%', () => {
    const cases: CaseEvaluation[] = [
      {
        id: 'a',
        failure_category: 'cancellation-regression',
        expected_outcome: 'should_catch',
        verdict: 'caught',
        detail: 'ok',
        matched_expectation: true,
      },
      {
        id: 'b',
        failure_category: 'cache-identity-regression',
        expected_outcome: 'should_catch',
        verdict: 'caught',
        detail: 'ok',
        matched_expectation: true,
      },
      {
        id: 'c',
        failure_category: 'graph-scope-regression',
        expected_outcome: 'should_catch',
        verdict: 'missed',
        detail: 'miss',
        matched_expectation: false,
      },
      {
        id: 'd',
        failure_category: 'none',
        expected_outcome: 'should_pass',
        verdict: 'passed',
        detail: 'ok',
        matched_expectation: true,
      },
    ];
    const metrics = computeCatchRateMetrics(cases);
    expect(metrics.catch_rate_pct).toBeCloseTo((2 / 3) * 100, 4);
    expect(metrics.catch_rate_pct).not.toBe(95);
  });

  it('seeded pass/fail corpus proves default evaluator catches approved failures', () => {
    const report = buildCatchRateReport({
      repoRoot: REPO_ROOT,
      commitSha: 'test-commit',
      nowIso: '2026-07-14T00:00:00.000Z',
    });

    expect(report.threshold_min_catch_rate_pct).toBe(95);
    expect(report.metrics.should_catch_total).toBe(3);
    expect(report.metrics.caught).toBe(3);
    expect(report.metrics.missed).toBe(0);
    expect(report.metrics.catch_rate_pct).toBe(100);
    expect(report.metrics.false_positives).toBe(0);
    expect(report.gate.status).toBe('pass');
    expect(report.corpus_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.commit_sha).toBe('test-commit');
    expect(report.cases.every((c) => c.matched_expectation)).toBe(true);
  });

  it('fails when an approved should_catch detector misses', () => {
    const detectors = createDefaultDetectors();
    detectors['cancellation-regression'] = () => ({
      ok: false,
      detail: 'injected miss',
    });

    const report = buildCatchRateReport({
      repoRoot: REPO_ROOT,
      detectors,
      commitSha: 'test-commit',
    });

    expect(report.metrics.missed).toBe(1);
    expect(report.metrics.catch_rate_pct).toBeCloseTo((2 / 3) * 100, 4);
    expect(report.gate.status).toBe('fail');
    expect(report.gate.reasons.some((r) => r.includes('catch_rate_pct'))).toBe(true);
  });

  it('fails closed when evaluator detector for a category is missing', () => {
    const caseDef: SeededFailureCase = {
      id: 'seed-fail-provider-timeout',
      query: 'x',
      language: 'typescript',
      labels: ['regression-seed'],
      intended_lane: 'seeded_failure',
      expected_outcome: 'should_catch',
      failure_category: 'cancellation-regression',
    };
    const emptyDetectors: Record<string, CategoryDetector> = {};
    expect(() => evaluateCase(caseDef, REPO_ROOT, emptyDetectors)).toThrow(/Missing evaluator detector/);
  });

  it('CLI writes provenance-valid report and passes on live seeded corpus', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-catch-rate-'));
    const outPath = path.join(tmpDir, 'report.json');
    const result = runCli(['--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('required_lane_catch_rate_passed');
    expect(result.stdout).not.toMatch(/TODO/);

    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(report.schema_version).toBe(1);
    expect(report.lane).toBe('seeded_failure');
    expect(report.threshold_min_catch_rate_pct).toBe(95);
    expect(report.metrics.catch_rate_pct).toBeGreaterThanOrEqual(95);
    expect(report.commit_sha).toEqual(expect.any(String));
    expect(report.corpus_sha256).toEqual(expect.any(String));
    expect(report.gate.status).toBe('pass');
  });

  it('CLI fails when corpus contract is missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-catch-rate-missing-'));
    const missingContract = path.join(tmpDir, 'missing-contract.json');
    const outPath = path.join(tmpDir, 'report.json');
    const result = runCli(['--contract', missingContract, '--out', outPath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not found|Missing/i);
  });
});
