import * as crypto from 'crypto';
import { FEATURE_FLAGS, type FeatureFlags } from '../../config/features.js';
import type { RetrievalProviderId } from '../../retrieval/providers/types.js';

export type RetrievalFallbackDomain = 'retrieval' | 'ai_provider' | 'unknown';

export interface RetrievalV2FeatureFlagsSnapshot {
  rollout_kill_switch: boolean;
  index_state_store: boolean;
  skip_unchanged_indexing: boolean;
  hash_normalize_eol: boolean;
  retrieval_rewrite_v2: boolean;
  retrieval_ranking_v2: boolean;
  retrieval_ranking_v3: boolean;
  retrieval_request_memo_v2: boolean;
  retrieval_hybrid_v1: boolean;
  context_packs_v2: boolean;
  retrieval_quality_guard_v1: boolean;
  retrieval_provider_v2: boolean;
  retrieval_artifacts_v2: boolean;
  retrieval_shadow_control_v2: boolean;
  retrieval_tree_sitter_v1: boolean;
  retrieval_chunk_search_v1: boolean;
  retrieval_sqlite_fts5_v1: boolean;
  retrieval_lancedb_v1: boolean;
}

export interface RetrievalArtifactV2Metadata {
  artifact_schema_version: number;
  retrieval_engine_version: string;
  chunking_version: number;
  parser_version: string;
  embedding_model_id: string;
  vector_dimension: number;
  retrieval_provider: RetrievalProviderId;
  workspace_fingerprint: string;
  index_fingerprint: string;
  feature_flags_snapshot: RetrievalV2FeatureFlagsSnapshot;
  env_fingerprint: string;
  fallback_domain: RetrievalFallbackDomain;
  fallback_reason: string | null;
}

export interface RetrievalArtifactV2BuildInput {
  retrieval_provider: RetrievalProviderId;
  workspace_path: string;
  index_fingerprint: string;
  feature_flags_snapshot?: RetrievalV2FeatureFlagsSnapshot;
  retrieval_engine_version?: string;
  chunking_version?: number;
  parser_version?: string;
  embedding_model_id?: string;
  vector_dimension?: number;
  env_fingerprint?: string;
  fallback_domain?: RetrievalFallbackDomain;
  fallback_reason?: string | null;
}

export interface RetrievalProviderV2 {
  id: RetrievalProviderId;
  search: (query: string, topK: number, options?: Record<string, unknown>) => Promise<unknown[]>;
  indexWorkspace: () => Promise<unknown>;
  indexFiles: (filePaths: string[]) => Promise<unknown>;
  clearIndex: () => Promise<void>;
  getIndexStatus: () => Promise<unknown>;
  health: (context?: Record<string, unknown>) => Promise<{ ok: boolean; details?: string }>;
}

export interface IndexStoreV2<TSnapshot extends Record<string, unknown> = Record<string, unknown>> {
  refresh: () => Promise<TSnapshot>;
  getSnapshot: () => TSnapshot;
  clear: () => Promise<void>;
}

export interface ChunkStoreV2<TChunk extends Record<string, unknown> = Record<string, unknown>> {
  refresh: () => Promise<Record<string, unknown>>;
  search: (query: string, topK: number, options?: Record<string, unknown>) => Promise<TChunk[]>;
  getSnapshot: () => Record<string, unknown>;
  clear: () => Promise<void>;
}

export interface RerankerV2<TCandidate extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  rerank: (query: string, candidates: TCandidate[], options?: { timeoutMs?: number }) => Promise<TCandidate[]>;
}

export interface SearchTelemetryV2 {
  artifact_schema_version: number;
  retrieval_provider: RetrievalProviderId;
  queue_wait_ms?: number;
  provider_execution_ms?: number;
  total_duration_ms?: number;
  fallback_domain?: RetrievalFallbackDomain;
  fallback_reason?: string | null;
}

function stableFingerprint(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function snapshotRetrievalV2FeatureFlags(
  featureFlags: FeatureFlags = FEATURE_FLAGS
): RetrievalV2FeatureFlagsSnapshot {
  return {
    rollout_kill_switch: featureFlags.rollout_kill_switch,
    index_state_store: featureFlags.index_state_store,
    skip_unchanged_indexing: featureFlags.skip_unchanged_indexing,
    hash_normalize_eol: featureFlags.hash_normalize_eol,
    retrieval_rewrite_v2: featureFlags.retrieval_rewrite_v2,
    retrieval_ranking_v2: featureFlags.retrieval_ranking_v2,
    retrieval_ranking_v3: featureFlags.retrieval_ranking_v3,
    retrieval_request_memo_v2: featureFlags.retrieval_request_memo_v2,
    retrieval_hybrid_v1: featureFlags.retrieval_hybrid_v1,
    context_packs_v2: featureFlags.context_packs_v2,
    retrieval_quality_guard_v1: featureFlags.retrieval_quality_guard_v1,
    retrieval_provider_v2: featureFlags.retrieval_provider_v2,
    retrieval_artifacts_v2: featureFlags.retrieval_artifacts_v2,
    retrieval_shadow_control_v2: featureFlags.retrieval_shadow_control_v2,
    retrieval_tree_sitter_v1: featureFlags.retrieval_tree_sitter_v1,
    retrieval_chunk_search_v1: featureFlags.retrieval_chunk_search_v1,
    retrieval_sqlite_fts5_v1: featureFlags.retrieval_sqlite_fts5_v1,
    retrieval_lancedb_v1: featureFlags.retrieval_lancedb_v1,
  };
}

export function buildRetrievalArtifactV2Metadata(
  input: RetrievalArtifactV2BuildInput
): RetrievalArtifactV2Metadata {
  const featureFlagsSnapshot = input.feature_flags_snapshot ?? snapshotRetrievalV2FeatureFlags();
  const retrievalEngineVersion = input.retrieval_engine_version ?? 'local-native-v1';
  const chunkingVersion = input.chunking_version ?? 1;
  const parserVersion = input.parser_version ?? 'heuristic-boundary-v1';
  const embeddingModelId = input.embedding_model_id ?? 'hash-128';
  const vectorDimension = input.vector_dimension ?? 128;
  const envFingerprint = input.env_fingerprint ?? stableFingerprint({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    flags: featureFlagsSnapshot,
  });

  return {
    artifact_schema_version: 1,
    retrieval_engine_version: retrievalEngineVersion,
    chunking_version: chunkingVersion,
    parser_version: parserVersion,
    embedding_model_id: embeddingModelId,
    vector_dimension: vectorDimension,
    retrieval_provider: input.retrieval_provider,
    workspace_fingerprint: `workspace:${stableFingerprint({ workspace_path: input.workspace_path })}`,
    index_fingerprint: input.index_fingerprint,
    feature_flags_snapshot: featureFlagsSnapshot,
    env_fingerprint: `env:${envFingerprint}`,
    fallback_domain: input.fallback_domain ?? 'unknown',
    fallback_reason: input.fallback_reason ?? null,
  };
}
