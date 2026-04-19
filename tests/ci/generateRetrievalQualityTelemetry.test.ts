import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runTelemetryGenerator(
  args: string[],
  envOverrides?: Record<string, string>
): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'generate-retrieval-quality-telemetry.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/ci/generate-retrieval-quality-telemetry.ts', () => {
  it('generates telemetry artifact with dense_refresh fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-telemetry-'));
    const outPath = path.join(tmp, 'telemetry.json');

    const result = runTelemetryGenerator(['--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('retrieval_quality_telemetry generated');
    expect(fs.existsSync(outPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const denseRefresh = artifact.dense_refresh as Record<string, unknown>;
    expect(typeof denseRefresh.skipped_docs_rate_pct).toBe('number');
    expect(typeof denseRefresh.embed_batch_p95_ms).toBe('number');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('generates routing_shadow telemetry fields from env overrides', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-quality-telemetry-shadow-'));
    const outPath = path.join(tmp, 'telemetry.json');

    const result = runTelemetryGenerator(['--out', outPath], {
      CE_QA_SHADOW_TOP1_OVERLAP_RATE_PCT: '92.5',
      CE_QA_SYMBOL_ROUTE_ACTIVATION_RATE_PCT: '37.5',
      CE_QA_SYMBOL_ROUTE_MISROUTE_RATE_PCT: '4.25',
    });
    expect(result.status).toBe(0);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(artifact.routing_shadow).toEqual({
      top1_overlap_rate_pct: 92.5,
      symbol_route_activation_rate_pct: 37.5,
      symbol_route_misroute_rate_pct: 4.25,
    });

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

