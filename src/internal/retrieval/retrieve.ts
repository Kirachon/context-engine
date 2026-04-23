import { ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { envInt, envMs } from '../../config/env.js';
import { incCounter, observeDurationMs, setGauge } from '../../metrics/metrics.js';
import {
  runWithObservabilitySpan,
  setActiveSpanAttributes,
  withObservabilitySpanContext,
} from '../../observability/otel.js';
import {
  evaluateMemoryPressure,
  getRetrievalMemoryGuardrails,
  memoryPressureLevelValue,
  type MemoryPressureStatus,
  type RetrievalMemoryGuardrails,
} from '../../runtime/memoryPressure.js';
import { expandQuery } from './expandQuery.js';
import {
  applyGraphAwareRetrievalSignals,
  buildRetrievalGraphContext,
  mergeExpandedQueriesWithGraph,
} from './graphAware.js';
import { dedupeResults } from './dedupe.js';
import { scoreDenseCandidates } from './dense.js';
import { createWorkspaceDenseRetriever } from './denseIndex.js';
import { createWorkspaceLanceDbVectorRetriever } from './lancedbVectorIndex.js';
import { createHashEmbeddingRuntime, getConfiguredEmbeddingRuntime } from './embeddingRuntime.js';
import { fuseCandidates } from './fusion.js';
import {
  assertRetrievalFlowActive,
  createRetrievalFlowContext,
  finalizeRetrievalFlow,
  noteRetrievalStage,
  type RetrievalFlowContext,
} from './flow.js';
import { evaluateRankingGate } from './rankingCalibration.js';
import { scoreLexicalCandidates } from './lexical.js';
import { rerankCandidates, rerankResults } from './rerank.js';
import { isIdentifierLikeQuery } from './searchHeuristics.js';
import {
  ExpandedQuery,
  InternalSearchResult,
  RetrievalOptions,
  type RankingGateDecision,
  type RankingGateSignals,
  type RankingFallbackReason,
} from './types.js';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disable', 'disabled']);
const RETRIEVAL_STAGE_DURATION_METRIC = 'context_engine_retrieval_stage_duration_seconds';
const RETRIEVAL_FANOUT_QUEUE_WAIT_METRIC = 'context_engine_retrieval_fanout_queue_wait_seconds';
const RETRIEVAL_FANOUT_EXECUTION_METRIC = 'context_engine_retrieval_fanout_execution_seconds';
const RETRIEVAL_FANOUT_QUEUE_DEPTH_METRIC = 'context_engine_retrieval_fanout_queue_depth';
const RETRIEVAL_FANOUT_MAX_QUEUE_DEPTH_METRIC = 'context_engine_retrieval_fanout_observed_max_queue_depth';
const RETRIEVAL_FANOUT_IN_FLIGHT_METRIC = 'context_engine_retrieval_fanout_in_flight';
const RETRIEVAL_FANOUT_MAX_IN_FLIGHT_METRIC = 'context_engine_retrieval_fanout_observed_max_in_flight';
const RETRIEVAL_FANOUT_CONCURRENCY_LIMIT_METRIC = 'context_engine_retrieval_fanout_concurrency_limit';
const RETRIEVAL_MEMORY_PRESSURE_LEVEL_METRIC = 'context_engine_retrieval_memory_pressure_level';
const RETRIEVAL_MEMORY_GUARDRAIL_TOTAL_METRIC = 'context_engine_retrieval_memory_guardrail_total';
const RETRIEVAL_BUDGET_GUARDRAIL_TOTAL_METRIC = 'context_engine_retrieval_budget_guardrail_total';

type NormalizedRetrievalOptions =
  Omit<Required<RetrievalOptions>, 'bypassCache' | 'maxOutputLength' | 'denseProvider' | 'reranker' | 'signal' | 'flow' | 'includePaths' | 'excludePaths'> & {
    bypassCache: boolean;
    maxOutputLength?: number;
    denseProvider?: RetrievalOptions['denseProvider'];
    reranker?: RetrievalOptions['reranker'];
    includePaths?: string[];
    excludePaths?: string[];
  };

type RerankAppliedPath = 'heuristic' | 'transformer' | 'provider' | 'original_order';
type RerankSelectionReason =
  | 'rerank_disabled'
  | 'insufficient_candidates'
  | 'external_provider'
  | 'gate_transformer'
  | 'gate_skipped'
  | 'budget_exhausted';

type FanoutBackend = 'semantic' | 'lexical' | 'dense';
type RetrievalMeasuredStage =
  | 'expand_queries'
  | 'fanout'
  | 'collect_candidates'
  | 'dedupe'
  | 'fusion'
  | 'rerank'
  | 'legacy_semantic_path';
type MemoryPressurePhase = 'preflight' | 'pre_rerank';

type LocalSemaphoreSnapshot = {
  limit: number;
  active: number;
  maxActive: number;
  queued: number;
  maxQueued: number;
  queuedEvents: number;
  scheduled: number;
  completed: number;
  pending: number;
};

type LocalSemaphore = {
  run<T>(task: () => Promise<T>): Promise<T>;
  snapshot(): LocalSemaphoreSnapshot;
};

type RerankDiagnosticsUpdate = {
  selectedPath: 'heuristic' | 'transformer' | 'provider';
  appliedPath: RerankAppliedPath;
  gateState: 'disabled' | 'skipped' | 'invoked' | 'fail_open';
  fallbackReason: RankingFallbackReason;
  selectionReason: RerankSelectionReason;
  candidateCount: number;
  headCount: number;
  tailCount: number;
  gateDecision?: RankingGateDecision;
  providerId?: string;
  reasonCode?: string;
  runtimeId?: string;
  modelId?: string;
};

export function isRetrievalPipelineEnabled(): boolean {
  if (featureEnabled('rollout_kill_switch')) {
    return false;
  }

  const raw = process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE;
  if (!raw) {
    return true;
  }
  return !DISABLED_VALUES.has(raw.toLowerCase());
}

function createLocalSemaphore(limit: number): LocalSemaphore {
  let active = 0;
  let maxActive = 0;
  let queued = 0;
  let maxQueued = 0;
  let queuedEvents = 0;
  let scheduled = 0;
  let completed = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    scheduled += 1;
    if (active >= limit) {
      queued += 1;
      maxQueued = Math.max(maxQueued, queued);
      queuedEvents += 1;
      await new Promise<void>((resolve) => {
        waiters.push(() => {
          queued = Math.max(0, queued - 1);
          resolve();
        });
      });
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
  };

  const release = (): void => {
    active = Math.max(0, active - 1);
    completed += 1;
    waiters.shift()?.();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    snapshot(): LocalSemaphoreSnapshot {
      return {
        limit,
        active,
        maxActive,
        queued,
        maxQueued,
        queuedEvents,
        scheduled,
        completed,
        pending: waiters.length,
      };
    },
  };
}

function updateFanoutDiagnostics(
  flow: RetrievalFlowContext,
  details: {
    backends: FanoutBackend[];
    variantCount: number;
    plannedTasks: number;
    snapshot: LocalSemaphoreSnapshot;
  }
): void {
  flow.metadata.fanoutBackends = [...details.backends];
  flow.metadata.fanoutBackendCount = details.backends.length;
  flow.metadata.fanoutVariantCount = details.variantCount;
  flow.metadata.fanoutPlannedTasks = details.plannedTasks;
  flow.metadata.fanoutConcurrencyCap = details.snapshot.limit;
  flow.metadata.fanoutScheduledTasks = details.snapshot.scheduled;
  flow.metadata.fanoutQueuedTasks = details.snapshot.queued;
  flow.metadata.fanoutObservedMaxQueued = details.snapshot.maxQueued;
  flow.metadata.fanoutTotalQueuedTasks = details.snapshot.queuedEvents;
  flow.metadata.fanoutPendingTasks = details.snapshot.pending;
  flow.metadata.fanoutCompletedTasks = details.snapshot.completed;
  flow.metadata.fanoutInFlight = details.snapshot.active;
  flow.metadata.fanoutObservedMaxInFlight = details.snapshot.maxActive;
  setGauge(
    RETRIEVAL_FANOUT_QUEUE_DEPTH_METRIC,
    undefined,
    details.snapshot.queued,
    'Current retrieval fanout queue depth.'
  );
  setGauge(
    RETRIEVAL_FANOUT_MAX_QUEUE_DEPTH_METRIC,
    undefined,
    details.snapshot.maxQueued,
    'Largest retrieval fanout queue depth observed during the active request.'
  );
  setGauge(
    RETRIEVAL_FANOUT_IN_FLIGHT_METRIC,
    undefined,
    details.snapshot.active,
    'Current number of retrieval fanout tasks executing.'
  );
  setGauge(
    RETRIEVAL_FANOUT_MAX_IN_FLIGHT_METRIC,
    undefined,
    details.snapshot.maxActive,
    'Largest number of retrieval fanout tasks executing during the active request.'
  );
  setGauge(
    RETRIEVAL_FANOUT_CONCURRENCY_LIMIT_METRIC,
    undefined,
    details.snapshot.limit,
    'Configured retrieval fanout concurrency limit.'
  );
}

function getStageDurations(flow: RetrievalFlowContext): Record<string, number> {
  const existing = flow.metadata.stageDurationsMs;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, number>;
  }
  const created: Record<string, number> = {};
  flow.metadata.stageDurationsMs = created;
  return created;
}

