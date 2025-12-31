import { envBool } from './env.js';

export interface FeatureFlags {
  /** Persist per-file index state store (JSON sidecar). */
  index_state_store: boolean;
  /** Skip indexing unchanged files (requires index_state_store). */
  skip_unchanged_indexing: boolean;
  /** Normalize EOL when hashing for incremental indexing. */
  hash_normalize_eol: boolean;
}

export function getFeatureFlagsFromEnv(): FeatureFlags {
  return {
    index_state_store: envBool('CE_INDEX_STATE_STORE', false),
    skip_unchanged_indexing: envBool('CE_SKIP_UNCHANGED_INDEXING', false),
    hash_normalize_eol: envBool('CE_HASH_NORMALIZE_EOL', false),
  };
}

export const FEATURE_FLAGS: FeatureFlags = getFeatureFlagsFromEnv();

export function featureEnabled(name: keyof FeatureFlags): boolean {
  return FEATURE_FLAGS[name];
}

