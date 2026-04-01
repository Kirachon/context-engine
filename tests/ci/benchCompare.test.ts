import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

type BenchFixture = {
  total_ms?: number;
  payload: {
    mode: string;
    timing: {
      p95_ms: number;
    };
  };
  provenance: {
    timestamp_utc?: string;
    commit_sha?: string;
    branch_or_tag?: string;
    workspace_fingerprint?: string;
    index_fingerprint?: string;
    bench_mode?: string;
    dataset_id?: string;
    dataset_hash?: string;
    retrieval_provider?: string;
    feature_flags_snapshot?: string;
    node_version?: string;
    os_version?: string;
    env_fingerprint?: string;
  };
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function runBenchCompare(args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'bench-compare.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function makeFixture(p95: number, commitSha: string): BenchFixture {
  return {
    payload: {
      mode: 'search',
      timing: {
        p95_ms: p95,
      },
    },
    provenance: {
      timestamp_utc: '2026-03-21T00:00:00.000Z',
      commit_sha: commitSha,
      branch_or_tag: 'main',
      workspace_fingerprint: 'workspace-fingerprint-1',
      index_fingerprint: 'fingerprint-index-1',
      bench_mode: 'search',
      dataset_id: 'dataset-v1',
      dataset_hash: 'dataset-hash-1',
      retrieval_provider: 'local_native',
      feature_flags_snapshot: '{"metrics":true}',
      node_version: 'v22.0.0',
      os_version: 'Linux 6.8.0 (x64)',
      env_fingerprint: 'env-stable',
    },
  };
}

describe('scripts/ci/bench-compare.ts', () => {
  it('passes when provenance is valid and regression is within thresholds', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-compare-pass-'));
    const baselinePath = path.join(tmp, 'bench-baseline.json');
    const candidatePath = path.join(tmp, 'bench-candidate.json');

    writeJson(baselinePath, makeFixture(100, '1111111'));
    writeJson(candidatePath, makeFixture(108, '2222222'));

    const result = runBenchCompare([
      '--baseline', baselinePath,
      '--candidate', candidatePath,
      '--metric', 'payload.timing.p95_ms',
      '--max-regression-pct', '10',
      '--max-regression-abs', '25',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Benchmark comparison passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails with usage/parsing error when required provenance fields are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-compare-provenance-'));
    const baselinePath = path.join(tmp, 'bench-baseline.json');
    const candidatePath = path.join(tmp, 'bench-candidate.json');

    const baseline = makeFixture(100, '1111111');
    const candidate = makeFixture(101, '2222222');
    delete candidate.provenance.dataset_id;

    writeJson(baselinePath, baseline);
    writeJson(candidatePath, candidate);

    const result = runBenchCompare([
      '--baseline', baselinePath,
      '--candidate', candidatePath,
      '--metric', 'payload.timing.p95_ms',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Missing required provenance field "dataset_id" in candidate artifact.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when workspace fingerprint or feature-flag snapshot is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-compare-fingerprint-'));
    const baselinePath = path.join(tmp, 'bench-baseline.json');
    const candidatePath = path.join(tmp, 'bench-candidate.json');

    const baseline = makeFixture(100, '1111111');
    const candidate = makeFixture(101, '2222222');
    delete candidate.provenance.workspace_fingerprint;

    writeJson(baselinePath, baseline);
    writeJson(candidatePath, candidate);

    const result = runBenchCompare([
      '--baseline', baselinePath,
      '--candidate', candidatePath,
      '--metric', 'payload.timing.p95_ms',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Missing required provenance field "workspace_fingerprint" in candidate artifact.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails in CI mode when baseline and candidate commit_sha are identical', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-compare-ci-'));
    const baselinePath = path.join(tmp, 'bench-baseline.json');
    const candidatePath = path.join(tmp, 'bench-candidate.json');

    writeJson(baselinePath, makeFixture(100, 'same-sha'));
    writeJson(candidatePath, makeFixture(102, 'same-sha'));

    const result = runBenchCompare(
      [
        '--baseline', baselinePath,
        '--candidate', candidatePath,
        '--metric', 'payload.timing.p95_ms',
      ],
      { CI: 'true' }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid baseline: baseline and candidate commit_sha must differ in CI mode.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('allows identical commit_sha in CI mode for nightly suite comparisons', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-compare-nightly-'));
    const baselinePath = path.join(tmp, 'bench-baseline.json');
    const candidatePath = path.join(tmp, 'bench-candidate.json');

    writeJson(baselinePath, makeFixture(100, 'same-sha'));
    writeJson(candidatePath, makeFixture(102, 'same-sha'));

    const result = runBenchCompare(
      [
        '--baseline', baselinePath,
        '--candidate', candidatePath,
        '--metric', 'payload.timing.p95_ms',
        '--suite-mode', 'nightly',
      ],
      { CI: 'true' }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Benchmark comparison passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
