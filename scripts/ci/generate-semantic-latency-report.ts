#!/usr/bin/env node
/**
 * Generate a lightweight semantic latency report with timeout-rate proxy.
 *
 * Exit codes:
 * - 0: report generated
 * - 2: usage/input error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextServiceClient, type SearchResult } from '../../src/mcp/serviceClient.js';

interface CliArgs {
  workspace: string;
  query: string;
  topK: number;
  iterations: number;
  timeoutMs: number;
  outPath: string;
}

interface IterationSample {
  iteration: number;
  query: string;
  elapsed_ms: number;
  result_count: number;
  top_match_type: string;
}

interface SemanticLatencyReport {
  schema_version: 1;
  generated_at_utc: string;
  workspace: string;
  config: {
    query: string;
    top_k: number;
    iterations: number;
    timeout_ms: number;
  };
  metrics: {
    p50_ms: number;
    p95_ms: number;
    avg_ms: number;
    min_ms: number;
    max_ms: number;
    timeout_rate_proxy: number;
    keyword_fallback_rate: number;
  };
  samples: IterationSample[];
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-semantic-latency-report.ts [options]

Options:
  --workspace <path>      Workspace to query (default: .)
  --query <text>          Query to execute (default: "auth login service flow")
  --topk <n>              top_k for semantic search (default: 10)
  --iterations <n>        Number of iterations (default: 10)
  --timeout-ms <n>        Timeout budget used for timeout-rate proxy (default: 5000)
  --out <path>            Output JSON path (default: artifacts/bench/semantic-latency-report.json)
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workspace: process.cwd(),
    query: 'auth login service flow',
    topK: 10,
    iterations: 10,
    timeoutMs: Number.parseInt(process.env.CE_SEMANTIC_SEARCH_AI_TIMEOUT_MS ?? '5000', 10) || 5000,
    outPath: path.join('artifacts', 'bench', 'semantic-latency-report.json'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') printHelpAndExit(0);
    if (!next && arg !== '--help' && arg !== '-h') {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === '--workspace') {
      args.workspace = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--query') {
      args.query = next;
      i += 1;
      continue;
    }
    if (arg === '--topk') {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
        throw new Error('--topk must be an integer between 1 and 50');
      }
      args.topK = parsed;
      i += 1;
      continue;
    }
    if (arg === '--iterations') {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error('--iterations must be an integer >= 1');
      }
      args.iterations = parsed;
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        throw new Error('--timeout-ms must be an integer >= 1000');
      }
      args.timeoutMs = parsed;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      args.outPath = path.resolve(next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function toPct(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function run(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const client = new ContextServiceClient(args.workspace);
    const samples: IterationSample[] = [];

    for (let i = 0; i < args.iterations; i += 1) {
      const started = Date.now();
      const results = await client.semanticSearch(args.query, args.topK, { bypassCache: true });
      const elapsed = Date.now() - started;
      const topMatchType = (results[0]?.matchType ?? 'none').toLowerCase();
      samples.push({
        iteration: i + 1,
        query: args.query,
        elapsed_ms: elapsed,
        result_count: results.length,
        top_match_type: topMatchType,
      });
    }

    const times = samples.map((sample) => sample.elapsed_ms).sort((a, b) => a - b);
    const sum = times.reduce((acc, value) => acc + value, 0);
    const timeoutLikeCount = samples.filter((sample) => sample.elapsed_ms >= Math.max(1, args.timeoutMs - 100)).length;
    const keywordFallbackCount = samples.filter((sample) => sample.top_match_type === 'keyword').length;
    const report: SemanticLatencyReport = {
      schema_version: 1,
      generated_at_utc: new Date().toISOString(),
      workspace: args.workspace,
      config: {
        query: args.query,
        top_k: args.topK,
        iterations: args.iterations,
        timeout_ms: args.timeoutMs,
      },
      metrics: {
        p50_ms: percentile(times, 50),
        p95_ms: percentile(times, 95),
        avg_ms: times.length > 0 ? sum / times.length : 0,
        min_ms: times[0] ?? 0,
        max_ms: times[times.length - 1] ?? 0,
        timeout_rate_proxy: toPct(timeoutLikeCount / samples.length),
        keyword_fallback_rate: toPct(keywordFallbackCount / samples.length),
      },
      samples,
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`semantic_latency_report generated out=${outPath} p50_ms=${report.metrics.p50_ms} p95_ms=${report.metrics.p95_ms} timeout_rate_proxy=${report.metrics.timeout_rate_proxy}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

void run().then((code) => {
  process.exitCode = code;
});

