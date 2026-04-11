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
import { fileURLToPath } from 'url';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';
import { internalRetrieveCode } from '../src/internal/handlers/retrieval.js';
import { handleEnhancePrompt } from '../src/mcp/tools/enhance.js';
import { handleCreatePlan, handleRefinePlan, handleExecutePlan } from '../src/mcp/tools/plan.js';
import { hashString, makeBenchProvenance, type BenchProvenance } from './ci/bench-provenance.js';
import {
  computeDatasetHash,
  getDatasetMap,
  getDatasetQueries,
  getHoldoutConfig,
  readFixturePack,
  resolveSelectedDatasetId,
} from './ci/retrieval-quality-fixture.js';
import type { EnhancedPlanOutput } from '../src/mcp/types/planning.js';

type Mode = 'scan' | 'index' | 'search' | 'retrieve' | 'enhance_prompt' | 'create_plan' | 'refine_plan' | 'execute_plan';
type RetrieveMode = 'fast' | 'deep';
type RetrievalProvider = 'local_native';
type SlowToolMode = Extract<Mode, 'enhance_prompt' | 'create_plan' | 'refine_plan' | 'execute_plan'>;

type NumericSummary = {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
};

type MsSummary = {
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
};

type CharSummary = {
  count: number;
  avg_chars: number;
  p50_chars: number;
  p95_chars: number;
  p99_chars: number;
  min_chars: number;
  max_chars: number;
};

type BytesSummary = {
  count: number;
  avg_bytes: number;
  p50_bytes: number;
  p95_bytes: number;
  p99_bytes: number;
  min_bytes: number;
  max_bytes: number;
};

type ProcessMemorySnapshot = {
  rss_bytes: number;
  heap_total_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
};

type ProcessMemorySummary = {
  sampling: 'process.memoryUsage';
  sample_count: number;
  start: ProcessMemorySnapshot;
  end: ProcessMemorySnapshot;
  peak: ProcessMemorySnapshot;
  delta_bytes: ProcessMemorySnapshot;
  rss_bytes: BytesSummary;
  heap_total_bytes: BytesSummary;
  heap_used_bytes: BytesSummary;
  external_bytes: BytesSummary;
  array_buffers_bytes: BytesSummary;
};

type BenchCacheMetadata = {
  mode: 'cold' | 'warm';
  cold: boolean;
  warmup_iterations: number;
  query_cycle_length?: number;
  bypass_cache?: boolean;
  retrieve_mode?: RetrieveMode | 'search';
};

type SlowToolCallSample = {
  search_query_chars: number;
  prompt_chars: number;
  timeout_ms: number | null;
  priority: string | null;
};

type SlowToolRunSample = {
  elapsed_ms: number;
  output_chars: number;
  call_count: number;
  prompt_chars_total: number;
  prompt_chars_max: number;
  prompt_chars_min: number;
  prompt_call_samples: SlowToolCallSample[];
};

type SlowToolBenchmarkPayload = {
  mode: SlowToolMode;
  tool: SlowToolMode;
  workspace: string;
  cold: boolean;
  iterations: number;
  input: Record<string, unknown>;
  cache: BenchCacheMetadata;
  timing: MsSummary;
  resources: {
    process_memory: ProcessMemorySummary;
  };
  repeat: {
    first_ms: number;
    repeat_count: number;
    repeat_avg_ms: number;
    repeat_p95_ms: number;
    repeat_delta_ms: number;
    repeat_delta_pct: number;
  };
  prompt_stats: CharSummary;
  run_prompt_stats: CharSummary;
  call_stats: {
    total_calls: number;
    avg_calls_per_run: number;
    p95_calls_per_run: number;
    max_calls_per_run: number;
  };
  output_stats: CharSummary;
};