function recordStageDuration(
  flow: RetrievalFlowContext,
  stage: RetrievalMeasuredStage,
  durationMs: number
): void {
  const safeDurationMs = Math.max(0, durationMs);
  getStageDurations(flow)[stage] = safeDurationMs;
  observeDurationMs(
    RETRIEVAL_STAGE_DURATION_METRIC,
    { stage },
    safeDurationMs,
    { help: 'Retrieval pipeline stage duration in seconds.' }
  );
}

function setRetrievalTraceAttributes(attributes: Record<string, unknown>): void {
  setActiveSpanAttributes(attributes);
}

function withStageTiming<T>(
  flow: RetrievalFlowContext,
  stage: RetrievalMeasuredStage,
  fn: () => T
): T {
  const start = Date.now();
  return withObservabilitySpanContext(
    'retrieval.stage',
    {
      attributes: {
        'retrieval.stage': stage,
        'retrieval.flow_stage_count': flow.stages.length,
      },
    },
    () => {
      try {
        return fn();
      } finally {
        const durationMs = Date.now() - start;
        recordStageDuration(flow, stage, durationMs);
        setRetrievalTraceAttributes({
          'retrieval.stage.last_name': stage,
          'retrieval.stage.last_duration_ms': durationMs,
          'retrieval.flow_stage_count': flow.stages.length,
        });
      }
    }
  );
}

async function withAsyncStageTiming<T>(
  flow: RetrievalFlowContext,
  stage: RetrievalMeasuredStage,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  return await runWithObservabilitySpan(
    'retrieval.stage',
    {
      attributes: {
        'retrieval.stage': stage,
        'retrieval.flow_stage_count': flow.stages.length,
      },
    },
    async () => {
      try {
        return await fn();
      } finally {
        const durationMs = Date.now() - start;
        recordStageDuration(flow, stage, durationMs);
        setRetrievalTraceAttributes({
          'retrieval.stage.last_name': stage,
          'retrieval.stage.last_duration_ms': durationMs,
          'retrieval.flow_stage_count': flow.stages.length,
        });
      }
    }
  );
}

function annotateMemoryPressure(
  flow: RetrievalFlowContext,
  phase: MemoryPressurePhase,
  status: MemoryPressureStatus
): void {
  const prefix = phase === 'preflight' ? 'memoryPressure' : 'preRerankMemoryPressure';
  flow.metadata[`${prefix}Level`] = status.level;
  flow.metadata[`${prefix}Reasons`] = [...status.reasons];
  flow.metadata[`${prefix}HeapUtilization`] = status.snapshot.heapUtilization;
  flow.metadata[`${prefix}HeapUsedBytes`] = status.snapshot.heapUsedBytes;
  flow.metadata[`${prefix}HeapTotalBytes`] = status.snapshot.heapTotalBytes;
  flow.metadata[`${prefix}HeapLimitBytes`] = status.snapshot.heapLimitBytes;
  flow.metadata[`${prefix}RssBytes`] = status.snapshot.rssBytes;
  flow.metadata[`${prefix}ExternalBytes`] = status.snapshot.externalBytes;
  flow.metadata[`${prefix}ArrayBuffersBytes`] = status.snapshot.arrayBuffersBytes;
  setGauge(
    RETRIEVAL_MEMORY_PRESSURE_LEVEL_METRIC,
    { phase },
    memoryPressureLevelValue(status.level),
    'Retrieval memory pressure level (normal=0, elevated=1, high=2, critical=3).'
  );
}

