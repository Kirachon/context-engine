import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import type { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { runAbortableTool } from '../../src/http/routes/tools.js';

function createArtifact(params: {
  mode: string;
  commitSha: string;
  repeatAvgMs: number;
  promptAvgChars: number;
}): {
  total_ms: number;
  payload: {
    mode: string;
    timing: { repeat_avg_ms: number; p95_ms: number; avg_ms: number };
    prompt_stats: { avg_chars: number };
  };
  provenance: {
    timestamp_utc: string;
    commit_sha: string;
    branch_or_tag: string;
    workspace_fingerprint: string;
    index_fingerprint: string;
    bench_mode: string;
    dataset_id: string;
    dataset_hash: string;
    retrieval_provider: string;
    feature_flags_snapshot: string;
    node_version: string;
    os_version: string;
    env_fingerprint: string;
  };
} {
  return {
    total_ms: params.repeatAvgMs,
    payload: {
      mode: params.mode,
      timing: {
        repeat_avg_ms: params.repeatAvgMs,
        p95_ms: params.repeatAvgMs,
        avg_ms: params.repeatAvgMs,
      },
      prompt_stats: {
        avg_chars: params.promptAvgChars,
      },
    },
    provenance: {
      timestamp_utc: '2025-03-22T00:00:00.000Z',
      commit_sha: params.commitSha,
      branch_or_tag: 'test-branch',
      workspace_fingerprint: 'workspace:test',
      index_fingerprint: 'index:test',
      bench_mode: params.mode,
      dataset_id: 'slow-tool:enhance_prompt',
      dataset_hash: 'dataset-hash:test',
      retrieval_provider: 'local_native',
      feature_flags_snapshot: '{"a":true}',
      node_version: process.version,
      os_version: 'Windows 11 (x64)',
      env_fingerprint: 'env:test',
    },
  };
}

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

function runBenchCompare(args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'bench-compare.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('slow OpenAI tool hardening gate', () => {
  it('summarizes repeat-call cache behavior and prompt sizes', () => {
    const summaryScript = `
      const { summarizeSlowToolRuns } = await import(${JSON.stringify(
        pathToFileURL(path.join(process.cwd(), 'scripts', 'bench.ts')).href
      )});
      const summary = summarizeSlowToolRuns([
        {
          elapsed_ms: 120,
          output_chars: 2400,
          call_count: 2,
          prompt_chars_total: 1800,
          prompt_chars_max: 950,
          prompt_chars_min: 850,
          prompt_call_samples: [
            { search_query_chars: 24, prompt_chars: 950, timeout_ms: 120000, priority: 'interactive' },
            { search_query_chars: 18, prompt_chars: 850, timeout_ms: 120000, priority: 'interactive' },
          ],
        },
        {
          elapsed_ms: 82,
          output_chars: 2350,
          call_count: 2,
          prompt_chars_total: 1600,
          prompt_chars_max: 820,
          prompt_chars_min: 780,
          prompt_call_samples: [
            { search_query_chars: 24, prompt_chars: 820, timeout_ms: 120000, priority: 'interactive' },
            { search_query_chars: 18, prompt_chars: 780, timeout_ms: 120000, priority: 'interactive' },
          ],
        },
      ]);
      console.log(JSON.stringify(summary));
    `;
    const summaryResult = runTsxEval(summaryScript);
    expect(summaryResult.status).toBe(0);
    expect(summaryResult.stderr).toBe('');
    const summary = JSON.parse(summaryResult.stdout.trim()) as {
      repeat: { first_ms: number; repeat_count: number; repeat_avg_ms: number };
      prompt_stats: { count: number; avg_chars: number };
      run_prompt_stats: { avg_chars: number };
      call_stats: { total_calls: number };
      output_stats: { avg_chars: number };
    };

    expect(summary.repeat.first_ms).toBe(120);
    expect(summary.repeat.repeat_count).toBe(1);
    expect(summary.repeat.repeat_avg_ms).toBe(82);
    expect(summary.prompt_stats.count).toBe(4);
    expect(summary.prompt_stats.avg_chars).toBeGreaterThan(0);
    expect(summary.run_prompt_stats.avg_chars).toBeGreaterThan(0);
    expect(summary.call_stats.total_calls).toBe(4);
    expect(summary.output_stats.avg_chars).toBeGreaterThan(0);
  });

  it('compares slow-tool latency and prompt-size artifacts with the shared gate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-slow-tool-hardening-gate-'));
    const baselinePath = path.join(tmp, 'baseline.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const baseline = createArtifact({
      mode: 'enhance_prompt',
      commitSha: 'baseline-commit',
      repeatAvgMs: 120,
      promptAvgChars: 1800,
    });
    const candidate = createArtifact({
      mode: 'enhance_prompt',
      commitSha: 'candidate-commit',
      repeatAvgMs: 95,
      promptAvgChars: 1420,
    });

    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');
    fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2), 'utf8');

    const latency = runBenchCompare([
      '--baseline',
      baselinePath,
      '--candidate',
      candidatePath,
      '--metric',
      'payload.timing.repeat_avg_ms',
      '--max-regression-pct',
      '15',
      '--max-regression-abs',
      '30',
    ]);
    expect(latency.status).toBe(0);
    expect(latency.stdout).toContain('Benchmark comparison passed.');

    const promptSize = runBenchCompare([
      '--baseline',
      baselinePath,
      '--candidate',
      candidatePath,
      '--metric',
      'payload.prompt_stats.avg_chars',
      '--max-regression-pct',
      '15',
      '--max-regression-abs',
      '300',
    ]);
    expect(promptSize.status).toBe(0);
    expect(promptSize.stdout).toContain('Benchmark comparison passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('aborts slow tool work when the request closes or times out', async () => {
    const closeReq = new EventEmitter() as unknown as Request;
    const closePromise = runAbortableTool(closeReq, 250, 'Slow OpenAI tool', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true }
        );
      });
      return 'done';
    });
    closeReq.emit('close');
    await expect(closePromise).rejects.toMatchObject({ name: 'AbortError' });

    const timeoutReq = new EventEmitter() as unknown as Request;
    const timeoutPromise = runAbortableTool(timeoutReq, 20, 'Slow OpenAI tool', async (signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true }
        );
      });
      return 'done';
    });
    await expect(timeoutPromise).rejects.toThrow('timed out after 20ms');
  });

  it('extends request and response socket timeouts to match the tool budget', async () => {
    const req = new EventEmitter() as Request & { setTimeout: jest.Mock };
    const res = new EventEmitter() as Response & { setTimeout: jest.Mock };
    req.setTimeout = jest.fn();
    res.setTimeout = jest.fn();

    await runAbortableTool(req, 250, 'Slow OpenAI tool', async () => 'done', res);

    expect(req.setTimeout).toHaveBeenCalledWith(250);
    expect(res.setTimeout).toHaveBeenCalledWith(250);
  });
});
