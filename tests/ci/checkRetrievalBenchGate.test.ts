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
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-retrieval-bench-gate.ts');
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

function benchmarkArtifact(p95Ms: number, commitSha: string): Record<string, unknown> {
  return {
    payload: {
      mode: 'search',
      timing: {
        p95_ms: p95Ms,
        avg_ms: p95Ms,
        p50_ms: p95Ms,
      },
    },
    provenance: {
      timestamp_utc: '2026-03-21T00:00:00.000Z',
      commit_sha: commitSha,
      branch_or_tag: 'main',
      workspace_fingerprint: 'workspace-fingerprint-1',
      index_fingerprint: 'index-fingerprint-1',
      bench_mode: 'search',
      dataset_id: 'dataset-v1',
      dataset_hash: 'dataset-hash-1',
      retrieval_provider: 'local_native',
      feature_flags_snapshot: '{"feature":true}',
      node_version: 'v22.0.0',
      os_version: 'Linux 6.8.0 (x64)',
      env_fingerprint: 'env-stable',
    },
  };
}

function qualityReportArtifact(commitSha: string): Record<string, unknown> {
  return {
    evaluations: [
      { id: 'quality.ndcg_at_10', status: 'pass' },
      { id: 'quality.mrr_at_10', status: 'pass' },
      { id: 'quality.recall_at_50', status: 'pass' },
    ],
    gate_rules: {
      min_pass_rate: 1,
      required_ids: ['quality.ndcg_at_10', 'quality.mrr_at_10', 'quality.recall_at_50'],
    },
    gate: {
      status: 'pass',
      reasons: [],
    },
    reproducibility_lock: {
      commit_sha: commitSha,
      dataset_id: 'holdout_v1',
      dataset_hash: 'quality-dataset-hash',
      fixture_pack_hash: 'f'.repeat(64),
    },
  };
}

describe('scripts/ci/check-retrieval-bench-gate.ts', () => {
  it('passes when benchmark provenance, latency, and quality gates pass', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieval-bench-gate-pass-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const qualityReportPath = path.join(tmp, 'quality-report.json');
    const qualityGateOutPath = path.join(tmp, 'quality-gate.json');
    const outPath = path.join(tmp, 'gate.json');

    writeJson(baselinePath, benchmarkArtifact(100, 'baseline-sha'));
    writeJson(candidatePath, benchmarkArtifact(106, 'candidate-sha'));
    writeJson(qualityReportPath, qualityReportArtifact('candidate-sha'));

    const result = runGate([
      '--baseline',
      baselinePath,
      '--candidate',
      candidatePath,
      '--quality-report',
      qualityReportPath,
      '--quality-gate-out',
      qualityGateOutPath,
      '--out',
      outPath,
      '--max-regression-pct',
      '10',
      '--max-regression-abs',
      '25',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');
    const benchmark = artifact.benchmark as Record<string, unknown>;
    expect(benchmark.status).toBe('pass');
    const quality = artifact.quality as Record<string, unknown>;
    expect(quality.status).toBe('pass');
    expect(fs.existsSync(qualityGateOutPath)).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when benchmark regression breaches the threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieval-bench-gate-latency-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const qualityReportPath = path.join(tmp, 'quality-report.json');
    const qualityGateOutPath = path.join(tmp, 'quality-gate.json');
    const outPath = path.join(tmp, 'gate.json');

    writeJson(baselinePath, benchmarkArtifact(100, 'baseline-sha'));
    writeJson(candidatePath, benchmarkArtifact(130, 'candidate-sha'));
    writeJson(qualityReportPath, qualityReportArtifact('candidate-sha'));

    const result = runGate([
      '--baseline',
      baselinePath,
      '--candidate',
      candidatePath,
      '--quality-report',
      qualityReportPath,
      '--quality-gate-out',
      qualityGateOutPath,
      '--out',
      outPath,
      '--max-regression-pct',
      '10',
      '--max-regression-abs',
      '25',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((reason) => reason.includes('benchmark compare failed'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when the quality report gate fails', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieval-bench-gate-quality-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const qualityReportPath = path.join(tmp, 'quality-report.json');
    const qualityGateOutPath = path.join(tmp, 'quality-gate.json');
    const outPath = path.join(tmp, 'gate.json');

    writeJson(baselinePath, benchmarkArtifact(100, 'baseline-sha'));
    writeJson(candidatePath, benchmarkArtifact(105, 'candidate-sha'));
    writeJson(qualityReportPath, {
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
      reproducibility_lock: {
        commit_sha: 'candidate-sha',
        dataset_id: 'holdout_v1',
        dataset_hash: 'quality-dataset-hash',
        fixture_pack_hash: 'f'.repeat(64),
      },
    });

    const result = runGate([
      '--baseline',
      baselinePath,
      '--candidate',
      candidatePath,
      '--quality-report',
      qualityReportPath,
      '--quality-gate-out',
      qualityGateOutPath,
      '--out',
      outPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((reason) => reason.includes('quality gate: required metric not pass: quality.mrr_at_10 (fail)'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
