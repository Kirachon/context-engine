import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runGenerator(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'generate-retrieval-quality-report.ts');
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

describe('scripts/ci/generate-retrieval-quality-report.ts', () => {
  it('creates a pass report from a passing fixture pack', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-pass-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(fixturePath, {
      checks: [
        { id: 'quality.ndcg_at_10', kind: 'delta_pct_min', baseline: 0.5, candidate: 0.56, min_delta_pct: 10 },
        { id: 'latency.fast.p95_ms', kind: 'threshold_max', value: 340, max: 350 },
        { id: 'resource.rss_growth_pct', kind: 'threshold_max', value: 20, max: 25 },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['quality.ndcg_at_10', 'latency.fast.p95_ms'],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');
    expect(fs.existsSync(outPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a fail report when required metrics fail', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-fail-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(fixturePath, {
      checks: [
        { id: 'quality.mrr_at_10', kind: 'delta_pct_min', baseline: 0.4, candidate: 0.41, min_delta_pct: 10 },
        { id: 'latency.fast.p95_ms', kind: 'threshold_max', value: 370, max: 350 },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['quality.mrr_at_10', 'latency.fast.p95_ms'],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('fail');
    const reasons = gate.reasons as string[];
    expect(reasons.length).toBeGreaterThan(0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports json_path telemetry threshold checks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-telemetry-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(telemetryPath, {
      dense_refresh: {
        skipped_docs_rate_pct: 4.5,
        embed_batch_p95_ms: 80,
      },
    });

    writeJson(fixturePath, {
      checks: [
        {
          id: 'telemetry.skipped_docs_rate_pct',
          kind: 'json_path_threshold_max',
          path: telemetryPath,
          json_path: 'dense_refresh.skipped_docs_rate_pct',
          max: 10,
          missing_status: 'fail',
        },
        {
          id: 'telemetry.embed_batch_p95_ms',
          kind: 'json_path_threshold_max',
          path: telemetryPath,
          json_path: 'dense_refresh.embed_batch_p95_ms',
          max: 120,
          missing_status: 'fail',
        },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['telemetry.skipped_docs_rate_pct', 'telemetry.embed_batch_p95_ms'],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = artifact.evaluations as Array<Record<string, unknown>>;
    const statuses = evaluations.map((item) => item.status);
    expect(statuses).toEqual(['pass', 'pass']);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marks missing json_path values as skip when missing_status is omitted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-missing-skip-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(fixturePath, {
      checks: [
        {
          id: 'telemetry.missing',
          kind: 'json_path_threshold_min',
          path: path.join(tmp, 'does-not-exist.json'),
          json_path: 'dense_refresh.hit_rate',
          min: 0.8,
        },
      ],
      gate_rules: {
        min_pass_rate: 0,
        required_ids: [],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = artifact.evaluations as Array<Record<string, unknown>>;
    expect(evaluations[0]?.status).toBe('skip');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marks delta_pct_min as skip when baseline is zero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-delta-skip-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(fixturePath, {
      checks: [
        { id: 'quality.ndcg_at_10', kind: 'delta_pct_min', baseline: 0, candidate: 0.1, min_delta_pct: 5 },
      ],
      gate_rules: {
        min_pass_rate: 0,
        required_ids: [],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = artifact.evaluations as Array<Record<string, unknown>>;
    expect(evaluations[0]?.status).toBe('skip');
    expect(String(evaluations[0]?.message ?? '')).toMatch(/baseline must be > 0/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