function noteMemoryGuardrail(
  flow: RetrievalFlowContext,
  phase: MemoryPressurePhase,
  level: MemoryPressureStatus['level'],
  guardrail: 'fanout_concurrency_cap' | 'max_variants_cap' | 'rerank_disabled',
  value?: number
): void {
  incCounter(
    RETRIEVAL_MEMORY_GUARDRAIL_TOTAL_METRIC,
    { phase, level, guardrail },
    1,
    'Retrieval memory guardrails applied due to memory pressure.'
  );
  if (value === undefined) {
    noteRetrievalStage(flow, `memory_guardrail:${phase}:${guardrail}`);
    return;
  }
  noteRetrievalStage(flow, `memory_guardrail:${phase}:${guardrail}:${value}`);
}

function resolveDegradationFloor(
  settings: Pick<NormalizedRetrievalOptions, 'enableDense' | 'enableLexical'>
): 'semantic_retrieval' | 'hybrid_retrieval' | 'dense_retrieval' {
  if (settings.enableDense) {
    return 'dense_retrieval';
  }
  if (settings.enableLexical) {
    return 'hybrid_retrieval';
  }
  return 'semantic_retrieval';
}

type RerankBudgetSnapshot = {
  budgetMs: number;
  elapsedMs: number;
  remainingMs: number;
  effectiveTimeoutMs: number;
};

function resolveRerankBudget(
  flow: RetrievalFlowContext,
  settings: Pick<NormalizedRetrievalOptions, 'rerankBudgetMs' | 'rerankTimeoutMs'>
): RerankBudgetSnapshot | null {
  const budgetMs = Math.max(0, settings.rerankBudgetMs);
  if (budgetMs <= 0) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - flow.startedAtMs);
  const remainingMs = Math.max(0, budgetMs - elapsedMs);
  return {
    budgetMs,
    elapsedMs,
    remainingMs,
    effectiveTimeoutMs: remainingMs > 0 ? Math.max(1, Math.min(settings.rerankTimeoutMs, remainingMs)) : 0,
  };
}

function noteRerankBudgetGuardrail(
  flow: RetrievalFlowContext,
  reason: 'skip' | 'timeout_cap',
  snapshot: RerankBudgetSnapshot
): void {
  incCounter(
    RETRIEVAL_BUDGET_GUARDRAIL_TOTAL_METRIC,
    { stage: 'rerank', reason },
    1,
    'Retrieval latency budget guardrails applied.'
  );
  const guardrails = Array.isArray(flow.metadata.budgetGuardrails)
    ? [...(flow.metadata.budgetGuardrails as Array<Record<string, unknown>>)]
    : [];
  guardrails.push({
    stage: 'rerank',
    reason,
    budgetMs: snapshot.budgetMs,
    elapsedMs: snapshot.elapsedMs,
    remainingMs: snapshot.remainingMs,
  });
  flow.metadata.budgetGuardrails = guardrails;
  noteRetrievalStage(flow, `budget_guardrail:rerank:${reason}`);
}

function applyRetrievalMemoryGuardrails(
  settings: NormalizedRetrievalOptions,
  guardrails: RetrievalMemoryGuardrails
): { settings: NormalizedRetrievalOptions; applied: RetrievalMemoryGuardrails } {
  let next = settings;
  const applied: RetrievalMemoryGuardrails = {};

  if (
    guardrails.fanoutConcurrencyCap !== undefined
    && settings.fanoutConcurrency > guardrails.fanoutConcurrencyCap
  ) {
    next = { ...next, fanoutConcurrency: guardrails.fanoutConcurrencyCap };
    applied.fanoutConcurrencyCap = guardrails.fanoutConcurrencyCap;
  }

  if (
    guardrails.maxVariantsCap !== undefined
    && settings.enableExpansion
    && settings.maxVariants > guardrails.maxVariantsCap
  ) {
    next = { ...next, maxVariants: guardrails.maxVariantsCap };
    applied.maxVariantsCap = guardrails.maxVariantsCap;
  }

  if (guardrails.disableRerank && settings.enableRerank) {
    next = { ...next, enableRerank: false };
    applied.disableRerank = true;
  }

  return { settings: next, applied };
}

function normalizeOptions(options: RetrievalOptions | undefined): NormalizedRetrievalOptions {
  const topK = Math.max(1, Math.min(50, options?.topK ?? 10));
  const perQueryTopK = Math.max(1, Math.min(50, options?.perQueryTopK ?? topK));
  const maxVariants = Math.max(1, Math.min(6, options?.maxVariants ?? 4));
  const fanoutConcurrency = Math.max(
    1,
    Math.min(24, options?.fanoutConcurrency ?? envInt('CE_RETRIEVAL_FANOUT_CONCURRENCY', 4, { min: 1, max: 24 }))
  );
  const envTimeoutRaw = process.env.CONTEXT_ENGINE_RETRIEVAL_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw ? Number(envTimeoutRaw) : undefined;
  const timeoutMs = Math.max(
    0,
    Math.min(10000, options?.timeoutMs ?? envTimeout ?? 0)
  );
  const rerankTimeoutMs = envMs('CONTEXT_ENGINE_RERANK_TIMEOUT_MS', 80, { min: 10, max: 2000 });
  const rerankBudgetMs = envMs('CE_RETRIEVAL_STAGE_BUDGET_RERANK_MS', 0, { min: 0, max: 10_000 });

  return {
    topK,
    perQueryTopK,
    maxVariants,
    fanoutConcurrency,
    timeoutMs,
    enableExpansion: options?.enableExpansion ?? true,
    enableDedupe: options?.enableDedupe ?? true,
    enableLexical: options?.enableLexical ?? true,
    enableDense: options?.enableDense ?? false,
    enableFusion: options?.enableFusion ?? true,
    enableRerank: options?.enableRerank ?? true,
    rerankTopN: Math.max(1, Math.min(100, options?.rerankTopN ?? 20)),
    rerankTimeoutMs: Math.max(10, Math.min(2000, options?.rerankTimeoutMs ?? rerankTimeoutMs)),
    rerankBudgetMs: Math.max(0, Math.min(10_000, options?.rerankBudgetMs ?? rerankBudgetMs)),
    reranker: options?.reranker,
    semanticWeight: Math.max(0, Math.min(1, options?.semanticWeight ?? 0.7)),
    lexicalWeight: Math.max(0, Math.min(1, options?.lexicalWeight ?? 0.3)),
    denseWeight: Math.max(0, Math.min(1, options?.denseWeight ?? 0)),
    profile: options?.profile ?? 'balanced',
    rewriteMode: options?.rewriteMode ?? (featureEnabled('retrieval_rewrite_v2') ? 'v2' : 'v1'),
    rankingMode: options?.rankingMode ?? (
      featureEnabled('retrieval_ranking_v3')
        ? 'v3'
        : featureEnabled('retrieval_ranking_v2')
          ? 'v2'
          : 'v1'
    ),
    denseProvider: options?.denseProvider,
    log: options?.log ?? false,
    bypassCache: options?.bypassCache ?? false,
    maxOutputLength: options?.maxOutputLength,
    includePaths: options?.includePaths,
    excludePaths: options?.excludePaths,
  };
}

