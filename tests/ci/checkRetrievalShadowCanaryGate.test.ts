import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runGate(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-retrieval-shadow-canary-gate.ts');
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

describe('scripts/ci/check-retrieval-shadow-canary-gate.ts', () => {
  it('passes when quality, holdout, and telemetry thresholds are healthy', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-pass-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, { gate: { status: 'pass' }, reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) } });
    writeJson(telemetryPath, { dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 100 } });
    writeJson(holdoutPath, { gate: { status: 'pass' }, summary: { dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) } });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--out', outPath,
      '--max-skipped-docs-rate-pct', '10',
      '--max-embed-batch-p95-ms', '120',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=pass');
    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when abort threshold is exceeded', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-fail-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, { gate: { status: 'pass' } });
    writeJson(telemetryPath, { dense_refresh: { skipped_docs_rate_pct: 22, embed_batch_p95_ms: 90 } });
    writeJson(holdoutPath, { gate: { status: 'pass' }, summary: { dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) } });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--out', outPath,
      '--max-skipped-docs-rate-pct', '20',
      '--max-embed-batch-p95-ms', '120',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns usage/parsing error for invalid numeric threshold input', () => {
    const result = runGate(['--max-skipped-docs-rate-pct', 'not-a-number']);
    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Expected a finite non-negative number/i);
  });

  it('fails when reproducibility lock metadata is inconsistent across artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-mismatch-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, {
      gate: { status: 'pass' },
      reproducibility_lock: {
        commit_sha: 'commit-a',
        dataset_id: 'holdout_v1',
        dataset_hash: 'a'.repeat(64),
      },
    });
    writeJson(telemetryPath, {
      dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 80 },
      reproducibility_lock: {
        commit_sha: 'commit-b',
        dataset_id: 'holdout_v2',
        dataset_hash: 'b'.repeat(64),
      },
    });
    writeJson(holdoutPath, {
      gate: { status: 'pass' },
      summary: { dataset_id: 'holdout_v1', dataset_hash: 'a'.repeat(64) },
    });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--out', outPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((line) => line.includes('reproducibility mismatch: commit_sha'))).toBe(true);
    expect(reasons.some((line) => line.includes('reproducibility mismatch: dataset_id'))).toBe(true);
    expect(reasons.some((line) => line.includes('reproducibility mismatch: dataset_hash'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
