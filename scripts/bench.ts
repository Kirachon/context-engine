#!/usr/bin/env node
/**
 * Lightweight benchmark harness (opt-in; not used in CI).
 *
 * Modes:
 * - scan: local filesystem scan/read throughput
 * - index: run ContextServiceClient.indexWorkspace() using the active local-native retrieval path
 * - search: run ContextServiceClient.semanticSearch() using the active local-native retrieval path
 */

import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';
import { internalRetrieveCode } from '../src/internal/handlers/retrieval.js';

type Mode = 'scan' | 'index' | 'search' | 'retrieve';
type RetrieveMode = 'fast' | 'deep';
type RetrievalProvider = 'local_native';

interface Args {
  mode: Mode;
  workspace: string;
  iterations: number;
  topK: number;
  query: string;
  readFiles: boolean;
  cold: boolean;
  bypassCache: boolean;
  retrieveMode: RetrieveMode;
  json: boolean;
}

function resolveRetrievalProvider(): {
  provider: RetrievalProvider;
  source: 'CE_RETRIEVAL_PROVIDER' | 'default';
  raw: string | null;
} {
  const raw = process.env.CE_RETRIEVAL_PROVIDER?.trim();
  if (!raw) {
    return { provider: 'local_native', source: 'default', raw: null };
  }
  if (raw === 'local_native') {
    return { provider: raw, source: 'CE_RETRIEVAL_PROVIDER', raw };
  }

  // Keep fallback safe for unknown values.
  // eslint-disable-next-line no-console
  console.error(
    `[bench] Unsupported CE_RETRIEVAL_PROVIDER="${raw}". Falling back to local_native.`
  );
  return { provider: 'local_native', source: 'default', raw };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'scan',
    workspace: process.cwd(),
    iterations: 10,
    topK: 10,
    query: 'search queue',
    readFiles: false,
    cold: false,
    bypassCache: false,
    retrieveMode: 'fast',
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];

    if (a === '--mode' && next()) {
      const m = next() as Mode;
      if (m !== 'scan' && m !== 'index' && m !== 'search' && m !== 'retrieve') {
        throw new Error(`Invalid --mode: ${m}`);
      }
      args.mode = m;
      i++;
      continue;
    }

    if ((a === '--workspace' || a === '-w') && next()) {
      args.workspace = next();
      i++;
      continue;
    }

    if ((a === '--iterations' || a === '-n') && next()) {
      args.iterations = Math.max(1, Number.parseInt(next()!, 10) || 1);
      i++;
      continue;
    }

    if (a === '--topk' && next()) {
      args.topK = Math.max(1, Number.parseInt(next()!, 10) || 10);
      i++;
      continue;
    }

    if (a === '--query' && next()) {
      args.query = next()!;
      i++;
      continue;
    }

    if (a === '--read') {
      args.readFiles = true;
      continue;
    }

    if (a === '--cold') {
      args.cold = true;
      continue;
    }

    if (a === '--bypass-cache') {
      args.bypassCache = true;
      continue;
    }

    if (a === '--retrieve-mode' && next()) {
      const mode = next() as RetrieveMode;
      if (mode !== 'fast' && mode !== 'deep') {
        throw new Error(`Invalid --retrieve-mode: ${mode}`);
      }
      args.retrieveMode = mode;
      i++;
      continue;
    }

    if (a === '--json') {
      args.json = true;
      continue;
    }

    if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  args.workspace = path.resolve(args.workspace);
  return args;
}

