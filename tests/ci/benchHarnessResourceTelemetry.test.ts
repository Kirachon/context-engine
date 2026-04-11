import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

function runTsxEval(code: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, '--input-type=module', '-e', code], {
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

function runBench(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'bench.ts');
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

describe('scripts/bench.ts resource telemetry', () => {
  it('summarizes process memory samples and explicit cache metadata for baseline artifacts', () => {
    const script = `
      const { summarizeProcessMemorySnapshots, buildBenchCacheMetadata } = await import(${JSON.stringify(
        pathToFileURL(path.join(process.cwd(), 'scripts', 'bench.ts')).href
      )});
      const summary = summarizeProcessMemorySnapshots(
        { rss_bytes: 100, heap_total_bytes: 50, heap_used_bytes: 30, external_bytes: 5, array_buffers_bytes: 1 },
        [
          { rss_bytes: 120, heap_total_bytes: 52, heap_used_bytes: 35, external_bytes: 8, array_buffers_bytes: 2 },
          { rss_bytes: 150, heap_total_bytes: 54, heap_used_bytes: 40, external_bytes: 10, array_buffers_bytes: 3 }
        ]
      );
      const cache = buildBenchCacheMetadata(false, 3, { query_cycle_length: 5, retrieve_mode: 'search' });
      console.log(JSON.stringify({ summary, cache }));
    `;
    const result = runTsxEval(script);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout.trim()) as {
      summary: {
        sample_count: number;
        delta_bytes: { rss_bytes: number; heap_used_bytes: number };
        peak: { rss_bytes: number };
        rss_bytes: { p95_bytes: number };
        heap_used_bytes: { p50_bytes: number };
      };
      cache: { mode: string; cold: boolean; warmup_iterations: number; query_cycle_length: number };
    };

    expect(parsed.summary.sample_count).toBe(2);
    expect(parsed.summary.delta_bytes.rss_bytes).toBe(50);
    expect(parsed.summary.delta_bytes.heap_used_bytes).toBe(10);
    expect(parsed.summary.peak.rss_bytes).toBe(150);
    expect(parsed.summary.rss_bytes.p95_bytes).toBe(150);
    expect(parsed.summary.heap_used_bytes.p50_bytes).toBe(35);
    expect(parsed.cache).toEqual({
      mode: 'warm',
      cold: false,
      warmup_iterations: 3,
      query_cycle_length: 5,
      retrieve_mode: 'search',
    });
  });

  it('emits machine-readable scan artifacts with process memory summaries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-bench-resource-artifact-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'file.ts'), 'export const value = 1;\n', 'utf8');

    const result = runBench(['--mode', 'scan', '--workspace', tmp, '--json']);
    expect(result.status).toBe(0);
    const artifact = JSON.parse(result.stdout.trim()) as {
      meta: { harness_version: number };
      payload: {
        resources: {
          process_memory: {
            sample_count: number;
            rss_bytes: { count: number };
            heap_used_bytes: { count: number };
          };
        };
      };
    };

    expect(artifact.meta.harness_version).toBe(2);
    expect(artifact.payload.resources.process_memory.sample_count).toBe(1);
    expect(artifact.payload.resources.process_memory.rss_bytes.count).toBe(1);
    expect(artifact.payload.resources.process_memory.heap_used_bytes.count).toBe(1);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
