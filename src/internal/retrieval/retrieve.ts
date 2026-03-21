import { ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { envMs } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import { expandQuery } from './expandQuery.js';
import { dedupeResults } from './dedupe.js';
import { scoreDenseCandidates } from './dense.js';
import { createWorkspaceDenseRetriever } from './denseIndex.js';
import { createWorkspaceLanceDbVectorRetriever } from './lancedbVectorIndex.js';
import { createHashEmbeddingRuntime } from './embeddingRuntime.js';
import { fuseCandidates } from './fusion.js';
import {
  assertRetrievalFlowActive,
  createRetrievalFlowContext,
  finalizeRetrievalFlow,
  noteRetrievalStage,
  type RetrievalFlowContext,
} from './flow.js';
import { scoreLexicalCandidates } from './lexical.js';
import { rerankResults } from './rerank.js';
import { ExpandedQuery, InternalSearchResult, RetrievalOptions } from './types.js';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disable', 'disabled']);

type NormalizedRetrievalOptions =
  Omit<Required<RetrievalOptions>, 'bypassCache' | 'maxOutputLength' | 'denseProvider' | 'reranker' | 'signal' | 'flow'> & {
    bypassCache: boolean;
    maxOutputLength?: number;
    denseProvider?: RetrievalOptions['denseProvider'];
    reranker?: RetrievalOptions['reranker'];
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
  };
}

async function applyRerankStage(
  query: string,
  candidates: InternalSearchResult[],
  settings: NormalizedRetrievalOptions,
  flow: RetrievalFlowContext
): Promise<InternalSearchResult[]> {
  if (!settings.enableRerank || candidates.length <= 1) {
    noteRetrievalStage(flow, 'rerank:skipped');
    return candidates;
  }

  const topN = Math.min(settings.rerankTopN, candidates.length);
  const head = candidates.slice(0, topN);
  const tail = candidates.slice(topN);
  const stageStart = Date.now();
  noteRetrievalStage(flow, 'rerank:started');

  try {
    let rerankedHead: InternalSearchResult[];
    if (settings.reranker) {
      const providerResult = await withTimeout<InternalSearchResult[] | null>(
        settings.reranker.rerank(query, head, { timeoutMs: settings.rerankTimeoutMs }),
        settings.rerankTimeoutMs,
        null
      );
      if (!providerResult || providerResult.length === 0) {
        incCounter(
          'context_engine_retrieval_rerank_fail_open_total',
          { reason: 'timeout_or_empty', reranker: settings.reranker.id },
          1,
          'Rerank fail-open fallbacks.'
        );
        return candidates;
      }
      rerankedHead = providerResult.slice(0, topN);
    } else {
      rerankedHead = rerankResults(head, { originalQuery: query, mode: settings.rankingMode });
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
    ? createHashEmbeddingRuntime(32)
    : createHashEmbeddingRuntime();
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
    settings.bypassCache || settings.maxOutputLength !== undefined
      ? { bypassCache: settings.bypassCache, maxOutputLength: settings.maxOutputLength }
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
    localKeywordSearch?: (input: string, topK: number) => Promise<SearchResult[]>;
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
            localKeywordSearch(variant.query, settings.perQueryTopK),
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