function noteRerankPathStages(flow: RetrievalFlowContext, diagnostics: RerankDiagnosticsUpdate): void {
  noteRetrievalStage(flow, `rerank:selected:${diagnostics.selectedPath}`);
  noteRetrievalStage(flow, `rerank:applied:${diagnostics.appliedPath}`);
  noteRetrievalStage(flow, `rerank:state:${diagnostics.gateState}`);
  noteRetrievalStage(flow, `rerank:reason:${diagnostics.selectionReason}`);
  if (diagnostics.gateState === 'fail_open') {
    noteRetrievalStage(flow, `rerank:fallback:${diagnostics.fallbackReason}`);
  }
}

function updateRerankDiagnostics(
  flow: RetrievalFlowContext,
  diagnostics: RerankDiagnosticsUpdate
): void {
  flow.metadata.rerankPath = diagnostics.selectedPath;
  flow.metadata.rerankSelectedPath = diagnostics.selectedPath;
  flow.metadata.rerankAppliedPath = diagnostics.appliedPath;
  flow.metadata.rerankGateState = diagnostics.gateState;
  flow.metadata.rerankFallbackReason = diagnostics.fallbackReason;
  flow.metadata.rerankSelectionReason = diagnostics.selectionReason;
  flow.metadata.rerankCandidateCount = diagnostics.candidateCount;
  flow.metadata.rerankHeadCount = diagnostics.headCount;
  flow.metadata.rerankTailCount = diagnostics.tailCount;
  flow.metadata.rerankReasonCode = diagnostics.reasonCode;
  flow.metadata.rerankProviderId = diagnostics.providerId;
  flow.metadata.rerankRuntimeId = diagnostics.runtimeId;
  flow.metadata.rerankModelId = diagnostics.modelId;
  if (diagnostics.gateDecision) {
    flow.metadata.rerankGateDecision = diagnostics.gateDecision;
    flow.metadata.rerankGateReasons = diagnostics.gateDecision.reasons;
    flow.metadata.rerankGateSignals = diagnostics.gateDecision.signals as RankingGateSignals;
  }
  noteRerankPathStages(flow, diagnostics);
}

