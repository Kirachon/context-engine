import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-retrieval-quality-gate.ts');
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

describe('scripts/ci/check-retrieval-quality-gate.ts', () => {
  it('passes for a passing report', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-gate-pass-'));
    const reportPath = path.join(tmp, 'report.json');
    const outPath = path.join(tmp, 'gate.json');

    writeJson(reportPath, {
      evaluations: [
        { id: 'quality.ndcg_at_10', status: 'pass' },
        { id: 'quality.mrr_at_10', status: 'pass' },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['quality.ndcg_at_10', 'quality.mrr_at_10'],
      },
      gate: {
        status: 'pass',
        reasons: [],
      },
    });

    const result = runChecker(['--report', reportPath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=pass');
    expect(fs.existsSync(outPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when required metrics are missing or failed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-gate-fail-'));
    const reportPath = path.join(tmp, 'report.json');
    const outPath = path.join(tmp, 'gate.json');

    writeJson(reportPath, {
      evaluations: [
        { id: 'quality.ndcg_at_10', status: 'pass' },
        { id: 'quality.mrr_at_10', status: 'fail' },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['quality.ndcg_at_10', 'quality.mrr_at_10', 'quality.recall_at_50'],
      },
      gate: {
        status: 'fail',
        reasons: ['required metric not pass: quality.mrr_at_10 (fail)'],
      },
    });

    const result = runChecker(['--report', reportPath, '--out', outPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('fail');
    const reasons = gate.reasons as string[];
    expect(reasons.some((line) => line.includes('quality.recall_at_50'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