interface Args {
  mode: Mode;
  workspace: string;
  iterations: number;
  topK: number;
  query: string;
  prompt: string;
  task: string;
  currentPlan: string;
  feedback: string;
  clarifications: string;
  stepNumber: number;
  readFiles: boolean;
  cold: boolean;
  bypassCache: boolean;
  retrieveMode: RetrieveMode;
  datasetId: string | null;
  fixturePackPath: string;
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
    prompt: 'Improve the following instruction for implementing slow OpenAI tool hardening.',
    task: 'Harden the slow OpenAI tools by shrinking prompts, stabilizing structure, and making cancellation reliable.',
    currentPlan: '',
    feedback: 'Please tighten the plan and keep it focused on prompt size, latency, caching, background mode, and cancellation.',
    clarifications: '',
    stepNumber: 1,
    readFiles: false,
    cold: false,
    bypassCache: false,
    retrieveMode: 'fast',
    datasetId: null,
    fixturePackPath: path.join('config', 'ci', 'retrieval-quality-fixture-pack.json'),
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];

    if (a === '--mode' && next()) {
      const m = next() as Mode;
      if (
        m !== 'scan' &&
        m !== 'index' &&
        m !== 'search' &&
        m !== 'retrieve' &&
        m !== 'enhance_prompt' &&
        m !== 'create_plan' &&
        m !== 'refine_plan' &&
        m !== 'execute_plan'
      ) {
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

    if (a === '--prompt' && next()) {
      args.prompt = next()!;
      i++;
      continue;
    }

    if (a === '--task' && next()) {
      args.task = next()!;
      i++;
      continue;
    }

    if (a === '--current-plan' && next()) {
      args.currentPlan = next()!;
      i++;
      continue;
    }

    if (a === '--feedback' && next()) {
      args.feedback = next()!;
      i++;
      continue;
    }

    if (a === '--clarifications' && next()) {
      args.clarifications = next()!;
      i++;
      continue;
    }

    if (a === '--step-number' && next()) {
      args.stepNumber = Math.max(1, Number.parseInt(next()!, 10) || 1);
      i++;
      continue;
    }

    if (a === '--dataset-id' && next()) {
      args.datasetId = next()!;
      i++;
      continue;
    }

    if (a === '--fixture-pack' && next()) {
      args.fixturePackPath = next()!;
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
  npm run bench -- --mode enhance_prompt --workspace . [--prompt "..."] [--iterations 3] [--cold] [--json]
  npm run bench -- --mode create_plan --workspace . [--task "..."] [--iterations 3] [--cold] [--json]
  npm run bench -- --mode refine_plan --workspace . [--current-plan '{...}'] [--feedback "..."] [--iterations 3] [--cold] [--json]
  npm run bench -- --mode execute_plan --workspace . [--current-plan '{...}'] [--step-number 1] [--iterations 3] [--cold] [--json]

Options:
  --mode <scan|index|search|retrieve|enhance_prompt|create_plan|refine_plan|execute_plan>
  --workspace, -w <path>
  --iterations, -n <number>    (search/retrieve; default 10)
  --query <string>             (search/retrieve)
  --prompt <string>            (enhance_prompt)
  --task <string>              (create_plan)
  --current-plan <json>        (refine_plan/execute_plan)
  --feedback <string>          (refine_plan)
  --clarifications <json>      (refine_plan JSON object string)
  --step-number <number>       (execute_plan single step selector)
  --dataset-id <id>            (search/retrieve: deterministic query-set selector from fixture pack)
  --fixture-pack <path>        (search/retrieve: fixture pack with holdout datasets)
  --topk <number>              (search/retrieve; default 10)
  --read                        (scan: read file contents too)
  --cold                        (search/retrieve and slow OpenAI tools: new client per iteration)
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

function summarizeNumbers(samples: number[]): NumericSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  return {
    count: samples.length,
    avg: samples.length ? sum / samples.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeMs(samplesMs: number[]) {
  const summary = summarizeNumbers(samplesMs);
  return {
    count: summary.count,
    avg_ms: summary.avg,
    p50_ms: summary.p50,
    p95_ms: summary.p95,
    p99_ms: summary.p99,
    min_ms: summary.min,
    max_ms: summary.max,
  };
}

function summarizeChars(samples: number[]) {
  const summary = summarizeNumbers(samples);
  return {
    count: summary.count,
    avg_chars: summary.avg,
    p50_chars: summary.p50,
    p95_chars: summary.p95,
    p99_chars: summary.p99,
    min_chars: summary.min,
    max_chars: summary.max,
  };
}

function summarizeBytes(samples: number[]): BytesSummary {
  const summary = summarizeNumbers(samples);
  return {
    count: summary.count,
    avg_bytes: summary.avg,
    p50_bytes: summary.p50,
    p95_bytes: summary.p95,
    p99_bytes: summary.p99,
    min_bytes: summary.min,
    max_bytes: summary.max,
  };
}

function takeProcessMemorySnapshot(): ProcessMemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rss_bytes: usage.rss,
    heap_total_bytes: usage.heapTotal,
    heap_used_bytes: usage.heapUsed,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
  };
}

function peakProcessMemorySnapshot(samples: ProcessMemorySnapshot[]): ProcessMemorySnapshot {
  return samples.reduce<ProcessMemorySnapshot>(
    (peak, sample) => ({
      rss_bytes: Math.max(peak.rss_bytes, sample.rss_bytes),
      heap_total_bytes: Math.max(peak.heap_total_bytes, sample.heap_total_bytes),
      heap_used_bytes: Math.max(peak.heap_used_bytes, sample.heap_used_bytes),
      external_bytes: Math.max(peak.external_bytes, sample.external_bytes),
      array_buffers_bytes: Math.max(peak.array_buffers_bytes, sample.array_buffers_bytes),
    }),
    {
      rss_bytes: 0,
      heap_total_bytes: 0,
      heap_used_bytes: 0,
      external_bytes: 0,
      array_buffers_bytes: 0,
    }
  );
}

export function summarizeProcessMemorySnapshots(
  start: ProcessMemorySnapshot,
  samples: ProcessMemorySnapshot[]
): ProcessMemorySummary {
  const end = samples[samples.length - 1] ?? start;
  const timeline = samples.length > 0 ? [start, ...samples] : [start];
  return {
    sampling: 'process.memoryUsage',
    sample_count: samples.length,
    start,
    end,
    peak: peakProcessMemorySnapshot(timeline),
    delta_bytes: {
      rss_bytes: end.rss_bytes - start.rss_bytes,
      heap_total_bytes: end.heap_total_bytes - start.heap_total_bytes,
      heap_used_bytes: end.heap_used_bytes - start.heap_used_bytes,
      external_bytes: end.external_bytes - start.external_bytes,
      array_buffers_bytes: end.array_buffers_bytes - start.array_buffers_bytes,
    },
    rss_bytes: summarizeBytes(samples.map((entry) => entry.rss_bytes)),
    heap_total_bytes: summarizeBytes(samples.map((entry) => entry.heap_total_bytes)),
    heap_used_bytes: summarizeBytes(samples.map((entry) => entry.heap_used_bytes)),
    external_bytes: summarizeBytes(samples.map((entry) => entry.external_bytes)),
    array_buffers_bytes: summarizeBytes(samples.map((entry) => entry.array_buffers_bytes)),
  };
}

export function buildBenchCacheMetadata(
  cold: boolean,
  warmupIterations: number,
  extras: Omit<BenchCacheMetadata, 'mode' | 'cold' | 'warmup_iterations'> = {}
): BenchCacheMetadata {
  return {
    mode: cold ? 'cold' : 'warm',
    cold,
    warmup_iterations: warmupIterations,
    ...extras,
  };
}

function createDefaultPlan(): EnhancedPlanOutput {
  const now = '2025-01-01T00:00:00.000Z';
  return {
    id: 'bench-plan',
    version: 1,
    created_at: now,
    updated_at: now,
    goal: 'Benchmark the slow OpenAI tool hardening plan',
    scope: {
      included: ['prompt compaction', 'cache stability', 'timeout cancellation'],
      excluded: ['provider migration', 'scheduler redesign'],
      assumptions: ['OpenAI-only remains the execution path'],
      constraints: ['Keep review schema stable'],
    },
    mvp_features: [
      {
        name: 'Timeout hardening',
        description: 'Propagate request cancellation and deadlines end to end.',
        steps: [1],
      },
    ],
    nice_to_have_features: [],
    architecture: {
      notes: 'Single OpenAI path with compact, stable prompts and clean abort handling.',
      patterns_used: ['stable prompt envelope'],
      diagrams: [],
    },
    risks: [],
    milestones: [
      {
        name: 'Baseline',
        steps_included: [1],
        estimated_time: '1h',
      },
    ],
    steps: [
      {
        step_number: 1,
        id: 'bench_step_1',
        title: 'Benchmark slow OpenAI tool behavior',
        description: 'Measure latency, prompt size, and repeat-call reuse.',
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [],
        blocks: [],
        can_parallel_with: [],
        priority: 'medium',
        estimated_effort: '1h',
        acceptance_criteria: ['Benchmark runs successfully'],
      },
    ],
    dependency_graph: {
      nodes: [{ id: 'bench_step_1', step_number: 1 }],
      edges: [],
      critical_path: [1],
      parallel_groups: [],
      execution_order: [1],
    },
    testing_strategy: {
      unit: 'Benchmark helper and compare gate tests',
      integration: 'Smoke the slow tool routes with cancellation',
      coverage_target: '80%',
    },
    acceptance_criteria: [
      {
        description: 'Benchmark records prompt size and repeat timing',
        verification: 'Helper outputs structured metrics for repeated calls',
      },
    ],
    confidence_score: 0.75,
    questions_for_clarification: [],
    context_files: [],
    codebase_insights: [],
  };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function buildSlowToolInputSummary(mode: SlowToolMode, args: Args): Record<string, unknown> {
  if (mode === 'enhance_prompt') {
    return {
      prompt_chars: args.prompt.length,
      prompt_hash: sha256Hex(normalizeWhitespace(args.prompt)),
    };
  }
  if (mode === 'create_plan') {
    return {
      task_chars: args.task.length,
      task_hash: sha256Hex(normalizeWhitespace(args.task)),
    };
  }
  if (mode === 'refine_plan') {
    const currentPlan = args.currentPlan.trim() ? args.currentPlan : JSON.stringify(createDefaultPlan());
    const clarifications = args.clarifications.trim() ? args.clarifications : '{}';
    return {
      current_plan_chars: currentPlan.length,
      current_plan_hash: sha256Hex(normalizeWhitespace(currentPlan)),
      feedback_chars: args.feedback.length,
      feedback_hash: sha256Hex(normalizeWhitespace(args.feedback)),
      clarifications_chars: clarifications.length,
      clarifications_hash: sha256Hex(normalizeWhitespace(clarifications)),
    };
  }
  const currentPlan = args.currentPlan.trim() ? args.currentPlan : JSON.stringify(createDefaultPlan());
  const additionalContext = args.feedback.trim() || args.clarifications.trim() || '';
  return {
    plan_chars: currentPlan.length,
    plan_hash: sha256Hex(normalizeWhitespace(currentPlan)),
    additional_context_chars: additionalContext.length,
    additional_context_hash: additionalContext ? sha256Hex(normalizeWhitespace(additionalContext)) : null,
    step_number: args.stepNumber,
  };
}

function resolveSlowToolBenchmarkIdentity(mode: SlowToolMode, args: Args): {
  datasetId: string;
  datasetHash: string;
} {
  const inputSummary = buildSlowToolInputSummary(mode, args);
  const normalized = JSON.stringify({
    mode,
    cold: args.cold,
    iterations: Math.max(1, args.iterations),
    workspace: path.resolve(args.workspace).replace(/\\/g, '/'),
    input: inputSummary,
  });
  return {
    datasetId: `slow-tool:${mode}`,
    datasetHash: sha256Hex(normalized),
  };
}

function createSearchAndAskRecorder(sample: SlowToolRunSample) {
  return (info: SlowToolCallSample) => {
    sample.call_count += 1;
    sample.prompt_chars_total += info.prompt_chars;
    sample.prompt_chars_max = Math.max(sample.prompt_chars_max, info.prompt_chars);
    sample.prompt_chars_min = Math.min(sample.prompt_chars_min, info.prompt_chars);
    sample.prompt_call_samples.push(info);
  };
}

function patchSearchAndAsk(
  client: ContextServiceClient,
  recordCall: (info: SlowToolCallSample) => void
): () => void {
  const original = client.searchAndAsk.bind(client);
  const patched = async (
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number; priority?: string; signal?: AbortSignal }
  ): Promise<string> => {
    recordCall({
      search_query_chars: searchQuery.length,
      prompt_chars: prompt?.length ?? 0,
      timeout_ms: typeof options?.timeoutMs === 'number' ? options.timeoutMs : null,
      priority: typeof options?.priority === 'string' ? options.priority : null,
    });
    return await original(searchQuery, prompt, options);
  };

  (client as ContextServiceClient & {
    searchAndAsk: typeof client.searchAndAsk;
  }).searchAndAsk = patched as typeof client.searchAndAsk;

  return () => {
    (client as ContextServiceClient & {
      searchAndAsk: typeof client.searchAndAsk;
    }).searchAndAsk = original as typeof client.searchAndAsk;
  };
}

export function summarizeSlowToolRuns(samples: SlowToolRunSample[]): {
  timing: MsSummary;
  repeat: SlowToolBenchmarkPayload['repeat'];
  prompt_stats: SlowToolBenchmarkPayload['prompt_stats'];
  run_prompt_stats: SlowToolBenchmarkPayload['run_prompt_stats'];
  call_stats: SlowToolBenchmarkPayload['call_stats'];
  output_stats: SlowToolBenchmarkPayload['output_stats'];
} {
  const elapsedMs = samples.map((sample) => sample.elapsed_ms);
  const promptLengths = samples.flatMap((sample) => sample.prompt_call_samples.map((call) => call.prompt_chars));
  const runPromptTotals = samples.map((sample) => sample.prompt_chars_total);
  const outputLengths = samples.map((sample) => sample.output_chars);
  const callCounts = samples.map((sample) => sample.call_count);
  const firstMs = samples[0]?.elapsed_ms ?? 0;
  const repeatSamples = samples.slice(1).map((sample) => sample.elapsed_ms);
  const repeatAvgMs = repeatSamples.length ? repeatSamples.reduce((acc, value) => acc + value, 0) / repeatSamples.length : 0;
  const repeatSummary = summarizeNumbers(repeatSamples);
  const repeatDeltaMs = firstMs - repeatAvgMs;
  const repeatDeltaPct = firstMs > 0 ? (repeatDeltaMs / firstMs) * 100 : 0;

  return {
    timing: summarizeMs(elapsedMs),
    repeat: {
      first_ms: firstMs,
      repeat_count: repeatSamples.length,
      repeat_avg_ms: repeatAvgMs,
      repeat_p95_ms: repeatSummary.p95,
      repeat_delta_ms: repeatDeltaMs,
      repeat_delta_pct: repeatDeltaPct,
    },
    prompt_stats: summarizeChars(promptLengths),
    run_prompt_stats: summarizeChars(runPromptTotals),
    call_stats: {
      total_calls: callCounts.reduce((acc, value) => acc + value, 0),
      avg_calls_per_run: callCounts.length ? callCounts.reduce((acc, value) => acc + value, 0) / callCounts.length : 0,
      p95_calls_per_run: summarizeNumbers(callCounts).p95,
      max_calls_per_run: summarizeNumbers(callCounts).max,
    },
    output_stats: summarizeChars(outputLengths),
  };
}

export async function benchSlowOpenAiTool(
  workspace: string,
  mode: SlowToolMode,
  args: Args,
  retrievalProvider: RetrievalProvider
): Promise<SlowToolBenchmarkPayload> {
  ensureProviderRequirements(retrievalProvider, mode);
  const iterations = Math.max(1, args.iterations);
  const runSamples: SlowToolRunSample[] = [];
  const memoryStart = takeProcessMemorySnapshot();
  const memorySamples: ProcessMemorySnapshot[] = [];
  const sharedClient = args.cold ? null : new ContextServiceClient(workspace);
  const runForMode = async (client: ContextServiceClient): Promise<string> => {
    if (mode === 'enhance_prompt') {
      return await handleEnhancePrompt({ prompt: args.prompt }, client);
    }
    if (mode === 'create_plan') {
      return await handleCreatePlan(
        {
          task: args.task,
          max_context_files: 5,
          context_token_budget: 6000,
          generate_diagrams: false,
          mvp_only: true,
          auto_save: false,
        },
        client
      );
    }
    if (mode === 'refine_plan') {
      const currentPlan = args.currentPlan.trim() ? args.currentPlan : JSON.stringify(createDefaultPlan());
      return await handleRefinePlan(
        {
          current_plan: currentPlan,
          feedback: args.feedback,
          clarifications: args.clarifications.trim() ? args.clarifications : '{}',
        },
        client
      );
    }
    const currentPlan = args.currentPlan.trim() ? args.currentPlan : JSON.stringify(createDefaultPlan());
    return await handleExecutePlan(
      {
        plan: currentPlan,
        step_number: args.stepNumber,
        mode: 'single_step',
        max_steps: 1,
        stop_on_failure: true,
        additional_context: args.feedback || args.clarifications || '',
      },
      client
    );
  };

  for (let i = 0; i < iterations; i++) {
    const client = sharedClient ?? new ContextServiceClient(workspace);
    const runSample: SlowToolRunSample = {
      elapsed_ms: 0,
      output_chars: 0,
      call_count: 0,
      prompt_chars_total: 0,
      prompt_chars_max: 0,
      prompt_chars_min: Number.POSITIVE_INFINITY,
      prompt_call_samples: [],
    };
    const restore = patchSearchAndAsk(client, createSearchAndAskRecorder(runSample));

    const started = performance.now();
    try {
      const result = await runForMode(client);
      runSample.output_chars = result.length;
      runSample.elapsed_ms = performance.now() - started;
    } finally {
      restore();
    }

    if (runSample.prompt_chars_min === Number.POSITIVE_INFINITY) {
      runSample.prompt_chars_min = 0;
    }

    runSamples.push(runSample);
    memorySamples.push(takeProcessMemorySnapshot());
  }

  const summary = summarizeSlowToolRuns(runSamples);
  const inputSummary = buildSlowToolInputSummary(mode, args);

  return {
    mode,
    tool: mode,
    workspace,
    cold: args.cold,
    iterations,
    input: inputSummary,
    cache: buildBenchCacheMetadata(args.cold, 0),
    timing: summary.timing,
    resources: {
      process_memory: summarizeProcessMemorySnapshots(memoryStart, memorySamples),
    },
    repeat: summary.repeat,
    prompt_stats: summary.prompt_stats,
    run_prompt_stats: summary.run_prompt_stats,
    call_stats: summary.call_stats,
    output_stats: summary.output_stats,
  };
}

function sha256Hex(value: string): string {
  return hashString(value);
}

function resolveDatasetId(workspace: string, datasetId: string | null): string {
  if (datasetId && datasetId.trim()) {
    return datasetId.trim();
  }
  return `workspace:${path.basename(workspace) || 'root'}`;
}

function resolveDatasetHash(args: {
  mode: Mode;
  workspace: string;
  query: string;
  topK: number;
  readFiles: boolean;
  cold: boolean;
  bypassCache: boolean;
  retrieveMode: RetrieveMode;
}): string {
  const normalizedWorkspace = path.resolve(args.workspace).replace(/\\/g, '/');
  const workload =
    args.mode === 'scan'
      ? {
          bench_mode: args.mode,
          workspace: normalizedWorkspace,
          read_files: args.readFiles,
        }
      : {
          bench_mode: args.mode,
          workspace: normalizedWorkspace,
          query: args.query,
          top_k: args.topK,
          cold: args.cold,
          bypass_cache: args.bypassCache,
          retrieve_mode: args.mode === 'retrieve' ? args.retrieveMode : 'search',
        };
  return sha256Hex(JSON.stringify(workload));
}

function getDeterministicQueries(args: Args): {
  source: 'single_query' | 'fixture_dataset';
  dataset_id: string | null;
  dataset_hash: string | null;
  queries: string[];
} {
  if (!args.datasetId && args.query.trim().length > 0) {
    return {
      source: 'single_query',
      dataset_id: null,
      dataset_hash: null,
      queries: [args.query],
    };
  }

  const fixture = readFixturePack(args.fixturePackPath);
  const holdout = getHoldoutConfig(fixture.parsed);
  const datasets = getDatasetMap(holdout);
  const datasetId = resolveSelectedDatasetId(holdout, args.datasetId ?? undefined);
  const dataset = datasets[datasetId];
  const queries = getDatasetQueries(dataset, datasetId);
  const normalizationMode =
    typeof holdout.leakage_guard?.normalization === 'string' && holdout.leakage_guard.normalization.trim().length > 0
      ? holdout.leakage_guard.normalization
      : undefined;
  const datasetHash = computeDatasetHash(queries, normalizationMode);
  return {
    source: 'fixture_dataset',
    dataset_id: datasetId,
    dataset_hash: datasetHash,
    queries,
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
  const memoryStart = takeProcessMemorySnapshot();
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
  const memorySummary = summarizeProcessMemorySnapshots(memoryStart, [takeProcessMemorySnapshot()]);
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
    resources: {
      process_memory: memorySummary,
    },
  };
}

function ensureProviderRequirements(_provider: RetrievalProvider, _mode: Mode): void {
  // Retrieval benchmarking is local-native only in the migrated runtime.
}

async function benchIndex(workspace: string, provider: RetrievalProvider) {
  ensureProviderRequirements(provider, 'index');
  const client = new ContextServiceClient(workspace);
  const memoryStart = takeProcessMemorySnapshot();
  const started = performance.now();
  const result = await client.indexWorkspace();
  const elapsedMs = performance.now() - started;
  return {
    mode: 'index' as const,
    workspace,
    elapsed_ms: elapsedMs,
    result,
    resources: {
      process_memory: summarizeProcessMemorySnapshots(memoryStart, [takeProcessMemorySnapshot()]),
    },
  };
}

async function benchSearch(
  workspace: string,
  queries: string[],
  topK: number,
  iterations: number,
  provider: RetrievalProvider
) {
  ensureProviderRequirements(provider, 'search');
  const samples: number[] = [];
  const memoryStart = takeProcessMemorySnapshot();
  const memorySamples: ProcessMemorySnapshot[] = [];
  let lastCount = 0;
  let cold = false;
  for (let i = 0; i < iterations; i++) {
    // Cold mode: new client each iteration to avoid in-process cache hits.
    const client = new ContextServiceClient(workspace);
    cold = true;

    const started = performance.now();
    const query = queries[i % queries.length]!;
    const results = await client.semanticSearch(query, topK);
    const elapsedMs = performance.now() - started;
    samples.push(elapsedMs);
    lastCount = results.length;
    memorySamples.push(takeProcessMemorySnapshot());
  }

  return {
    mode: 'search' as const,
    workspace,
    query_source: queries.length === 1 ? 'single_query' : 'dataset_cycle',
    query_count: queries.length,
    query: queries[0]!,
    topK,
    iterations,
    cold,
    last_result_count: lastCount,
    cache: buildBenchCacheMetadata(cold, 0, {
      query_cycle_length: queries.length,
      retrieve_mode: 'search',
    }),
    timing: summarizeMs(samples),
    resources: {
      process_memory: summarizeProcessMemorySnapshots(memoryStart, memorySamples),
    },
  };
}

async function benchRetrieve(
  workspace: string,
  queries: string[],
  topK: number,
  iterations: number,
  retrieveMode: RetrieveMode,
  bypassCache: boolean,
  cold: boolean,
  provider: RetrievalProvider
) {
  ensureProviderRequirements(provider, 'retrieve');
  const samples: number[] = [];
  const memorySamples: ProcessMemorySnapshot[] = [];
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

  const runOnce = async (client: ContextServiceClient, query: string) => {
    const started = performance.now();
    const result = await internalRetrieveCode(query, client, retrievalOptions);
    const elapsedMs = performance.now() - started;
    samples.push(elapsedMs);
    lastCount = result.results.length;
    lastUniqueFiles = new Set(result.results.map(r => r.path)).size;
    memorySamples.push(takeProcessMemorySnapshot());
  };

  let memoryStart: ProcessMemorySnapshot;
  if (!cold) {
    const client = new ContextServiceClient(workspace);
    for (const query of queries) {
      await runOnce(client, query);
    }
    samples.length = 0;
    memorySamples.length = 0;
    memoryStart = takeProcessMemorySnapshot();
    for (let i = 0; i < iterations; i++) {
      const query = queries[i % queries.length]!;
      await runOnce(client, query);
    }
  } else {
    memoryStart = takeProcessMemorySnapshot();
    for (let i = 0; i < iterations; i++) {
      const client = new ContextServiceClient(workspace);
      const query = queries[i % queries.length]!;
      await runOnce(client, query);
    }
  }

  return {
    mode: 'retrieve' as const,
    workspace,
    query_source: queries.length === 1 ? 'single_query' : 'dataset_cycle',
    query_count: queries.length,
    query: queries[0]!,
    topK,
    iterations,
    cold,
    bypass_cache: bypassCache,
    retrieve_mode: retrieveMode,
    last_result_count: lastCount,
    last_unique_files: lastUniqueFiles,
    cache: buildBenchCacheMetadata(cold, cold ? 0 : queries.length, {
      query_cycle_length: queries.length,
      bypass_cache: bypassCache,
      retrieve_mode: retrieveMode,
    }),
    timing: summarizeMs(samples),
    resources: {
      process_memory: summarizeProcessMemorySnapshots(memoryStart, memorySamples),
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const retrievalProvider = resolveRetrievalProvider();
  const isSlowToolMode =
    args.mode === 'enhance_prompt' ||
    args.mode === 'create_plan' ||
    args.mode === 'refine_plan' ||
    args.mode === 'execute_plan';
  const slowToolMode = isSlowToolMode ? (args.mode as SlowToolMode) : null;

  const started = performance.now();
  const meta = {
    harness_version: 2,
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
  let datasetId = '';
  let datasetHash = '';
  let datasetInputSummary: Record<string, unknown> | undefined;
  if (slowToolMode) {
    datasetInputSummary = buildSlowToolInputSummary(slowToolMode, args);
    const identity = resolveSlowToolBenchmarkIdentity(slowToolMode, args);
    datasetId = identity.datasetId;
    datasetHash = identity.datasetHash;
    payload = await benchSlowOpenAiTool(args.workspace, slowToolMode, args, retrievalProvider.provider);
  } else if (args.mode === 'scan') {
    payload = await scanWorkspace(args.workspace, args.readFiles);
    datasetId = resolveDatasetId(args.workspace, null);
    datasetHash = sha256Hex(
      JSON.stringify({
        bench_mode: 'scan',
        workspace: path.resolve(args.workspace).replace(/\\/g, '/'),
        read_files: args.readFiles,
      })
    );
    datasetInputSummary = {
      source: 'scan',
      read_files: args.readFiles,
    };
  } else if (args.mode === 'index') {
    payload = await benchIndex(args.workspace, retrievalProvider.provider);
    datasetId = resolveDatasetId(args.workspace, null);
    datasetHash = sha256Hex(
      JSON.stringify({
        bench_mode: 'index',
        workspace: path.resolve(args.workspace).replace(/\\/g, '/'),
      })
    );
    datasetInputSummary = {
      source: 'index',
    };
  } else if (args.mode === 'retrieve') {
    const deterministicQueries = getDeterministicQueries(args);
    payload = await benchRetrieve(
      args.workspace,
      deterministicQueries.queries,
      args.topK,
      args.iterations,
      args.retrieveMode,
      args.bypassCache,
      args.cold,
      retrievalProvider.provider
    );
    datasetId = resolveDatasetId(args.workspace, deterministicQueries.dataset_id);
    datasetHash =
      deterministicQueries.dataset_hash && deterministicQueries.dataset_hash.trim()
        ? deterministicQueries.dataset_hash
        : resolveDatasetHash({
            mode: args.mode,
            workspace: args.workspace,
            query: deterministicQueries.queries[0] ?? args.query,
            topK: args.topK,
            readFiles: args.readFiles,
            cold: args.cold,
            bypassCache: args.bypassCache,
            retrieveMode: args.retrieveMode,
          });
    datasetInputSummary = {
      source: deterministicQueries.source,
      dataset_id: deterministicQueries.dataset_id,
      dataset_hash: deterministicQueries.dataset_hash,
      query_count: deterministicQueries.queries.length,
      fixture_pack: path.resolve(args.fixturePackPath),
    };
  } else {
    const deterministicQueries = getDeterministicQueries(args);
    if (!args.cold) {
      // Warm-cache mode: single client; warm every query once before timed samples.
      const client = new ContextServiceClient(args.workspace);
      ensureProviderRequirements(retrievalProvider.provider, 'search');
      for (const query of deterministicQueries.queries) {
        await client.semanticSearch(query, args.topK);
      }

      const samples: number[] = [];
      const memoryStart = takeProcessMemorySnapshot();
      const memorySamples: ProcessMemorySnapshot[] = [];
      let lastCount = 0;
      for (let i = 0; i < args.iterations; i++) {
        const query = deterministicQueries.queries[i % deterministicQueries.queries.length]!;
        const started = performance.now();
        const results = await client.semanticSearch(query, args.topK);
        const elapsedMs = performance.now() - started;
        samples.push(elapsedMs);
        lastCount = results.length;
        memorySamples.push(takeProcessMemorySnapshot());
      }

      payload = {
        mode: 'search' as const,
        workspace: args.workspace,
        query_source: deterministicQueries.queries.length === 1 ? 'single_query' : 'dataset_cycle',
        query_count: deterministicQueries.queries.length,
        query: deterministicQueries.queries[0]!,
        topK: args.topK,
        iterations: args.iterations,
        cold: false,
        last_result_count: lastCount,
        cache: buildBenchCacheMetadata(false, deterministicQueries.queries.length, {
          query_cycle_length: deterministicQueries.queries.length,
          retrieve_mode: 'search',
        }),
        timing: summarizeMs(samples),
        resources: {
          process_memory: summarizeProcessMemorySnapshots(memoryStart, memorySamples),
        },
      };
    } else {
      payload = await benchSearch(
        args.workspace,
        deterministicQueries.queries,
        args.topK,
        args.iterations,
        retrievalProvider.provider
      );
    }
    datasetId = resolveDatasetId(args.workspace, deterministicQueries.dataset_id);
    datasetHash =
      deterministicQueries.dataset_hash && deterministicQueries.dataset_hash.trim()
        ? deterministicQueries.dataset_hash
        : resolveDatasetHash({
            mode: args.mode,
            workspace: args.workspace,
            query: deterministicQueries.queries[0] ?? args.query,
            topK: args.topK,
            readFiles: args.readFiles,
            cold: args.cold,
            bypassCache: args.bypassCache,
            retrieveMode: args.retrieveMode,
          });
    datasetInputSummary = {
      source: deterministicQueries.source,
      dataset_id: deterministicQueries.dataset_id,
      dataset_hash: deterministicQueries.dataset_hash,
      query_count: deterministicQueries.queries.length,
      fixture_pack: path.resolve(args.fixturePackPath),
    };
  }

  const totalMs = performance.now() - started;
  const provenance: BenchProvenance = makeBenchProvenance({
    benchMode: (slowToolMode ?? (args.mode === 'scan' ? 'scan' : args.mode === 'retrieve' ? 'retrieve' : 'search')) as any,
    workspace: args.workspace,
    retrievalProvider: retrievalProvider.provider,
    datasetId,
    datasetHash,
  });
  const out = { meta, total_ms: totalMs, payload, provenance };
  (out.meta as Record<string, unknown>).dataset = datasetInputSummary;
  (out.meta as Record<string, unknown>).dataset_id = datasetId;
  (out.meta as Record<string, unknown>).dataset_hash = datasetHash;
  const payloadCache =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).cache as Record<string, unknown> | undefined)
      : undefined;
  (out.meta as Record<string, unknown>).execution = {
    iterations: args.iterations,
    cache_mode: payloadCache?.mode ?? null,
    warmup_iterations:
      typeof payloadCache?.warmup_iterations === 'number' ? payloadCache.warmup_iterations : 0,
    cold: typeof payloadCache?.cold === 'boolean' ? payloadCache.cold : null,
  };
  if (slowToolMode) {
    (out.meta as Record<string, unknown>).slow_tool = {
      mode: slowToolMode,
      cold: args.cold,
      iterations: args.iterations,
    };
  }

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

const isMainModule = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
