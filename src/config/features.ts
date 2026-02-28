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
}

export function getFeatureFlagsFromEnv(): FeatureFlags {
 return {
   rollout_kill_switch: envBool('CE_ROLLOUT_KILL_SWITCH', false),
   index_state_store: envBool('CE_INDEX_STATE_STORE', false),
   skip_unchanged_indexing: envBool('CE_SKIP_UNCHANGED_INDEXING', false),
   hash_normalize_eol: envBool('CE_HASH_NORMALIZE_EOL', false),
   metrics: envBool('CE_METRICS', false),
   http_metrics: envBool('CE_HTTP_METRICS', false),
 };
}

export const FEATURE_FLAGS: FeatureFlags = getFeatureFlagsFromEnv();

export function featureEnabled(name: keyof FeatureFlags): boolean {
  return FEATURE_FLAGS[name];
}
