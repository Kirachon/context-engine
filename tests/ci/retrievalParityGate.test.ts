import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runParityGate(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'retrieval-parity-gate.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function makeBenchFixture(p95: number, commitSha: string): Record<string, unknown> {
  return {
    payload: {
      mode: 'search',
      timing: {
        p95_ms: p95,
      },
    },
    provenance: {
      commit_sha: commitSha,
      bench_mode: 'search',
      dataset_id: 'dataset-v1',
      node_version: 'v22.0.0',
      env_fingerprint: 'env-stable',
    },
  };
}

describe('scripts/ci/retrieval-parity-gate.ts', () => {
  it('generates artifact and passes when bench deltas are within thresholds', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-parity-pass-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const outPath = path.join(tmp, 'parity.json');

    writeJson(baselinePath, makeBenchFixture(100, '1111111'));
    writeJson(candidatePath, makeBenchFixture(110, '2222222'));

    const result = runParityGate([
      '--bench-baseline', baselinePath,
      '--bench-candidate', candidatePath,
      '--thresholds', path.join(process.cwd(), 'config', 'ci', 'retrieval-parity-thresholds.json'),
      '--out', outPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');
    expect(fs.existsSync(outPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when bench p95 regression breaches threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-parity-fail-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const outPath = path.join(tmp, 'parity.json');

    writeJson(baselinePath, makeBenchFixture(100, '1111111'));
    writeJson(candidatePath, makeBenchFixture(170, '2222222'));

    const result = runParityGate([
      '--bench-baseline', baselinePath,
      '--bench-candidate', candidatePath,
      '--thresholds', path.join(process.cwd(), 'config', 'ci', 'retrieval-parity-thresholds.json'),
      '--out', outPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL bench.perf.p95_regression_pct');
    expect(result.stderr).toContain('Retrieval parity gate failed');
    expect(fs.existsSync(outPath)).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports artifact-only dry mode with --no-gate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-parity-dry-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const outPath = path.join(tmp, 'parity.json');

    writeJson(baselinePath, makeBenchFixture(100, '1111111'));
    writeJson(candidatePath, makeBenchFixture(500, '2222222'));

    const result = runParityGate([
      '--bench-baseline', baselinePath,
      '--bench-candidate', candidatePath,
      '--thresholds', path.join(process.cwd(), 'config', 'ci', 'retrieval-parity-thresholds.json'),
      '--out', outPath,
      '--no-gate',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_enabled=false');
    expect(result.stdout).toContain('gate_status=pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

