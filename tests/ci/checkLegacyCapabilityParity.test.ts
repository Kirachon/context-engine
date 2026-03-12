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
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-legacy-capability-parity.ts');
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

function reportWithEvaluations(evaluations: Array<{ id: string; status: 'pass' | 'fail' | 'skip' }>): Record<string, unknown> {
  return {
    evaluations,
    gate: { status: 'pass' },
  };
}

describe('scripts/ci/check-legacy-capability-parity.ts', () => {
  it('passes with synthetic report and matrix', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-pass-'));
    const reportPath = path.join(tmp, 'report.json');
    const matrixPath = path.join(tmp, 'matrix.json');
    const outPath = path.join(tmp, 'out.json');

    writeJson(
      reportPath,
      reportWithEvaluations([
        { id: 'm.alpha.1', status: 'pass' },
        { id: 'm.alpha.2', status: 'pass' },
        { id: 'm.beta.1', status: 'pass' },
      ])
    );
    writeJson(matrixPath, {
      journeys: [
        { id: 'alpha', critical: true, metric_refs: ['m.alpha.1', 'm.alpha.2'] },
        { id: 'beta', metric_refs: ['m.beta.1'] },
      ],
      weights: { alpha: 0.7, beta: 0.3 },
      gate_rules: { min_overall_score: 95 },
    });

    const result = runChecker(['--report', reportPath, '--matrix', matrixPath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');
    expect(artifact.overall_score).toBe(100);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a critical journey is below 100', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-critical-fail-'));
    const reportPath = path.join(tmp, 'report.json');
    const matrixPath = path.join(tmp, 'matrix.json');
    const outPath = path.join(tmp, 'out.json');

    writeJson(
      reportPath,
      reportWithEvaluations([
        { id: 'm.critical.1', status: 'fail' },
        { id: 'm.noncritical.1', status: 'pass' },
      ])
    );
    writeJson(matrixPath, {
      journeys: [
        { id: 'critical_path', critical: true, metric_refs: ['m.critical.1'] },
        { id: 'noncritical_path', metric_refs: ['m.noncritical.1'] },
      ],
      weights: { critical_path: 0.5, noncritical_path: 0.5 },
      gate_rules: { min_overall_score: 40 },
    });

    const result = runChecker(['--report', reportPath, '--matrix', matrixPath, '--out', outPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gate_status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const criticalFailures = artifact.critical_failures as Array<Record<string, unknown>>;
    expect(criticalFailures).toHaveLength(1);
    expect(criticalFailures[0].journey_id).toBe('critical_path');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when overall score is below threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-overall-fail-'));
    const reportPath = path.join(tmp, 'report.json');
    const matrixPath = path.join(tmp, 'matrix.json');
    const outPath = path.join(tmp, 'out.json');

    writeJson(
      reportPath,
      reportWithEvaluations([
        { id: 'm.a', status: 'pass' },
        { id: 'm.b', status: 'fail' },
      ])
    );
    writeJson(matrixPath, {
      journeys: [
        { id: 'a', critical: false, metric_refs: ['m.a'] },
        { id: 'b', critical: false, metric_refs: ['m.b'] },
      ],
      weights: { a: 0.5, b: 0.5 },
      gate_rules: { min_overall_score: 80 },
    });

    const result = runChecker(['--report', reportPath, '--matrix', matrixPath, '--out', outPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gate_status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(artifact.overall_score).toBe(50);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ignores optional metric refs when status is skip or missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-optional-'));
    const reportPath = path.join(tmp, 'report.json');
    const matrixPath = path.join(tmp, 'matrix.json');
    const outPath = path.join(tmp, 'out.json');

    writeJson(reportPath, reportWithEvaluations([{ id: 'm.required', status: 'pass' }, { id: 'm.optional.present', status: 'skip' }]));
    writeJson(matrixPath, {
      journeys: [
        {
          id: 'journey_optional',
          critical: true,
          metric_refs: ['m.required', 'optional:m.optional.present', 'optional:m.optional.missing'],
        },
      ],
      weights: { journey_optional: 1 },
      gate_rules: { min_overall_score: 100 },
    });

    const result = runChecker(['--report', reportPath, '--matrix', matrixPath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_status=pass');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const scores = artifact.journey_scores as Array<Record<string, unknown>>;
    expect(scores[0].considered_count).toBe(1);
    expect(scores[0].pass_count).toBe(1);
    expect(scores[0].score).toBe(100);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('enforces consecutive history pass requirement', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-history-'));
    const reportPath = path.join(tmp, 'report.json');
    const matrixPath = path.join(tmp, 'matrix.json');
    const outPath = path.join(tmp, 'out.json');
    const historyDir = path.join(tmp, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeJson(reportPath, reportWithEvaluations([{ id: 'm.required', status: 'pass' }]));
    writeJson(matrixPath, {
      journeys: [{ id: 'main', critical: true, metric_refs: ['m.required'] }],
      weights: { main: 1 },
      gate_rules: { min_overall_score: 100 },
    });

    const oldPassPath = path.join(historyDir, 'old-pass.json');
    const newestFailPath = path.join(historyDir, 'newest-fail.json');
    writeJson(oldPassPath, { gate: { status: 'pass' } });
    writeJson(newestFailPath, { gate: { status: 'fail' } });

    const now = Date.now();
    fs.utimesSync(oldPassPath, (now - 60_000) / 1000, (now - 60_000) / 1000);
    fs.utimesSync(newestFailPath, now / 1000, now / 1000);

    const result = runChecker([
      '--report',
      reportPath,
      '--matrix',
      matrixPath,
      '--out',
      outPath,
      '--require-consecutive',
      '2',
      '--history-dir',
      historyDir,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gate_status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const historyCheck = artifact.history_check as Record<string, unknown>;
    expect(historyCheck.status).toBe('fail');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});



