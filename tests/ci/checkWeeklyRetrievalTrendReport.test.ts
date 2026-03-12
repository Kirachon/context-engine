import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function currentIsoWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function baseArtifact(periodKey: string): Record<string, unknown> {
  return {
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    status: 'PASS',
    period: {
      key: periodKey,
      start_utc: new Date(Date.now() - 3600_000).toISOString(),
      end_utc_exclusive: new Date(Date.now() + 3600_000).toISOString(),
    },
    summary: {
      headline: 'R4 weekly retrieval trend',
      pass_checks: 6,
      fail_checks: 0,
      retention_archive_note: 'retention note',
    },
    metrics: {
      strict_parity_score: 95,
      quality_pass_rate: 1,
      ndcg_delta_pct: 14,
      mrr_delta_pct: 12.5,
      recall_delta_pct: 22,
    },
    checks: [
      { id: 'metric.strict_parity_score', status: 'PASS', source: 'a', message: 'ok' },
      { id: 'metric.quality_pass_rate', status: 'PASS', source: 'b', message: 'ok' },
      { id: 'metric.ndcg_delta_pct', status: 'PASS', source: 'b', message: 'ok' },
      { id: 'metric.mrr_delta_pct', status: 'PASS', source: 'b', message: 'ok' },
      { id: 'metric.recall_delta_pct', status: 'PASS', source: 'b', message: 'ok' },
      { id: 'archive.duplicate_period', status: 'PASS', source: 'archive', message: 'ok' },
    ],
    retention: {
      policy: 'rolling_12_weeks',
      retained_period_count: 1,
      retention_archive_note: 'retention note',
    },
    inputs: {
      parity_artifact_path: 'artifacts/bench/auggie-capability-parity-gate.json',
      quality_artifact_path: 'artifacts/bench/retrieval-quality-report.json',
      parity_artifact_sha256: 'a'.repeat(64),
      quality_artifact_sha256: 'b'.repeat(64),
      out_path: 'artifacts/bench/r4-weekly-trend.json',
      archive_dir: 'artifacts/bench/archive/r4-weekly',
    },
  };
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-weekly-retrieval-trend-report.ts');
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

describe('scripts/ci/check-weekly-retrieval-trend-report.ts', () => {
  it('passes for a valid current-period artifact with exactly one archived entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-weekly-check-pass-'));
    const artifactPath = path.join(tmp, 'weekly.json');
    const archiveDir = path.join(tmp, 'archive');
    const periodKey = currentIsoWeekKey(new Date());

    writeJson(artifactPath, baseArtifact(periodKey));
    writeJson(path.join(archiveDir, `r4-weekly-trend-${periodKey}.json`), baseArtifact(periodKey));

    const result = runChecker(['--artifact', artifactPath, '--archive-dir', archiveDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('r4_weekly_trend_check PASS');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when duplicate archived artifacts exist for the same period', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-weekly-check-dup-'));
    const artifactPath = path.join(tmp, 'weekly.json');
    const archiveDir = path.join(tmp, 'archive');
    const periodKey = currentIsoWeekKey(new Date());

    writeJson(artifactPath, baseArtifact(periodKey));
    writeJson(path.join(archiveDir, `r4-weekly-trend-${periodKey}-a.json`), baseArtifact(periodKey));
    writeJson(path.join(archiveDir, `r4-weekly-trend-${periodKey}-b.json`), baseArtifact(periodKey));

    const result = runChecker(['--artifact', artifactPath, '--archive-dir', archiveDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DUPLICATE_PERIOD');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
