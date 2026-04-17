import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { normalizePathScopeInput } from '../../mcp/tooling/pathScope.js';
import { retrieve } from '../retrieval/retrieve.js';
import { createRetrievalFlowContext, finalizeRetrievalFlow, noteRetrievalStage } from '../retrieval/flow.js';
import {
  computeQualityWarnings,
  emitQualityWarnings,
  type QualityWarning,
} from '../retrieval/rankingCalibration.js';
import {
  describeEmbeddingRuntimeSelection,
  describeEmbeddingRuntimeStatus,
  type EmbeddingRuntimeStatus,
} from '../retrieval/embeddingRuntime.js';
import type {
  InternalRetrieveOptions,
  InternalRetrieveResult,
  RankingDiagnostics,
  RetrievalRankingFallbackReason,
  RetrievalRerankGateState,
} from './types.js';
import { getInternalCache } from './performance.js';

const RETRIEVE_CACHE_KEY_VERSION = 'v2';

/**
 * Build an EmbeddingRuntimeStatus for quality-warning evaluation.
 *
 * When the transformer-embeddings feature flag is disabled, the hash runtime is the
 * *intended* backend — not a fallback — so we return a synthesized healthy snapshot
 * with configured === active (hash), which prevents `computeQualityWarnings` from
 * emitting a spurious `embedding_hash_fallback` warning on every request.
 *
 * When the flag is enabled but no runtime has been initialized yet, we still return
 * `undefined` so the guard will correctly flag the degraded-unknown state.
 */
function resolveRetrievalQualityStatus(): EmbeddingRuntimeStatus | undefined {
  const transformerEnabled = featureEnabled('retrieval_transformer_embeddings_v1');
  if (!transformerEnabled) {
    const selection = describeEmbeddingRuntimeSelection(false);
    return {
      state: 'healthy',
      configured: selection,
      active: selection,
      fallback: selection,
      loadFailures: 0,
      hashFallbackActive: false,
      downgrade: null,
    };
  }
  return describeEmbeddingRuntimeStatus(featureEnabled('retrieval_lancedb_v1'));
}

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => stableValue(item));
  }
  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const output: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      output[key] = stableValue(value);
    }
    return output;
  }
  return input;
}

function buildRetrieveCacheKey(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): string {
  const normalizedScope = normalizePathScopeInput({
    includePaths: options?.includePaths,
    excludePaths: options?.excludePaths,
  });
  const stableOptions = stableValue({
    ...(options ?? {}),
    includePaths: normalizedScope.includePaths,
    excludePaths: normalizedScope.excludePaths,
  });
  const workspaceScope =
    typeof (serviceClient as { getWorkspacePath?: unknown }).getWorkspacePath === 'function'
      ? (serviceClient as { getWorkspacePath: () => string }).getWorkspacePath()
      : 'unknown-workspace';
  return `retrieve:${RETRIEVE_CACHE_KEY_VERSION}:${workspaceScope}:${query}:${JSON.stringify(stableOptions)}`;
}

function stripFlowMetadata(result: InternalRetrieveResult): InternalRetrieveResult {
  const { flow: _flow, ...cacheable } = result;
  return cacheable;
}

type RetrievalSignals = {
  queryMode: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents: Array<'semantic' | 'keyword' | 'dense'>;
};

function summarizeSignals(results: Array<{ matchType?: string; retrievalSource?: string }>): RetrievalSignals {
  const components = new Set<'semantic' | 'keyword' | 'dense'>();
  for (const result of results) {
    const source = (result.retrievalSource ?? result.matchType ?? '').toLowerCase();
    if (source === 'hybrid') {
      components.add('semantic');
      components.add('keyword');
      continue;
    }
    if (source === 'semantic') components.add('semantic');
    if (source === 'keyword' || source === 'lexical') components.add('keyword');
    if (source === 'dense') components.add('dense');
  }
  if (components.size === 0) {
    components.add('semantic');
  }
  const queryMode: RetrievalSignals['queryMode'] =
    components.has('semantic') && (components.has('keyword') || components.has('dense'))
      ? 'hybrid'
      : components.has('keyword')
        ? 'keyword'
        : 'semantic';
  return { queryMode, hybridComponents: Array.from(components.values()) };
}

function getScoreValue(result: { relevanceScore?: number; score?: number }): number {
  return result.relevanceScore ?? result.score ?? 0;
}

function computeScoreSpread(results: Array<{ relevanceScore?: number; score?: number }>): number {
  if (results.length <= 1) {
    return getScoreValue(results[0] ?? {});
  }
  const top = getScoreValue(results[0] ?? {});
  const runnerUp = getScoreValue(results[1] ?? {});
  return Math.max(0, top - runnerUp);
}

function normalizeRetrievalSource(source: string | undefined): 'semantic' | 'keyword' | 'dense' {
  const normalized = (source ?? '').toLowerCase();
  if (normalized === 'keyword' || normalized === 'lexical') {
    return 'keyword';
  }
  if (normalized === 'dense') {
    return 'dense';
  }
  return 'semantic';
}