function printHelpAndExit(code: number): never {
  // Keep help short; see docs/BENCHMARKING.md for more.
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  npm run bench -- --mode scan  --workspace . [--read] [--json]
  npm run bench -- --mode index --workspace . [--json]
  npm run bench -- --mode search --workspace . --query "..." --topk 10 --iterations 20 [--cold] [--json]
  npm run bench -- --mode retrieve --workspace . --query "..." --topk 10 --iterations 20 [--retrieve-mode fast|deep] [--bypass-cache] [--cold] [--json]

Options:
  --mode <scan|index|search|retrieve>
  --workspace, -w <path>
  --iterations, -n <number>    (search/retrieve; default 10)
  --query <string>             (search/retrieve)
  --topk <number>              (search/retrieve; default 10)
  --read                        (scan: read file contents too)
  --cold                        (search/retrieve: new client per iteration)
  --bypass-cache                (retrieve: bypass in-memory + persistent caches where supported)
  --retrieve-mode <fast|deep>   (retrieve only; default fast)
  --json                        (emit machine-readable JSON)
`);
  process.exit(code);
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx]!;
}

function summarizeMs(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = samplesMs.reduce((acc, v) => acc + v, 0);
  return {
    count: samplesMs.length,
    avg_ms: samplesMs.length ? sum / samplesMs.length : 0,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    min_ms: sorted[0] ?? 0,
    max_ms: sorted[sorted.length - 1] ?? 0,
  };
}

function shouldSkipDir(name: string): boolean {
  // Intentionally conservative: this is a benchmark, not an indexer.
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === 'dist' ||
    name === 'build' ||
    name === '.next' ||
    name === '.dart_tool' ||
    name === '.turbo' ||
    name === '.cache'
  );
}

async function scanWorkspace(root: string, readFiles: boolean) {
  const started = performance.now();
  let fileCount = 0;
  let totalBytes = 0;
  let readBytes = 0;

  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      fileCount++;
      try {
        const stat = await fs.promises.stat(fullPath);
        totalBytes += stat.size;
        if (readFiles) {
          const buf = await fs.promises.readFile(fullPath);
          readBytes += buf.byteLength;
        }
      } catch {
        // ignore
      }
    }
  }

  const elapsedMs = performance.now() - started;
  return {
    mode: 'scan' as const,
    workspace: root,
    readFiles,
    fileCount,
    totalBytes,
    readBytes,
    elapsed_ms: elapsedMs,
    files_per_sec: elapsedMs > 0 ? (fileCount / elapsedMs) * 1000 : 0,
    mb_per_sec: elapsedMs > 0 ? ((readFiles ? readBytes : totalBytes) / 1024 / 1024 / elapsedMs) * 1000 : 0,
  };
}

function ensureProviderRequirements(_provider: RetrievalProvider, _mode: Mode): void {
  // Retrieval benchmarking is local-native only in the migrated runtime.
}

async function benchIndex(workspace: string, provider: RetrievalProvider) {
  ensureProviderRequirements(provider, 'index');
  const client = new ContextServiceClient(workspace);
  const started = performance.now();
  const result = await client.indexWorkspace();
  const elapsedMs = performance.now() - started;
  return {
    mode: 'index' as const,
    workspace,
    elapsed_ms: elapsedMs,
    result,
  };
}

async function benchSearch(
  workspace: string,
  query: string,
  topK: number,
  iterations: number,
  provider: RetrievalProvider
) {
  ensureProviderRequirements(provider, 'search');
  const samples: number[] = [];
  let lastCount = 0;
  let cold = false;
  for (let i = 0; i < iterations; i++) {
    // Cold mode: new client each iteration to avoid in-process cache hits.
    const client = new ContextServiceClient(workspace);
    cold = true;

    const started = performance.now();
    const results = await client.semanticSearch(query, topK);
    const elapsedMs = performance.now() - started;
    samples.push(elapsedMs);
    lastCount = results.length;
  }

  return {
    mode: 'search' as const,
    workspace,
    query,
    topK,
    iterations,
    cold,
    last_result_count: lastCount,
    timing: summarizeMs(samples),
  };
}

async function benchRetrieve(
  workspace: string,
  query: string,
  topK: number,
  iterations: number,
  retrieveMode: RetrieveMode,
  bypassCache: boolean,
  cold: boolean,
  provider: RetrievalProvider
) {
  ensureProviderRequirements(provider, 'retrieve');
  const samples: number[] = [];
  let lastCount = 0;
  let lastUniqueFiles = 0;

  const retrievalOptions =
    retrieveMode === 'deep'
      ? {
          topK,
          perQueryTopK: Math.min(50, topK * 3),
          maxVariants: 6,
          timeoutMs: 0,
          bypassCache,
          maxOutputLength: topK * 4000,
          enableExpansion: true,
        }
      : {
          topK,
          perQueryTopK: topK,
          maxVariants: 1,
          timeoutMs: 0,
          bypassCache,
          maxOutputLength: topK * 2000,
          enableExpansion: false,
        };

  const runOnce = async (client: ContextServiceClient) => {
    const started = performance.now();
    const result = await internalRetrieveCode(query, client, retrievalOptions);
    const elapsedMs = performance.now() - started;
    samples.push(elapsedMs);
    lastCount = result.results.length;
    lastUniqueFiles = new Set(result.results.map(r => r.path)).size;
  };

  if (!cold) {
    const client = new ContextServiceClient(workspace);
    await runOnce(client); // warm
    samples.length = 0;
    for (let i = 0; i < iterations; i++) {
      await runOnce(client);
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      const client = new ContextServiceClient(workspace);
      await runOnce(client);
    }
  }

  return {
    mode: 'retrieve' as const,
    workspace,
    query,
    topK,
    iterations,
    cold,
    bypass_cache: bypassCache,
    retrieve_mode: retrieveMode,
    last_result_count: lastCount,
    last_unique_files: lastUniqueFiles,
    timing: summarizeMs(samples),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const retrievalProvider = resolveRetrievalProvider();

  const started = performance.now();
  const meta = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    started_at: new Date().toISOString(),
    retrieval_provider: retrievalProvider.provider,
    retrieval_provider_source: retrievalProvider.source,
    env: {
      CE_RETRIEVAL_PROVIDER: process.env.CE_RETRIEVAL_PROVIDER,
      CE_INDEX_USE_WORKER: process.env.CE_INDEX_USE_WORKER,
      CE_INDEX_FILES_WORKER_THRESHOLD: process.env.CE_INDEX_FILES_WORKER_THRESHOLD,
      CE_INDEX_BATCH_SIZE: process.env.CE_INDEX_BATCH_SIZE,
      CE_DEBUG_INDEX: process.env.CE_DEBUG_INDEX,
      CE_DEBUG_SEARCH: process.env.CE_DEBUG_SEARCH,
      CE_AI_PROVIDER: process.env.CE_AI_PROVIDER,
    },
  };

  let payload: unknown;
  if (args.mode === 'scan') {
    payload = await scanWorkspace(args.workspace, args.readFiles);
  } else if (args.mode === 'index') {
    payload = await benchIndex(args.workspace, retrievalProvider.provider);
  } else if (args.mode === 'retrieve') {
    payload = await benchRetrieve(
      args.workspace,
      args.query,
      args.topK,
      args.iterations,
      args.retrieveMode,
      args.bypassCache,
      args.cold,
      retrievalProvider.provider
    );
  } else {
    if (!args.cold) {
      // Warm-cache mode: single client, first call warms, the rest measure hot cache.
      const client = new ContextServiceClient(args.workspace);
      ensureProviderRequirements(retrievalProvider.provider, 'search');
      await client.semanticSearch(args.query, args.topK);

      const samples: number[] = [];
      let lastCount = 0;
      for (let i = 0; i < args.iterations; i++) {
        const started = performance.now();
        const results = await client.semanticSearch(args.query, args.topK);
        const elapsedMs = performance.now() - started;
        samples.push(elapsedMs);
        lastCount = results.length;
      }

      payload = {
        mode: 'search' as const,
        workspace: args.workspace,
        query: args.query,
        topK: args.topK,
        iterations: args.iterations,
        cold: false,
        last_result_count: lastCount,
        timing: summarizeMs(samples),
      };
    } else {
      payload = await benchSearch(
        args.workspace,
        args.query,
        args.topK,
        args.iterations,
        retrievalProvider.provider
      );
    }
  }

  const totalMs = performance.now() - started;
  const out = { meta, total_ms: totalMs, payload };

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log('=== Bench Summary ===');
  // eslint-disable-next-line no-console
  console.log(`mode=${args.mode} workspace=${args.workspace}`);
  // eslint-disable-next-line no-console
  console.log(`total=${totalMs.toFixed(1)}ms`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
