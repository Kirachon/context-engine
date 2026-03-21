import { envBool } from './env.js';

export interface FeatureFlags {
  /** Global rollout kill switch for retrieval pipeline optimizations. */
  rollout_kill_switch: boolean;
  /** Persist per-file index state store (JSON sidecar). */
  index_state_store: boolean;
  /** Skip indexing unchanged files (requires index_state_store). */
  skip_unchanged_indexing: boolean;
  /** Normalize EOL when hashing for incremental indexing. */
  hash_normalize_eol: boolean;
  /** Enable in-process metrics collection (Prometheus-format rendering). */
  metrics: boolean;
  /** Expose /metrics on the HTTP server when --http is enabled. */
  http_metrics: boolean;
  /** Enable retrieval query rewrite v2 behavior when selected by tools/options. */
  retrieval_rewrite_v2: boolean;
  /** Enable retrieval ranking signal v2 behavior when selected by tools/options. */
  retrieval_ranking_v2: boolean;
  /** Enable retrieval ranking signal v3 behavior when selected by tools/options. */
  retrieval_ranking_v3: boolean;
  /** Enable request-level retrieval memoization v2 cache keying path. */
  retrieval_request_memo_v2: boolean;
  /** Enable hybrid retrieval planner upgrades (semantic + keyword + symbol aware). */
  retrieval_hybrid_v1: boolean;
  /** Enable context pack v2 formatting and metadata. */
  context_packs_v2: boolean;
  /** Enable retrieval quality guard metadata and fallback policy state reporting. */
  retrieval_quality_guard_v1: boolean;
  /** Enable retrieval provider V2 migration seam hooks. */
  retrieval_provider_v2: boolean;
  /** Enable retrieval artifact V2 metadata generation and validation hooks. */
  retrieval_artifacts_v2: boolean;
  /** Enable retrieval shadow-control V2 policy hooks for canary migration. */
  retrieval_shadow_control_v2: boolean;
  /** Enable chunk-aware exact search gating for the next retrieval phase. */
  retrieval_chunk_search_v1: boolean;
}

export function getFeatureFlagsFromEnv(): FeatureFlags {
 return {
   rollout_kill_switch: envBool('CE_ROLLOUT_KILL_SWITCH', false),
   index_state_store: envBool('CE_INDEX_STATE_STORE', false),
   skip_unchanged_indexing: envBool('CE_SKIP_UNCHANGED_INDEXING', false),
   hash_normalize_eol: envBool('CE_HASH_NORMALIZE_EOL', false),
   metrics: envBool('CE_METRICS', false),
   http_metrics: envBool('CE_HTTP_METRICS', false),
   retrieval_rewrite_v2: envBool('CE_RETRIEVAL_REWRITE_V2', false),
   retrieval_ranking_v2: envBool('CE_RETRIEVAL_RANKING_V2', false),
   retrieval_ranking_v3: envBool('CE_RETRIEVAL_RANKING_V3', false),
   retrieval_request_memo_v2: envBool('CE_RETRIEVAL_REQUEST_MEMO_V2', false),
   retrieval_hybrid_v1: envBool('CE_RETRIEVAL_HYBRID_V1', false),
   context_packs_v2: envBool('CE_CONTEXT_PACKS_V2', false),
   retrieval_quality_guard_v1: envBool('CE_RETRIEVAL_QUALITY_GUARD_V1', false),
   retrieval_provider_v2: envBool('CE_RETRIEVAL_PROVIDER_V2', false),
   retrieval_artifacts_v2: envBool('CE_RETRIEVAL_ARTIFACTS_V2', false),
   retrieval_shadow_control_v2: envBool('CE_RETRIEVAL_SHADOW_CONTROL_V2', false),
   retrieval_chunk_search_v1: envBool('CE_RETRIEVAL_CHUNK_SEARCH_V1', false),
 };
}

export const FEATURE_FLAGS: FeatureFlags = getFeatureFlagsFromEnv();

export function featureEnabled(name: keyof FeatureFlags): boolean {
  return FEATURE_FLAGS[name];
}
