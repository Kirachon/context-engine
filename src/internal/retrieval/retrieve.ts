import { ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { envMs } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import { expandQuery } from './expandQuery.js';
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
import {
  ExpandedQuery,
  InternalSearchResult,
  RetrievalOptions,
  type RankingGateDecision,
  type RankingGateSignals,
  type RankingFallbackReason,
} from './types.js';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disable', 'disabled']);

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
  | 'gate_skipped';

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

function normalizeOptions(options: RetrievalOptions | undefined): NormalizedRetrievalOptions {
  const topK = Math.max(1, Math.min(50, options?.topK ?? 10));
  const perQueryTopK = Math.max(1, Math.min(50, options?.perQueryTopK ?? topK));
  const maxVariants = Math.max(1, Math.min(6, options?.maxVariants ?? 4));
  const envTimeoutRaw = process.env.CONTEXT_ENGINE_RETRIEVAL_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw ? Number(envTimeoutRaw) : undefined;
  const timeoutMs = Math.max(
    0,
    Math.min(10000, options?.timeoutMs ?? envTimeout ?? 0)
  );
  const rerankTimeoutMs = envMs('CONTEXT_ENGINE_RERANK_TIMEOUT_MS', 80, { min: 10, max: 2000 });

  return {
    topK,
    perQueryTopK,
    maxVariants,
    timeoutMs,
    enableExpansion: options?.enableExpansion ?? true,
    enableDedupe: options?.enableDedupe ?? true,
    enableLexical: options?.enableLexical ?? true,
    enableDense: options?.enableDense ?? false,
    enableFusion: options?.enableFusion ?? true,
    enableRerank: options?.enableRerank ?? true,
    rerankTopN: Math.max(1, Math.min(100, options?.rerankTopN ?? 20)),
    rerankTimeoutMs: Math.max(10, Math.min(2000, options?.rerankTimeoutMs ?? rerankTimeoutMs)),
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
        settings.reranker.rerank(query, head, { timeoutMs: settings.rerankTimeoutMs }),
        settings.rerankTimeoutMs,
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
          settings.rerankTimeoutMs,
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
  const settings = normalizeOptions(options);
  const flow = options?.flow ?? createRetrievalFlowContext(query, {
    signal: options?.signal,
    metadata: {
      topK: settings.topK,
      profile: settings.profile,
      rewriteMode: settings.rewriteMode,
      rankingMode: settings.rankingMode,
    },
  });
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
    return semanticSearch(query, settings.topK);
  }

  const expandedQueries = buildExpandedQueries(query, settings);
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

  const perVariantResults = await Promise.all(
    expandedQueries.map(async (variant) => {
      assertRetrievalFlowActive(flow, `variant:${variant.index}`);
      const semanticPromise = withTimeout(
        semanticSearch(variant.query, settings.perQueryTopK),
        settings.timeoutMs,
        []
      ).catch((error) => {
        if (settings.log) {
          console.error(`[retrieve] Failed variant \"${variant.query}\":`, error);
        }
        return [] as SearchResult[];
      });

      const lexicalPromise = settings.enableLexical && typeof localKeywordSearch === 'function'
        ? withTimeout(
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
        : Promise.resolve([] as SearchResult[]);

      const densePromise = settings.enableDense && denseProvider
        ? withTimeout(
            denseProvider.search(variant.query, settings.perQueryTopK),
            settings.timeoutMs,
            []
          ).catch((error) => {
            if (settings.log) {
              console.error(`[retrieve] Dense retrieval failed for variant \"${variant.query}\":`, error);
            }
            return [] as SearchResult[];
        })
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
  );

  noteRetrievalStage(flow, 'collected_variants');
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
        query,
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

  if (semanticCandidates.length === 0 && lexicalCandidates.length === 0 && denseCandidates.length === 0) {
    noteRetrievalStage(flow, 'complete');
    return [];
  }

  let processed: InternalSearchResult[] = [...semanticCandidates, ...lexicalCandidates, ...denseCandidates];

  if (settings.enableDedupe) {
    noteRetrievalStage(flow, 'dedupe');
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
    processed = [...dedupedSemantic, ...dedupedLexical, ...dedupedDense];
  }

  if (settings.enableFusion) {
    noteRetrievalStage(flow, 'fusion');
    processed = fuseCandidates(processed, {
      semanticWeight: settings.semanticWeight,
      lexicalWeight: settings.lexicalWeight,
      denseWeight: settings.denseWeight,
    });
  }

  processed = await applyRerankStage(query, processed, settings, flow);
  noteRetrievalStage(flow, 'complete');

  return processed.slice(0, settings.topK);
}
