import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function runWs19Gate(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'ws19-slo-gate.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/ci/ws19-slo-gate.ts', () => {
  it('passes index_search family on measurable p95 and throughput with explicit skips for unavailable metrics', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws19-slo-pass-'));
    const artifactPath = path.join(tmp, 'candidate.json');

    writeJson(artifactPath, {
      payload: {
        mode: 'scan',
        timing: {
          p95_ms: 250,
        },
        files_per_sec: 1200,
      },
      provenance: {
        bench_mode: 'scan',
      },
    });

    const result = runWs19Gate(['--family', 'index_search', '--artifact', artifactPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS p95_ms');
    expect(result.stdout).toContain('PASS throughput');
    expect(result.stdout).toContain('SKIP error_rate');
    expect(result.stdout).toContain('SKIP timeout_rate');
    expect(result.stdout).toContain('WS19 gate passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when p95 breaches index_search threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws19-slo-p95-fail-'));
    const artifactPath = path.join(tmp, 'candidate.json');

    writeJson(artifactPath, {
      payload: {
        mode: 'scan',
        timing: {
          p95_ms: 2501,
        },
        files_per_sec: 1500,
      },
      provenance: {
        bench_mode: 'scan',
      },
    });

    const result = runWs19Gate(['--family', 'index_search', '--artifact', artifactPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL p95_ms');
    expect(result.stderr).toContain('WS19 gate failed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when required p95 metric is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws19-slo-missing-p95-'));
    const artifactPath = path.join(tmp, 'candidate.json');

    writeJson(artifactPath, {
      payload: {
        mode: 'scan',
        files_per_sec: 1800,
      },
      provenance: {
        bench_mode: 'scan',
      },
    });

    const result = runWs19Gate(['--family', 'index_search', '--artifact', artifactPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL p95_ms: unavailable');
    expect(result.stderr).toContain('WS19 gate failed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails stale-cache guard for search/retrieve artifacts without cold or bypass cache markers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws19-slo-cache-guard-'));
    const artifactPath = path.join(tmp, 'candidate.json');

    writeJson(artifactPath, {
      payload: {
        mode: 'search',
        timing: {
          p95_ms: 1800,
        },
      },
      provenance: {
        bench_mode: 'search',
      },
    });

    const result = runWs19Gate(['--family', 'index_search', '--artifact', artifactPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL stale_cache_guard');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes review family by using review duration as p95 proxy and skipping unavailable throughput', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws19-slo-review-'));
    const artifactPath = path.join(tmp, 'review_diff_result.json');

    writeJson(artifactPath, {
      stats: {
        duration_ms: 420,
      },
    });

    const result = runWs19Gate(['--family', 'review', '--artifact', artifactPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS p95_ms');
    expect(result.stdout).toContain('SKIP throughput');
    expect(result.stdout).toContain('WS19 gate passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