function computeSourceConsensus(results: Array<{ matchType?: string; retrievalSource?: string }>): number {
  const consensus = new Set<'semantic' | 'keyword' | 'dense'>();
  for (const result of results.slice(0, 3)) {
    const source = normalizeRetrievalSource(result.retrievalSource ?? result.matchType);
    consensus.add(source);
  }
  return consensus.size;
}

function resolveRerankGateState(value: unknown): RetrievalRerankGateState {
  if (value === 'disabled' || value === 'skipped' || value === 'invoked' || value === 'fail_open') {
    return value;
  }
  return 'disabled';
}

function resolveFallbackReason(
  fallbackState: 'active' | 'inactive',
  rerankGateState: RetrievalRerankGateState,
  rerankFallbackReason: unknown
): RetrievalRankingFallbackReason {
  if (fallbackState === 'active') {
    return 'quality_guard';
  }
  if (rerankGateState === 'fail_open') {
    return rerankFallbackReason === 'error' ? 'rerank_error' : 'rerank_timeout';
  }
  return 'none';
}

function buildRankingDiagnostics(
  results: Array<{ relevanceScore?: number; score?: number; matchType?: string; retrievalSource?: string }>,
  metadata: {
    rankingMode?: string;
    fallbackState?: 'active' | 'inactive';
    rerankGateState?: unknown;
    rerankFallbackReason?: unknown;
  }
): RankingDiagnostics {
  const fallbackState = metadata.fallbackState ?? 'inactive';
  const rerankGateState = resolveRerankGateState(metadata.rerankGateState);
  return {
    rankingMode: metadata.rankingMode === 'v2' || metadata.rankingMode === 'v3' ? metadata.rankingMode : 'v1',
    scoreSpread: computeScoreSpread(results),
    sourceConsensus: computeSourceConsensus(results),
    fallbackState,
    fallbackReason: resolveFallbackReason(fallbackState, rerankGateState, metadata.rerankFallbackReason),
    rerankGateState,
  };
}

function shouldTriggerQualityGuardFallback(
  results: Array<{ relevanceScore?: number; score?: number }>
): boolean {
  if (results.length === 0) {
    return true;
  }
  const top = results.slice(0, Math.min(3, results.length));
  const avgTopScore = top.reduce((sum, item) => sum + (item.relevanceScore ?? item.score ?? 0), 0) / top.length;
  return avgTopScore < 0.2;
}

function mergeUniqueResults<
  T extends { path: string; lines?: string; relevanceScore?: number; score?: number }
