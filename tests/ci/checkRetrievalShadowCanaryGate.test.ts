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

  it('fails when routing receipts reproducibility metadata does not match the quality artifact', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-routing-mismatch-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const receiptsPath = path.join(tmp, 'routing-receipts.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'commit-a', dataset_id: 'holdout_v1', dataset_hash: 'a'.repeat(64) },
    });
    writeJson(telemetryPath, {
      dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 80 },
      reproducibility_lock: { commit_sha: 'commit-a', dataset_id: 'holdout_v1', dataset_hash: 'a'.repeat(64) },
    });
    writeJson(holdoutPath, {
      gate: { status: 'pass' },
      summary: { dataset_id: 'holdout_v1', dataset_hash: 'a'.repeat(64) },
    });
    writeJson(receiptsPath, {
      reproducibility_lock: { commit_sha: 'commit-b', dataset_id: 'holdout_v2', dataset_hash: 'b'.repeat(64) },
      routing_diagnostics: {
        symbol_route_count: 4,
        shadow_compare_receipt_count: 4,
        shadow_compare_executed_count: 4,
      },
    });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--routing-receipts', receiptsPath,
      '--out', outPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((line) => line.includes('reproducibility mismatch: commit_sha') && line.includes('routing='))).toBe(true);
    expect(reasons.some((line) => line.includes('reproducibility mismatch: dataset_id') && line.includes('routing='))).toBe(true);
    expect(reasons.some((line) => line.includes('reproducibility mismatch: dataset_hash quality!=routing'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when routing shadow telemetry breaches overlap and misroute thresholds', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-routing-telemetry-fail-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });
    writeJson(telemetryPath, {
      dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 90 },
      routing_shadow: {
        top1_overlap_rate_pct: 72,
        symbol_route_activation_rate_pct: 40,
        symbol_route_misroute_rate_pct: 12,
      },
    });
    writeJson(holdoutPath, {
      gate: { status: 'pass' },
      summary: { dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--out', outPath,
      '--min-shadow-top1-overlap-rate-pct', '80',
      '--max-symbol-route-misroute-rate-pct', '5',
      '--min-symbol-route-activation-rate-pct', '10',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((line) => line.includes('routing_shadow.top1_overlap_rate_pct'))).toBe(true);
    expect(reasons.some((line) => line.includes('routing_shadow.symbol_route_misroute_rate_pct'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when aggregated routing receipts do not cover enough symbol-route samples', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-routing-receipts-fail-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const receiptsPath = path.join(tmp, 'routing-receipts.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });
    writeJson(telemetryPath, {
      dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 90 },
      routing_shadow: {
        top1_overlap_rate_pct: 96,
        symbol_route_activation_rate_pct: 40,
        symbol_route_misroute_rate_pct: 0,
      },
    });
    writeJson(holdoutPath, {
      gate: { status: 'pass' },
      summary: { dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });
    writeJson(receiptsPath, {
      routing_diagnostics: {
        symbol_route_count: 4,
        shadow_compare_receipt_count: 2,
        shadow_compare_executed_count: 2,
      },
    });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--routing-receipts', receiptsPath,
      '--out', outPath,
      '--min-routing-receipt-coverage-pct', '75',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    const reasons = gate.reasons as string[];
    expect(reasons.some((line) => line.includes('routing receipt coverage'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses executed shadow compares rather than receipt presence for routing coverage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shadow-routing-executed-'));
    const qualityPath = path.join(tmp, 'quality.json');
    const telemetryPath = path.join(tmp, 'telemetry.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const receiptsPath = path.join(tmp, 'routing-receipts.json');
    const outPath = path.join(tmp, 'shadow.json');

    writeJson(qualityPath, {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });
    writeJson(telemetryPath, {
      dense_refresh: { skipped_docs_rate_pct: 5, embed_batch_p95_ms: 90 },
      reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
      routing_shadow: {
        top1_overlap_rate_pct: 96,
        symbol_route_activation_rate_pct: 40,
        symbol_route_misroute_rate_pct: 0,
      },
    });
    writeJson(holdoutPath, {
      gate: { status: 'pass' },
      summary: { dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
    });
    writeJson(receiptsPath, {
      reproducibility_lock: { commit_sha: 'abc', dataset_id: 'holdout_v1', dataset_hash: 'x'.repeat(64) },
      routing_diagnostics: {
        symbol_route_count: 4,
        shadow_compare_receipt_count: 4,
        shadow_compare_executed_count: 0,
      },
    });

    const result = runGate([
      '--quality-report', qualityPath,
      '--telemetry', telemetryPath,
      '--holdout', holdoutPath,
      '--routing-receipts', receiptsPath,
      '--out', outPath,
      '--min-routing-receipt-coverage-pct', '75',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const observed = artifact.observed as Record<string, unknown>;
    const routingReceipts = observed.routing_receipts as Record<string, unknown>;
    expect(routingReceipts.shadow_compare_receipt_count).toBe(4);
    expect(routingReceipts.shadow_compare_executed_count).toBe(0);
    expect(routingReceipts.receipt_coverage_pct).toBe(0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
