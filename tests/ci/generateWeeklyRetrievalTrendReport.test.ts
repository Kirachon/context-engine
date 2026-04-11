import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runGenerator(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'generate-weekly-retrieval-trend-report.ts');
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

describe('scripts/ci/generate-weekly-retrieval-trend-report.ts', () => {
  it('generates a PASS artifact and archives it for a provided period key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-weekly-trend-pass-'));
    const parityPath = path.join(tmp, 'parity.json');
    const qualityPath = path.join(tmp, 'quality.json');
    const outPath = path.join(tmp, 'weekly.json');
    const archiveDir = path.join(tmp, 'archive');

    writeJson(parityPath, { overall_score: 96.4 });
    writeJson(qualityPath, {
      summary: { pass_rate: 1 },
      evaluations: [
        { id: 'quality.ndcg_at_10', value: 14 },
        { id: 'quality.mrr_at_10', value: 12.5 },
        { id: 'quality.recall_at_10', value: 22 },
      ],
    });

    const result = runGenerator([
      '--parity', parityPath,
      '--quality', qualityPath,
      '--out', outPath,
      '--archive-dir', archiveDir,
      '--retention-weeks', '4',
      '--period-key', '2026-W11',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('r4_weekly_trend generated');
    expect(result.stdout).toContain('status=PASS');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, any>;
    expect(artifact.status).toBe('PASS');
    expect(artifact.period?.key).toBe('2026-W11');
    expect(fs.existsSync(path.join(archiveDir, 'r4-weekly-trend-2026-W11.json'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns duplicate_identical_inputs when rerun for same period with same inputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-weekly-trend-dup-'));
    const parityPath = path.join(tmp, 'parity.json');
    const qualityPath = path.join(tmp, 'quality.json');
    const outPath = path.join(tmp, 'weekly.json');
    const archiveDir = path.join(tmp, 'archive');

    writeJson(parityPath, { overall_score: 90 });
    writeJson(qualityPath, {
      summary: { pass_rate: 1 },
      evaluations: [
        { id: 'quality.ndcg_at_10', value: 10 },
        { id: 'quality.mrr_at_10', value: 9 },
        { id: 'quality.recall_at_10', value: 8 },
      ],
    });

    const first = runGenerator([
      '--parity', parityPath,
      '--quality', qualityPath,
      '--out', outPath,
      '--archive-dir', archiveDir,
      '--period-key', '2026-W12',
    ]);
    expect(first.status).toBe(0);

    const second = runGenerator([
      '--parity', parityPath,
      '--quality', qualityPath,
      '--out', outPath,
      '--archive-dir', archiveDir,
      '--period-key', '2026-W12',
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('duplicate_identical_inputs');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
