import { featureEnabled } from '../config/features.js';
import { envMs } from '../config/env.js';
import {
  buildRetrievalArtifactV2Metadata,
  snapshotRetrievalV2FeatureFlags,
  type RetrievalFallbackDomain,
} from '../internal/retrieval/v2Contracts.js';
import {
  describeEmbeddingRuntimeSelection,
} from '../internal/retrieval/embeddingRuntime.js';
import { searchWithSemanticRuntime } from '../retrieval/providers/semanticRuntime.js';
import { shouldRunShadowCompare } from '../retrieval/providers/env.js';
import type {
  RetrievalProviderCallbackContext,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from '../retrieval/providers/types.js';
import type {
  IndexResult,
  IndexStatus,
  RetrievalArtifactObservability,
  RetrievalRuntimeMetadata,
  SearchResult,
} from './serviceClient.js';

const MIN_API_TIMEOUT_MS = 1_000;
const MAX_API_TIMEOUT_MS = 30 * 60 * 1000;

export interface ServiceClientRetrievalSearchOptions {
  bypassCache?: boolean;
  maxOutputLength?: number;
  priority?: 'interactive' | 'background';
  includePaths?: string[];
  excludePaths?: string[];
}

export type ServiceClientRetrievalRuntimeMetadata = RetrievalRuntimeMetadata;
export type ServiceClientRetrievalArtifactObservability = RetrievalArtifactObservability;

export interface ServiceClientRetrievalArtifactMetadataOptions {
  retrievalProviderId: RetrievalProviderId;
  workspacePath: string;
  indexFingerprint: string;
  fallbackDomain?: RetrievalFallbackDomain;
  fallbackReason?: string | null;
}

export interface ServiceClientRetrievalProviderBindings {
  getRetrievalProviderId: () => RetrievalProviderId;
  searchWithProviderRuntime: (
    query: string,
    topK: number,
    options?: ServiceClientRetrievalSearchOptions
  ) => Promise<SearchResult[]>;
  indexWorkspaceLocalNativeFallback: () => Promise<IndexResult>;
  indexFilesLocalNativeFallback: (filePaths: string[]) => Promise<IndexResult>;
  clearIndexWithProviderRuntime: (options?: { localNative?: boolean }) => Promise<void>;
  getIndexStatus: () => Promise<IndexStatus>;
}

export interface ServiceClientSemanticRuntimeBindings {
  searchAndAsk: (
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
  ) => Promise<string>;
  keywordFallbackSearch: (
    query: string,
    topK: number,
    options?: { includePaths?: string[]; excludePaths?: string[] }
  ) => Promise<SearchResult[]>;
}

export function getConfiguredShadowCompareState(): { enabled: boolean; sampleRate: number } {
  const rawSampleRate = Number.parseFloat(process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE ?? '0');
  const sampleRate = Number.isFinite(rawSampleRate)
    ? Math.max(0, Math.min(1, rawSampleRate))
    : 0;

  return {
    enabled: process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED === 'true',
    sampleRate,
  };
}

export function shouldScheduleRetrievalShadowCompare(): boolean {
  const shadowCompare = getConfiguredShadowCompareState();
  return shouldRunShadowCompare({
    shadowCompareEnabled: shadowCompare.enabled,
    shadowSampleRate: shadowCompare.sampleRate,
  });
}

export function buildRetrievalRuntimeMetadata(
  retrievalProviderId: RetrievalProviderId
): ServiceClientRetrievalRuntimeMetadata {
  return {
    providerId: retrievalProviderId,
    shadowCompare: getConfiguredShadowCompareState(),
    v2: {
      retrievalRewriteV2: featureEnabled('retrieval_rewrite_v2'),
      retrievalRankingV2: featureEnabled('retrieval_ranking_v2'),
      retrievalRankingV3: featureEnabled('retrieval_ranking_v3'),
      retrievalRequestMemoV2: featureEnabled('retrieval_request_memo_v2'),
    },
  };
}

export function buildRetrievalArtifactMetadata(
  options: ServiceClientRetrievalArtifactMetadataOptions
): ServiceClientRetrievalArtifactObservability {
  const shadowCompare = getConfiguredShadowCompareState();
  const retrievalEngineVersion = featureEnabled('retrieval_lancedb_v1')
    ? 'lancedb-vector-v1'
    : 'local-native-v1';
  const embeddingRuntime = describeEmbeddingRuntimeSelection(featureEnabled('retrieval_lancedb_v1'));

  return {
    ...buildRetrievalArtifactV2Metadata({
      retrieval_provider: options.retrievalProviderId,
      workspace_path: options.workspacePath,
      index_fingerprint: options.indexFingerprint,
      feature_flags_snapshot: snapshotRetrievalV2FeatureFlags(),
      retrieval_engine_version: retrievalEngineVersion,
      embedding_model_id: embeddingRuntime.modelId,
      vector_dimension: embeddingRuntime.vectorDimension,
      fallback_domain: options.fallbackDomain ?? 'unknown',
      fallback_reason: options.fallbackReason ?? null,
    }),
    shadow_compare: {
      enabled: shadowCompare.enabled,
      sampleRate: shadowCompare.sampleRate,
    },
  };
}

export function resolveRetrievalProviderCallbackProviderId(
  retrievalProviderId: RetrievalProviderId,
  context?: RetrievalProviderCallbackContext
): RetrievalProviderId {
  return context?.providerId ?? retrievalProviderId;
}

export function buildRetrievalProviderCallbacks(
  bindings: ServiceClientRetrievalProviderBindings
): RetrievalProviderCallbacks {
  return {
    localNative: {
      search: (query, topK, options) => bindings.searchWithProviderRuntime(query, topK, options),
      indexWorkspace: () => bindings.indexWorkspaceLocalNativeFallback(),
      indexFiles: (filePaths) => bindings.indexFilesLocalNativeFallback(filePaths),
      clearIndex: () => bindings.clearIndexWithProviderRuntime({ localNative: true }),
      getIndexStatus: async () => bindings.getIndexStatus(),
      health: async (context?: RetrievalProviderCallbackContext) => ({
        ok: true,
        details: `retrieval_provider=${resolveRetrievalProviderCallbackProviderId(bindings.getRetrievalProviderId(), context)}`,
      }),
    },
  };
}

export async function runProviderSemanticRuntime(
  query: string,
  topK: number,
  options: ServiceClientRetrievalSearchOptions | undefined,
  bindings: ServiceClientSemanticRuntimeBindings
): Promise<SearchResult[]> {
  const semanticTimeoutMs = envMs('CE_SEMANTIC_SEARCH_AI_TIMEOUT_MS', 30_000, {
    min: MIN_API_TIMEOUT_MS,
    max: MAX_API_TIMEOUT_MS,
  });

  return searchWithSemanticRuntime(query, topK, {
    ...options,
    timeoutMs: semanticTimeoutMs,
  }, {
    searchAndAsk: (searchQuery, prompt, runtimeOptions) =>
      bindings.searchAndAsk(searchQuery, prompt, {
        timeoutMs: runtimeOptions?.timeoutMs ?? semanticTimeoutMs,
        priority: options?.priority === 'background' ? 'background' : 'interactive',
        signal: runtimeOptions?.signal,
      }),
    keywordFallbackSearch: (fallbackQuery, fallbackTopK) =>
      bindings.keywordFallbackSearch(fallbackQuery, fallbackTopK, {
        includePaths: options?.includePaths,
        excludePaths: options?.excludePaths,
      }),
  });
}