>(primary: T[], fallback: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of [...primary, ...fallback]) {
    const key = `${item.path}:${item.lines ?? ''}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    const currentScore = current.relevanceScore ?? current.score ?? 0;
    const nextScore = item.relevanceScore ?? item.score ?? 0;
    if (nextScore > currentScore) {
      merged.set(key, item);
    }
  }
  return Array.from(merged.values());
}

function sortByScoreDesc<T extends { relevanceScore?: number; score?: number }>(results: T[]): T[] {
  return [...results].sort(
    (a, b) => (b.relevanceScore ?? b.score ?? 0) - (a.relevanceScore ?? a.score ?? 0)
  );
}

export async function internalRetrieveCode(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): Promise<InternalRetrieveResult> {
  const normalizedScope = normalizePathScopeInput({
    includePaths: options?.includePaths,
    excludePaths: options?.excludePaths,
  });
  const normalizedOptions = options
    ? {
        ...options,
        includePaths: normalizedScope.includePaths,
        excludePaths: normalizedScope.excludePaths,
      }
    : undefined;
  const qualityGuardEnabled = featureEnabled('retrieval_quality_guard_v1');

  const resolveResultWithOptionalFallback = async (): Promise<InternalRetrieveResult> => {
    const start = Date.now();
    const flow = createRetrievalFlowContext(query, {
      signal: options?.signal,
      metadata: {
        cacheHit: false,
        qualityGuardEnabled,
        topK: normalizedOptions?.topK ?? 10,
      },
    });
    let results = await retrieve(query, serviceClient, {
      ...normalizedOptions,
      flow,
    });
    let fallbackState: InternalRetrieveResult['fallbackState'] = 'inactive';

    if (qualityGuardEnabled && shouldTriggerQualityGuardFallback(results)) {
      try {
        const fallbackResults = typeof serviceClient.localKeywordSearch === 'function'
          ? await serviceClient.localKeywordSearch(query, normalizedOptions?.topK ?? 10, {
              bypassCache: normalizedOptions?.bypassCache,
              includePaths: normalizedOptions?.includePaths,
              excludePaths: normalizedOptions?.excludePaths,
            })
          : normalizedOptions?.bypassCache
            ? await serviceClient.semanticSearch(query, normalizedOptions?.topK ?? 10, {
                bypassCache: true,
                includePaths: normalizedOptions?.includePaths,
                excludePaths: normalizedOptions?.excludePaths,
              })
            : await serviceClient.semanticSearch(query, normalizedOptions?.topK ?? 10, {
                includePaths: normalizedOptions?.includePaths,
                excludePaths: normalizedOptions?.excludePaths,
              });
        results = sortByScoreDesc(mergeUniqueResults(results, fallbackResults)).slice(
          0,
          normalizedOptions?.topK ?? 10
        );
        fallbackState = 'active';
      } catch {
        // Fail open: keep original retrieval output.
      }
    }

    const signals = summarizeSignals(results as Array<{ matchType?: string; retrievalSource?: string }>);
    const rankingDiagnostics = buildRankingDiagnostics(results as Array<{
      relevanceScore?: number;
      score?: number;
      matchType?: string;
      retrievalSource?: string;
    }>, {
      rankingMode: normalizedOptions?.rankingMode,
      fallbackState,
      rerankGateState: flow.metadata.rerankGateState,
      rerankFallbackReason: flow.metadata.rerankFallbackReason,
    });
    noteRetrievalStage(flow, 'handler:complete');

    // p2-calibrate quality guard: surface silent downgrades on every request.
    // Computed here (post-retrieve) so we can observe the actual rerank gate
    // state and embedding runtime status. Emitted via console.warn every call
    // — no caching/suppression — so operators can grep for degraded runs.
    const rerankGateState = resolveRerankGateState(flow.metadata.rerankGateState);
    const rerankEnabled = rerankGateState === 'invoked' || rerankGateState === 'fail_open';
    const rerankFallbackReason =
      typeof flow.metadata.rerankFallbackReason === 'string'
        ? (flow.metadata.rerankFallbackReason as string)
        : undefined;
    const qualityWarnings: QualityWarning[] = computeQualityWarnings({
      embeddingRuntimeStatus: resolveRetrievalQualityStatus(),
      rerankEnabled,
      rerankFallbackReason,
    });
    emitQualityWarnings(qualityWarnings);

    return {
      query,
      elapsedMs: Date.now() - start,
      results,
      queryMode: signals.queryMode,
      hybridComponents: signals.hybridComponents,
      qualityGuardState: qualityGuardEnabled ? 'enabled' : 'disabled',
      fallbackState,
      rankingDiagnostics,
      flow: finalizeRetrievalFlow(flow, {
        cacheHit: false,
        qualityGuardEnabled,
        fallbackState,
        queryMode: signals.queryMode,
        rankingDiagnostics,
        qualityWarnings,
      }),
    };
  };

  if (normalizedOptions?.bypassCache) {
    return resolveResultWithOptionalFallback();
  }

  const cache = getInternalCache();
  const cacheKey = buildRetrieveCacheKey(query, serviceClient, normalizedOptions);
  const cached = cache.get<InternalRetrieveResult>(cacheKey);
  if (cached) {
    const cacheFlow = createRetrievalFlowContext(query, {
      signal: normalizedOptions?.signal,
      metadata: {
        cacheHit: true,
        cacheKeyVersion: RETRIEVE_CACHE_KEY_VERSION,
        qualityGuardEnabled,
      },
    });
    noteRetrievalStage(cacheFlow, 'cache_hit');
    noteRetrievalStage(cacheFlow, 'complete');
    // p2-calibrate: re-compute + re-emit quality warnings on every cache hit
    // so silent downgrades stay visible even when the result payload itself
    // comes from cache.
    // Emit quality warnings on cache hits too, reading from rankingDiagnostics
    // (which survives caching) rather than `flow` (which `stripFlowMetadata` removes).
    const cachedRerankGateState = resolveRerankGateState(
      cached.rankingDiagnostics?.rerankGateState
    );
    const cachedRerankEnabled =
      cachedRerankGateState === 'invoked' || cachedRerankGateState === 'fail_open';
    const cachedRerankFallbackReason =
      typeof cached.rankingDiagnostics?.fallbackReason === 'string' &&
      cached.rankingDiagnostics.fallbackReason !== 'none'
        ? cached.rankingDiagnostics.fallbackReason
        : undefined;
    const cacheQualityWarnings: QualityWarning[] = computeQualityWarnings({
      embeddingRuntimeStatus: resolveRetrievalQualityStatus(),
      rerankEnabled: cachedRerankEnabled,
      rerankFallbackReason: cachedRerankFallbackReason,
    });
    emitQualityWarnings(cacheQualityWarnings);
    return {
      ...cached,
      flow: finalizeRetrievalFlow(cacheFlow, {
        cacheHit: true,
        cacheKeyVersion: RETRIEVE_CACHE_KEY_VERSION,
        qualityWarnings: cacheQualityWarnings,
      }),
    };
  }

  const output = await resolveResultWithOptionalFallback();
  cache.set(cacheKey, stripFlowMetadata(output));
  return output;
}
