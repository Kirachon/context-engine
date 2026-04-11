import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
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

  it('surfaces calibration metadata when the fixture pack includes it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-calibration-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    const calibration = {
      approved_baseline_report_path: 'artifacts/bench/retrieval-quality-report.json',
      tuning_dataset_id: 'train_v1',
      holdout_dataset_id: 'holdout_v1',
      weight_snapshot: {
        ranking_mode: 'v3',
        semantic_weight: 0.7,
        lexical_weight: 0.3,
        dense_weight: 0,
      },
    };

    writeJson(fixturePath, {
      calibration,
      checks: [
        { id: 'quality.ndcg_at_10', kind: 'delta_pct_min', baseline: 0.5, candidate: 0.56, min_delta_pct: 10 },
      ],
      gate_rules: {
        min_pass_rate: 0,
        required_ids: [],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(artifact.calibration).toEqual(calibration);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('captures an explicit perf profile in the reproducibility snapshot', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-profile-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(fixturePath, {
      checks: [
        { id: 'quality.ndcg_at_10', kind: 'delta_pct_min', baseline: 0.5, candidate: 0.56, min_delta_pct: 10 },
      ],
      gate_rules: {
        min_pass_rate: 0,
        required_ids: [],
      },
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--perf-profile', 'quality', '--out', outPath]);
    expect(result.status).toBe(0);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      inputs: { perf_profile?: unknown };
      reproducibility_lock: { config_snapshot: { CE_PERF_PROFILE?: unknown } };
    };
    expect(artifact.inputs.perf_profile).toBe('quality');
    expect(artifact.reproducibility_lock.config_snapshot.CE_PERF_PROFILE).toBe('quality');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('computes offline retrieval metrics from labeled holdout cases', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-report-offline-eval-'));
    const workspace = path.join(tmp, 'workspace');
    const fixturePath = path.join(tmp, 'fixture.json');
    const holdoutArtifactPath = path.join(tmp, 'holdout-check.json');
    const outPath = path.join(tmp, 'report.json');

    writeText(
      path.join(workspace, 'src', 'alpha.ts'),
      `export function alphaHoldoutNeedle() {\n  return 'alpha holdout benchmark needle';\n}\n`
    );
    writeText(
      path.join(workspace, 'src', 'beta.ts'),
      `export function betaHoldoutNeedle() {\n  return 'beta holdout quality needle';\n}\n`
    );
    writeText(path.join(workspace, 'src', 'other.ts'), `export const other = 'noise';\n`);

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: {
            queries: ['legacy training query'],
          },
          holdout_v1: {
            cases: [
              {
                id: 'alpha',
                query: 'alphaHoldoutNeedle alpha holdout benchmark needle',
                expected_paths: ['src/alpha.ts'],
              },
              {
                id: 'beta',
                query: 'betaHoldoutNeedle beta holdout quality needle',
                expected_paths: ['src/beta.ts'],
              },
            ],
          },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
          normalization: 'trim_lower_whitespace_collapse',
        },
      },
      checks: [
        { id: 'quality.ndcg_at_10', kind: 'delta_pct_min', baseline: 0.5, metric: 'quality.ndcg_at_10', min_delta_pct: 50 },
        { id: 'quality.mrr_at_10', kind: 'delta_pct_min', baseline: 0.5, metric: 'quality.mrr_at_10', min_delta_pct: 50 },
        { id: 'quality.recall_at_10', kind: 'delta_pct_min', baseline: 0.5, metric: 'quality.recall_at_10', min_delta_pct: 50 },
        { id: 'quality.p_at_1', kind: 'threshold_min', metric: 'quality.p_at_1', min: 1 },
      ],
      gate_rules: {
        min_pass_rate: 1,
        required_ids: ['quality.ndcg_at_10', 'quality.mrr_at_10', 'quality.recall_at_10', 'quality.p_at_1'],
      },
    });

    const result = runGenerator([
      '--fixture-pack',
      fixturePath,
      '--workspace',
      workspace,
      '--holdout-artifact',
      holdoutArtifactPath,
      '--out',
      outPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, any>;
    expect(artifact.offline_eval.dataset_id).toBe('holdout_v1');
    expect(artifact.offline_eval.case_count).toBe(2);
    expect(artifact.offline_eval.aggregate_metrics.ndcg_at_10).toBe(1);
    expect(artifact.offline_eval.aggregate_metrics.mrr_at_10).toBe(1);
    expect(artifact.offline_eval.aggregate_metrics.recall_at_10).toBe(1);
    expect(artifact.offline_eval.aggregate_metrics.p_at_1).toBe(1);
    expect(artifact.metrics['quality.p_at_1']).toBe(1);
    expect(artifact.evaluations.map((entry: { status: string }) => entry.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
    ]);

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