async function applyRerankStage(
  query: string,
  candidates: InternalSearchResult[],
  settings: NormalizedRetrievalOptions,
  flow: RetrievalFlowContext
): Promise<InternalSearchResult[]> {
  const topN = Math.min(settings.rerankTopN, candidates.length);
  const head = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  if (!settings.enableRerank || candidates.length <= 1) {
    updateRerankDiagnostics(flow, {
      selectedPath: 'heuristic',
      appliedPath: 'original_order',
      gateState: settings.enableRerank ? 'skipped' : 'disabled',
      fallbackReason: 'none',
      selectionReason: settings.enableRerank ? 'insufficient_candidates' : 'rerank_disabled',
      candidateCount: candidates.length,
      headCount: head.length,
      tailCount: tail.length,
      providerId: settings.reranker?.id,
      reasonCode: settings.enableRerank ? 'single_candidate' : 'rerank_disabled',
    });
    noteRetrievalStage(flow, 'rerank:skipped');
    return candidates;
  }

  const rerankBudget = resolveRerankBudget(flow, settings);
  flow.metadata.rerankBudgetMs = rerankBudget?.budgetMs ?? settings.rerankBudgetMs;
  flow.metadata.rerankBudgetElapsedMs = rerankBudget?.elapsedMs ?? 0;
  flow.metadata.rerankBudgetRemainingMs = rerankBudget?.remainingMs ?? settings.rerankBudgetMs;
  if (rerankBudget && rerankBudget.remainingMs <= 0) {
    flow.metadata.effectiveRerankEnabled = false;
    flow.metadata.rerankBudgetExhausted = true;
    updateRerankDiagnostics(flow, {
      selectedPath: 'heuristic',
      appliedPath: 'original_order',
      gateState: 'skipped',
      fallbackReason: 'rerank_skipped',
      selectionReason: 'budget_exhausted',
      candidateCount: candidates.length,
      headCount: head.length,
      tailCount: tail.length,
      providerId: settings.reranker?.id,
      reasonCode: 'budget_exhausted',
    });
    noteRerankBudgetGuardrail(flow, 'skip', rerankBudget);
    noteRetrievalStage(flow, 'rerank:skipped:budget');
    return candidates;
  }

  const effectiveRerankTimeoutMs = rerankBudget?.effectiveTimeoutMs ?? settings.rerankTimeoutMs;
  flow.metadata.effectiveRerankTimeoutMs = effectiveRerankTimeoutMs;
  if (rerankBudget && effectiveRerankTimeoutMs < settings.rerankTimeoutMs) {
    flow.metadata.rerankBudgetTimeoutCapped = true;
    noteRerankBudgetGuardrail(flow, 'timeout_cap', rerankBudget);
  }

  const stageStart = Date.now();
  noteRetrievalStage(flow, 'rerank:started');
  const gateDecision = evaluateRankingGate(head, {
    rankingMode: settings.rankingMode,
    profile: settings.profile,
  });
  const baseSelectionReason: RerankSelectionReason = settings.reranker
    ? 'external_provider'
    : gateDecision.shouldUseTransformerRerank
      ? 'gate_transformer'
      : 'gate_skipped';
  updateRerankDiagnostics(flow, {
    selectedPath: settings.reranker
      ? 'provider'
      : gateDecision.shouldUseTransformerRerank
        ? 'transformer'
        : 'heuristic',
    appliedPath: settings.reranker
      ? 'provider'
      : gateDecision.shouldUseTransformerRerank
        ? 'transformer'
        : 'heuristic',
    gateState: gateDecision.shouldUseTransformerRerank || settings.reranker ? 'invoked' : 'skipped',
    fallbackReason: gateDecision.shouldUseTransformerRerank || settings.reranker ? 'none' : 'rerank_skipped',
    selectionReason: baseSelectionReason,
    candidateCount: candidates.length,
    headCount: head.length,
    tailCount: tail.length,
    gateDecision,
    providerId: settings.reranker?.id,
    reasonCode: baseSelectionReason,
  });

  try {
    let rerankedHead: InternalSearchResult[];
    if (settings.reranker) {
      const providerResult = await withTimeoutState<InternalSearchResult[] | null>(
        settings.reranker.rerank(query, head, { timeoutMs: effectiveRerankTimeoutMs }),
        effectiveRerankTimeoutMs,
        null
      );
      if (!providerResult.value || providerResult.value.length === 0) {
        incCounter(
          'context_engine_retrieval_rerank_fail_open_total',
          { reason: 'timeout_or_empty', reranker: settings.reranker.id },
          1,
          'Rerank fail-open fallbacks.'
        );
        updateRerankDiagnostics(flow, {
          selectedPath: 'provider',
          appliedPath: 'original_order',
          gateState: 'fail_open',
          fallbackReason: providerResult.timedOut ? 'rerank_timeout_or_empty' : 'rerank_error',
          selectionReason: 'external_provider',
          candidateCount: candidates.length,
          headCount: head.length,
          tailCount: tail.length,
          gateDecision,
          providerId: settings.reranker.id,
          reasonCode: providerResult.timedOut ? 'provider_timeout' : 'provider_empty',
        });
        noteRetrievalStage(flow, 'rerank:fail_open');
        rerankedHead = head;
      } else {
        updateRerankDiagnostics(flow, {
          selectedPath: 'provider',
          appliedPath: 'provider',
          gateState: 'invoked',
          fallbackReason: 'none',
          selectionReason: 'external_provider',
          candidateCount: candidates.length,
          headCount: head.length,
          tailCount: tail.length,
          gateDecision,
          providerId: settings.reranker.id,
          reasonCode: 'provider_applied',
        });
        rerankedHead = providerResult.value.slice(0, topN);
      }
    } else {
      if (!gateDecision.shouldUseTransformerRerank) {
        noteRetrievalStage(flow, 'rerank:skipped');
        rerankedHead = rerankResults(head, { originalQuery: query, mode: settings.rankingMode });
      } else {
        const heuristicResult = await withTimeoutState<InternalSearchResult[]>(
          rerankCandidates(head, {
            originalQuery: query,
            mode: settings.rankingMode,
            gateDecision,
            onTrace: (trace) => {
              updateRerankDiagnostics(flow, {
                selectedPath: trace.selectedPath,
                appliedPath: trace.appliedPath,
                gateState: trace.state,
                fallbackReason: trace.fallbackReason,
                selectionReason: trace.selectedPath === 'transformer' ? 'gate_transformer' : 'gate_skipped',
                candidateCount: candidates.length,
                headCount: head.length,
                tailCount: tail.length,
                gateDecision,
                reasonCode: trace.reasonCode,
                runtimeId: trace.runtimeId,
                modelId: trace.modelId,
              });
            },
          }),
          effectiveRerankTimeoutMs,
          rerankResults(head, { originalQuery: query, mode: settings.rankingMode })
        );
        rerankedHead = heuristicResult.value;
        if (heuristicResult.timedOut) {
          incCounter(
            'context_engine_retrieval_rerank_fail_open_total',
            { reason: 'timeout_or_empty', reranker: 'heuristic' },
            1,
            'Rerank fail-open fallbacks.'
          );
          updateRerankDiagnostics(flow, {
            selectedPath: 'transformer',
            appliedPath: 'heuristic',
            gateState: 'fail_open',
            fallbackReason: 'rerank_timeout_or_empty',
            selectionReason: 'gate_transformer',
            candidateCount: candidates.length,
            headCount: head.length,
            tailCount: tail.length,
            gateDecision,
            reasonCode: 'transformer_timeout',
          });
          noteRetrievalStage(flow, 'rerank:fail_open');
        }
      }
    }

    observeDurationMs(
      'context_engine_retrieval_rerank_duration_seconds',
      { reranker: settings.reranker?.id ?? 'heuristic' },
      Date.now() - stageStart,
      { help: 'Retrieval rerank stage duration in seconds.' }
    );
    noteRetrievalStage(flow, 'rerank:completed');
    return [...rerankedHead, ...tail];
  } catch {
    incCounter(
      'context_engine_retrieval_rerank_fail_open_total',
      { reason: 'error', reranker: settings.reranker?.id ?? 'heuristic' },
      1,
      'Rerank fail-open fallbacks.'
    );
    updateRerankDiagnostics(flow, {
      selectedPath: settings.reranker ? 'provider' : gateDecision.shouldUseTransformerRerank ? 'transformer' : 'heuristic',
      appliedPath: settings.reranker ? 'original_order' : gateDecision.shouldUseTransformerRerank ? 'heuristic' : 'heuristic',
      gateState: 'fail_open',
      fallbackReason: 'rerank_error',
      selectionReason: settings.reranker ? 'external_provider' : gateDecision.shouldUseTransformerRerank ? 'gate_transformer' : 'gate_skipped',
      candidateCount: candidates.length,
      headCount: head.length,
      tailCount: tail.length,
      gateDecision,
      providerId: settings.reranker?.id,
      reasonCode: settings.reranker ? 'provider_error' : 'unexpected_error',
    });
    noteRetrievalStage(flow, 'rerank:fail_open');
    return candidates;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (!timeoutMs) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function withTimeoutState<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<{ value: T; timedOut: boolean }> {
  if (!timeoutMs) {
    return { value: await promise, timedOut: false };
  }

  return new Promise<{ value: T; timedOut: boolean }>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: fallback, timedOut: true });
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function buildExpandedQueries(query: string, options: NormalizedRetrievalOptions): ExpandedQuery[] {
  if (!options.enableExpansion) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  const expanded = expandQuery(query, options.maxVariants, {
    mode: options.rewriteMode,
    profile: options.profile,
  });
  if (expanded.length === 0) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  return expanded;
}

function resolveFusionWeights(
  query: string,
  settings: NormalizedRetrievalOptions
): Pick<NormalizedRetrievalOptions, 'semanticWeight' | 'lexicalWeight' | 'denseWeight'> {
  if (!settings.enableLexical || !isIdentifierLikeQuery(query)) {
    return {
      semanticWeight: settings.semanticWeight,
      lexicalWeight: settings.lexicalWeight,
      denseWeight: settings.denseWeight,
    };
  }

  const denseWeight = settings.enableDense ? settings.denseWeight : 0;
  const remaining = Math.max(0, 1 - denseWeight);
  return {
    semanticWeight: remaining * 0.3,
    lexicalWeight: remaining * 0.7,
    denseWeight,
  };
}

function resolveDenseProvider(
  settings: NormalizedRetrievalOptions,
  serviceClient: ContextServiceClient
): RetrievalOptions['denseProvider'] | undefined {
  if (!settings.enableDense) return undefined;
  if (settings.denseProvider) return settings.denseProvider;

  const workspacePath = typeof (serviceClient as unknown as { workspacePath?: unknown }).workspacePath === 'string'
    ? ((serviceClient as unknown as { workspacePath: string }).workspacePath)
    : process.cwd();

  const embeddingRuntime = featureEnabled('retrieval_lancedb_v1')
    ? getConfiguredEmbeddingRuntime({
        fallbackRuntime: createHashEmbeddingRuntime(32),
      })
    : getConfiguredEmbeddingRuntime({
        fallbackRuntime: createHashEmbeddingRuntime(),
      });
  if (featureEnabled('retrieval_lancedb_v1')) {
    return createWorkspaceLanceDbVectorRetriever({
      workspacePath,
      embeddingRuntime,
    });
  }

  return createWorkspaceDenseRetriever({
    workspacePath,
    embeddingRuntime,
  });
}

export async function retrieve(
  query: string,
  serviceClient: ContextServiceClient,
  options?: RetrievalOptions
): Promise<SearchResult[]> {
  const requestedSettings = normalizeOptions(options);
  const preflightMemoryPressure = evaluateMemoryPressure();
  const { settings, applied: preflightGuardrails } = applyRetrievalMemoryGuardrails(
    requestedSettings,
    getRetrievalMemoryGuardrails(preflightMemoryPressure)
  );
  const flow = options?.flow ?? createRetrievalFlowContext(query, {
    signal: options?.signal,
    metadata: {
      topK: settings.topK,
      profile: settings.profile,
      rewriteMode: settings.rewriteMode,
      rankingMode: settings.rankingMode,
    },
  });

  return await runWithObservabilitySpan(
    'retrieval.pipeline',
    {
      attributes: {
        'retrieval.top_k': settings.topK,
        'retrieval.per_query_top_k': settings.perQueryTopK,
        'retrieval.max_variants': settings.maxVariants,
        'retrieval.fanout_concurrency': settings.fanoutConcurrency,
        'retrieval.profile': settings.profile,
        'retrieval.rewrite_mode': settings.rewriteMode,
        'retrieval.ranking_mode': settings.rankingMode,
        'retrieval.enable_expansion': settings.enableExpansion,
        'retrieval.enable_lexical': settings.enableLexical,
        'retrieval.enable_dense': settings.enableDense,
        'retrieval.enable_fusion': settings.enableFusion,
        'retrieval.enable_rerank': settings.enableRerank,
        'retrieval.bypass_cache': settings.bypassCache,
        'retrieval.query_length': query.length,
      },
    },
    async () => {
      flow.metadata.requestedFanoutConcurrency = requestedSettings.fanoutConcurrency;
      flow.metadata.effectiveFanoutConcurrency = settings.fanoutConcurrency;
      flow.metadata.requestedMaxVariants = requestedSettings.maxVariants;
      flow.metadata.effectiveMaxVariants = settings.maxVariants;
      flow.metadata.requestedRerankEnabled = requestedSettings.enableRerank;
      flow.metadata.effectiveRerankEnabled = settings.enableRerank;
      flow.metadata.requestedRerankBudgetMs = requestedSettings.rerankBudgetMs;
      flow.metadata.effectiveRerankBudgetMs = settings.rerankBudgetMs;
      flow.metadata.degradationFloor = resolveDegradationFloor(settings);
      flow.metadata.memoryPressureGuardrails = { ...preflightGuardrails };
      annotateMemoryPressure(flow, 'preflight', preflightMemoryPressure);
      setRetrievalTraceAttributes({
        'retrieval.degradation_floor': flow.metadata.degradationFloor,
        'retrieval.memory_pressure.preflight_level': preflightMemoryPressure.level,
      });
      noteRetrievalStage(flow, `memory_pressure:preflight:${preflightMemoryPressure.level}`);
      if (preflightGuardrails.fanoutConcurrencyCap !== undefined) {
        noteMemoryGuardrail(
          flow,
          'preflight',
          preflightMemoryPressure.level,
          'fanout_concurrency_cap',
          preflightGuardrails.fanoutConcurrencyCap
        );
      }
      if (preflightGuardrails.maxVariantsCap !== undefined) {
        noteMemoryGuardrail(
          flow,
          'preflight',
          preflightMemoryPressure.level,
          'max_variants_cap',
          preflightGuardrails.maxVariantsCap
        );
      }
      if (preflightGuardrails.disableRerank) {
        noteMemoryGuardrail(flow, 'preflight', preflightMemoryPressure.level, 'rerank_disabled');
      }
      noteRetrievalStage(flow, 'start');
      assertRetrievalFlowActive(flow, 'start');
      const semanticSearchOptions =
        settings.bypassCache
        || settings.maxOutputLength !== undefined
        || settings.includePaths !== undefined
        || settings.excludePaths !== undefined
          ? {
              bypassCache: settings.bypassCache,
              maxOutputLength: settings.maxOutputLength,
              includePaths: settings.includePaths,
              excludePaths: settings.excludePaths,
            }
          : undefined;
      const semanticSearch = (q: string, k: number) =>
        semanticSearchOptions
          ? serviceClient.semanticSearch(q, k, semanticSearchOptions)
          : serviceClient.semanticSearch(q, k);

      if (!isRetrievalPipelineEnabled()) {
        noteRetrievalStage(flow, 'legacy_semantic_path');
        noteRetrievalStage(flow, 'complete');
        const legacyResults = await withAsyncStageTiming(
          flow,
          'legacy_semantic_path',
          () => semanticSearch(query, settings.topK)
        );
        setRetrievalTraceAttributes({
          'retrieval.result_count': legacyResults.length,
          'retrieval.flow_stage_count': flow.stages.length,
        });
        return legacyResults;
      }

      let graphContext = await buildRetrievalGraphContext(query, serviceClient);
      flow.metadata.graphStatus = graphContext.graphStatus;
      flow.metadata.graphDegradedReason = graphContext.graphDegradedReason;
      flow.metadata.graphSeedSymbols = graphContext.seedSymbols.map((symbol) => symbol.name);
      flow.metadata.graphNeighborPaths = graphContext.neighborPaths;
      noteRetrievalStage(flow, `graph:status:${graphContext.graphStatus}`);
      if (graphContext.seedSymbols.length > 0) {
        noteRetrievalStage(flow, `graph:seed_symbols:${graphContext.seedSymbols.length}`);
      }
      const expandedQueries = withStageTiming(flow, 'expand_queries', () =>
        mergeExpandedQueriesWithGraph(buildExpandedQueries(query, settings), graphContext)
      );
      setRetrievalTraceAttributes({ 'retrieval.expanded_query_count': expandedQueries.length });
      noteRetrievalStage(flow, `expanded_queries:${expandedQueries.length}`);
      assertRetrievalFlowActive(flow, 'expanded_queries');
      const semanticCandidates: InternalSearchResult[] = [];
      const lexicalCandidates: InternalSearchResult[] = [];
      const denseCandidates: InternalSearchResult[] = [];
      const denseProvider = resolveDenseProvider(settings, serviceClient);
      const localKeywordSearch = (serviceClient as ContextServiceClient & {
        localKeywordSearch?: (
          input: string,
          topK: number,
          options?: { includePaths?: string[]; excludePaths?: string[]; bypassCache?: boolean }
        ) => Promise<SearchResult[]>;
      }).localKeywordSearch;
      const enabledBackends: FanoutBackend[] = ['semantic'];
      if (settings.enableLexical && typeof localKeywordSearch === 'function') {
        enabledBackends.push('lexical');
      }
      if (settings.enableDense && denseProvider) {
        enabledBackends.push('dense');
      }
      const plannedFanoutTasks = expandedQueries.length * enabledBackends.length;
      const limiter = createLocalSemaphore(settings.fanoutConcurrency);
      const syncFanoutDiagnostics = () => {
        const snapshot = limiter.snapshot();
        updateFanoutDiagnostics(flow, {
          backends: enabledBackends,
          variantCount: expandedQueries.length,
          plannedTasks: plannedFanoutTasks,
          snapshot,
        });
        setRetrievalTraceAttributes({
          'retrieval.fanout.backend_count': enabledBackends.length,
          'retrieval.fanout.variant_count': expandedQueries.length,
          'retrieval.fanout.planned_tasks': plannedFanoutTasks,
          'retrieval.fanout.active': snapshot.active,
          'retrieval.fanout.max_active': snapshot.maxActive,
          'retrieval.fanout.queued': snapshot.queued,
          'retrieval.fanout.max_queued': snapshot.maxQueued,
        });
      };
      syncFanoutDiagnostics();
      noteRetrievalStage(flow, `fanout:cap:${settings.fanoutConcurrency}`);
      noteRetrievalStage(flow, `fanout:planned:${plannedFanoutTasks}`);

      const runFanoutSearch = <T extends SearchResult[]>(
        backend: FanoutBackend,
        variant: ExpandedQuery,
        operation: () => Promise<T>
      ): Promise<T> => {
        const queuedAt = Date.now();
        const pending = limiter.run(async () => {
          const queueWaitMs = Date.now() - queuedAt;
          observeDurationMs(
            RETRIEVAL_FANOUT_QUEUE_WAIT_METRIC,
            { backend },
            queueWaitMs,
            { help: 'Retrieval fanout task queue wait time in seconds.' }
          );
          assertRetrievalFlowActive(flow, `variant:${variant.index}:${backend}`);
          syncFanoutDiagnostics();
          return await runWithObservabilitySpan(
            'retrieval.fanout_backend',
            {
              attributes: {
                'retrieval.backend': backend,
                'retrieval.variant_index': variant.index,
                'retrieval.variant_source': variant.source,
                'retrieval.variant_weight': variant.weight,
                'retrieval.queue_wait_ms': queueWaitMs,
              },
            },
            async (span) => {
              const executionStart = Date.now();
              try {
                const results = await operation();
                span?.setAttribute('retrieval.result_count', results.length);
                return results;
              } finally {
                const executionMs = Date.now() - executionStart;
                observeDurationMs(
                  RETRIEVAL_FANOUT_EXECUTION_METRIC,
                  { backend },
                  executionMs,
                  { help: 'Retrieval fanout task execution time in seconds.' }
                );
                span?.setAttribute('retrieval.execution_ms', executionMs);
                syncFanoutDiagnostics();
              }
            }
          );
        });
        syncFanoutDiagnostics();
        return pending;
      };

      const perVariantResults = await withAsyncStageTiming(
        flow,
        'fanout',
        async () => Promise.all(
          expandedQueries.map(async (variant) => {
            assertRetrievalFlowActive(flow, `variant:${variant.index}`);
            const semanticPromise = runFanoutSearch(
              'semantic',
              variant,
              () => withTimeout(
                semanticSearch(variant.query, settings.perQueryTopK),
                settings.timeoutMs,
                []
              ).catch((error) => {
                if (settings.log) {
                  console.error(`[retrieve] Failed variant \"${variant.query}\":`, error);
                }
                return [] as SearchResult[];
              })
            );

            const lexicalPromise = settings.enableLexical && typeof localKeywordSearch === 'function'
              ? runFanoutSearch(
                  'lexical',
                  variant,
                  () => withTimeout(
                    localKeywordSearch(variant.query, settings.perQueryTopK, {
                      includePaths: settings.includePaths,
                      excludePaths: settings.excludePaths,
                      bypassCache: settings.bypassCache,
                    }),
                    settings.timeoutMs,
                    []
                  ).catch((error) => {
                    if (settings.log) {
                      console.error(`[retrieve] Lexical retrieval failed for variant \"${variant.query}\":`, error);
                    }
                    return [] as SearchResult[];
                  })
                )
              : Promise.resolve([] as SearchResult[]);

            const densePromise = settings.enableDense && denseProvider
              ? runFanoutSearch(
                  'dense',
                  variant,
                  () => withTimeout(
                    denseProvider.search(variant.query, settings.perQueryTopK),
                    settings.timeoutMs,
                    []
                  ).catch((error) => {
                    if (settings.log) {
                      console.error(`[retrieve] Dense retrieval failed for variant \"${variant.query}\":`, error);
                    }
                    return [] as SearchResult[];
                  })
                )
              : Promise.resolve([] as SearchResult[]);

            noteRetrievalStage(flow, `variant:${variant.index}:started`);
            const [semanticResults, lexicalResults, denseResults] = await Promise.all([
              semanticPromise,
              lexicalPromise,
              densePromise,
            ]);
            noteRetrievalStage(flow, `variant:${variant.index}:completed`);

            return { variant, semanticResults, lexicalResults, denseResults };
          })
        )
      );
      syncFanoutDiagnostics();
      if (limiter.snapshot().queuedEvents > 0) {
        noteRetrievalStage(flow, 'fanout:queued');
      }
      noteRetrievalStage(flow, `fanout:max_in_flight:${limiter.snapshot().maxActive}`);

      noteRetrievalStage(flow, 'collected_variants');
      withStageTiming(flow, 'collect_candidates', () => {
        for (const { variant, semanticResults, lexicalResults, denseResults } of perVariantResults) {
          for (const result of semanticResults) {
            const semanticScore = result.relevanceScore ?? result.score ?? 0;
            semanticCandidates.push({
              ...result,
              retrievalSource: 'semantic',
              semanticScore,
              combinedScore: semanticScore,
              queryVariant: variant.query,
              variantIndex: variant.index,
              variantWeight: variant.weight,
            });
          }

          if (lexicalResults.length > 0) {
            lexicalCandidates.push(...scoreLexicalCandidates(lexicalResults, {
              query: variant.query,
              queryVariant: variant.query,
              variantIndex: variant.index,
              variantWeight: variant.weight,
            }));
          }

          if (denseResults.length > 0) {
            denseCandidates.push(...scoreDenseCandidates(denseResults, {
              queryVariant: variant.query,
              variantIndex: variant.index,
              variantWeight: variant.weight,
            }));
          }
        }
      });
      setRetrievalTraceAttributes({
        'retrieval.semantic_candidate_count': semanticCandidates.length,
        'retrieval.lexical_candidate_count': lexicalCandidates.length,
        'retrieval.dense_candidate_count': denseCandidates.length,
      });

      if (semanticCandidates.length === 0 && lexicalCandidates.length === 0 && denseCandidates.length === 0) {
        noteRetrievalStage(flow, 'complete');
        setRetrievalTraceAttributes({
          'retrieval.result_count': 0,
          'retrieval.flow_stage_count': flow.stages.length,
        });
        return [];
      }

      let processed: InternalSearchResult[] = applyGraphAwareRetrievalSignals(
        [...semanticCandidates, ...lexicalCandidates, ...denseCandidates],
        graphContext
      );
      flow.metadata.graphVariantCount = graphContext.graphVariants.length;
      if (graphContext.graphVariants.length > 0) {
        flow.metadata.graphExpandedQueries = graphContext.graphVariants.map((variant) => variant.query);
        noteRetrievalStage(flow, `graph:variants:${graphContext.graphVariants.length}`);
      }

      if (settings.enableDedupe) {
        noteRetrievalStage(flow, 'dedupe');
        processed = withStageTiming(flow, 'dedupe', () => {
          // Keep cross-source signals for fusion by deduping inside each source first.
          const dedupedSemantic = dedupeResults(
            processed.filter((candidate) => candidate.retrievalSource === 'semantic' || candidate.retrievalSource === 'hybrid')
          );
          const dedupedLexical = dedupeResults(
            processed.filter((candidate) => candidate.retrievalSource === 'lexical')
          );
          const dedupedDense = dedupeResults(
            processed.filter((candidate) => candidate.retrievalSource === 'dense')
          );
          return [...dedupedSemantic, ...dedupedLexical, ...dedupedDense];
        });
        setRetrievalTraceAttributes({ 'retrieval.post_dedupe_count': processed.length });
      }

      if (settings.enableFusion) {
        noteRetrievalStage(flow, 'fusion');
        const fusionWeights = resolveFusionWeights(query, settings);
        processed = withStageTiming(flow, 'fusion', () => fuseCandidates(processed, {
          semanticWeight: fusionWeights.semanticWeight,
          lexicalWeight: fusionWeights.lexicalWeight,
          denseWeight: fusionWeights.denseWeight,
        }));
        setRetrievalTraceAttributes({ 'retrieval.post_fusion_count': processed.length });
      }

      if (settings.enableRerank) {
        const preRerankMemoryPressure = evaluateMemoryPressure();
        annotateMemoryPressure(flow, 'pre_rerank', preRerankMemoryPressure);
        setRetrievalTraceAttributes({
          'retrieval.memory_pressure.pre_rerank_level': preRerankMemoryPressure.level,
        });
        noteRetrievalStage(flow, `memory_pressure:pre_rerank:${preRerankMemoryPressure.level}`);
        if (getRetrievalMemoryGuardrails(preRerankMemoryPressure).disableRerank) {
          flow.metadata.preRerankMemoryPressureGuardrails = { disableRerank: true };
          flow.metadata.effectiveRerankEnabled = false;
          noteMemoryGuardrail(flow, 'pre_rerank', preRerankMemoryPressure.level, 'rerank_disabled');
          noteRetrievalStage(flow, 'rerank:skipped:memory_pressure');
        } else {
          processed = await withAsyncStageTiming(flow, 'rerank', () => applyRerankStage(query, processed, settings, flow));
          setRetrievalTraceAttributes({ 'retrieval.post_rerank_count': processed.length });
        }
      } else {
        flow.metadata.effectiveRerankEnabled = false;
      }
      noteRetrievalStage(flow, 'complete');

      const finalResults = processed.slice(0, settings.topK);
      setRetrievalTraceAttributes({
        'retrieval.result_count': finalResults.length,
        'retrieval.flow_stage_count': flow.stages.length,
        'retrieval.effective_rerank_enabled': flow.metadata.effectiveRerankEnabled === true,
      });
      return finalResults;
    }
  );
}
