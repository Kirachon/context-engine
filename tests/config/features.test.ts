import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFeatureFlagsFromEnv, validateFlagCombinations } from '../../src/config/features.js';

const ORIGINAL_ENV = { ...process.env };
const FEATURE_ENV_VARS = [
  'CE_ROLLOUT_KILL_SWITCH',
  'CE_MEMORY_SUGGESTIONS_V1',
  'CE_MEMORY_DRAFT_RETRIEVAL_V1',
  'CE_MEMORY_AUTOSAVE_V1',
  'CE_INDEX_STATE_STORE',
  'CE_SKIP_UNCHANGED_INDEXING',
  'CE_HASH_NORMALIZE_EOL',
  'CE_METRICS',
  'CE_HTTP_METRICS',
  'CE_RETRIEVAL_REWRITE_V2',
  'CE_RETRIEVAL_RANKING_V2',
  'CE_RETRIEVAL_RANKING_V3',
  'CE_RETRIEVAL_REQUEST_MEMO_V2',
  'CE_RETRIEVAL_HYBRID_V1',
  'CE_CONTEXT_PACKS_V2',
  'CE_RETRIEVAL_QUALITY_GUARD_V1',
  'CE_RETRIEVAL_PROVIDER_V2',
  'CE_RETRIEVAL_ARTIFACTS_V2',
  'CE_RETRIEVAL_SHADOW_CONTROL_V2',
  'CE_RETRIEVAL_TREE_SITTER_V1',
  'CE_RETRIEVAL_CHUNK_SEARCH_V1',
  'CE_RETRIEVAL_DECLARATION_ROUTING_V1',
  'CE_RETRIEVAL_SQLITE_FTS5_V1',
  'CE_RETRIEVAL_LANCEDB_V1',
  'CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1',
  'CE_RETRIEVAL_CROSS_ENCODER_RERANK_V1',
  'CE_PERF_PROFILE',
  'CE_FEATURE_KILL_SWITCHES',
] as const;

function resetFeatureEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  for (const name of FEATURE_ENV_VARS) {
    delete process.env[name];
  }
}

async function loadFreshFeaturesModule() {
  jest.resetModules();
  return await import('../../src/config/features.js');
}

describe('feature flag env parsing', () => {
  beforeEach(() => {
    resetFeatureEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('defaults retrieval V2 migration flags to false', () => {
    const flags = getFeatureFlagsFromEnv();

    expect(flags.memory_suggestions_v1).toBe(false);
    expect(flags.memory_draft_retrieval_v1).toBe(false);
    expect(flags.memory_autosave_v1).toBe(false);
    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
    expect(flags.retrieval_tree_sitter_v1).toBe(false);
    expect(flags.retrieval_chunk_search_v1).toBe(false);
    expect(flags.retrieval_declaration_routing_v1).toBe(false);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(false);
    expect(flags.retrieval_lancedb_v1).toBe(false);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(false);
    expect(flags.retrieval_cross_encoder_rerank_v1).toBe(false);
  });

  it('parses retrieval V2 migration flags from env booleans', () => {
    process.env.CE_MEMORY_SUGGESTIONS_V1 = 'true';
    process.env.CE_MEMORY_DRAFT_RETRIEVAL_V1 = 'yes';
    process.env.CE_MEMORY_AUTOSAVE_V1 = '1';
    process.env.CE_RETRIEVAL_PROVIDER_V2 = '1';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'true';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'yes';
    process.env.CE_RETRIEVAL_TREE_SITTER_V1 = 'on';
    process.env.CE_RETRIEVAL_CHUNK_SEARCH_V1 = 'on';
    process.env.CE_RETRIEVAL_DECLARATION_ROUTING_V1 = 'true';
    process.env.CE_RETRIEVAL_SQLITE_FTS5_V1 = 'true';
    process.env.CE_RETRIEVAL_LANCEDB_V1 = 'true';
    process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1 = 'true';
    process.env.CE_RETRIEVAL_CROSS_ENCODER_RERANK_V1 = 'true';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.memory_suggestions_v1).toBe(true);
    expect(flags.memory_draft_retrieval_v1).toBe(true);
    expect(flags.memory_autosave_v1).toBe(true);
    expect(flags.retrieval_provider_v2).toBe(true);
    expect(flags.retrieval_artifacts_v2).toBe(true);
    expect(flags.retrieval_shadow_control_v2).toBe(true);
    expect(flags.retrieval_tree_sitter_v1).toBe(true);
    expect(flags.retrieval_chunk_search_v1).toBe(true);
    expect(flags.retrieval_declaration_routing_v1).toBe(true);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(true);
    expect(flags.retrieval_lancedb_v1).toBe(true);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(true);
    expect(flags.retrieval_cross_encoder_rerank_v1).toBe(true);
  });

  it('falls back to default false for invalid V2 migration flag values', () => {
    process.env.CE_MEMORY_SUGGESTIONS_V1 = 'later';
    process.env.CE_MEMORY_DRAFT_RETRIEVAL_V1 = 'maybe';
    process.env.CE_MEMORY_AUTOSAVE_V1 = 'definitely';
    process.env.CE_RETRIEVAL_PROVIDER_V2 = 'definitely';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'maybe';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'sometimes';
    process.env.CE_RETRIEVAL_TREE_SITTER_V1 = 'later';
    process.env.CE_RETRIEVAL_CHUNK_SEARCH_V1 = 'later';
    process.env.CE_RETRIEVAL_DECLARATION_ROUTING_V1 = 'later';
    process.env.CE_RETRIEVAL_SQLITE_FTS5_V1 = 'later';
    process.env.CE_RETRIEVAL_LANCEDB_V1 = 'later';
    process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1 = 'later';
    process.env.CE_RETRIEVAL_CROSS_ENCODER_RERANK_V1 = 'later';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.memory_suggestions_v1).toBe(false);
    expect(flags.memory_draft_retrieval_v1).toBe(false);
    expect(flags.memory_autosave_v1).toBe(false);
    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
    expect(flags.retrieval_tree_sitter_v1).toBe(false);
    expect(flags.retrieval_chunk_search_v1).toBe(false);
    expect(flags.retrieval_declaration_routing_v1).toBe(false);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(false);
    expect(flags.retrieval_lancedb_v1).toBe(false);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(false);
    expect(flags.retrieval_cross_encoder_rerank_v1).toBe(false);
  });

  it('preserves all-false defaults when the perf profile is unset or default', () => {
    const unsetFlags = getFeatureFlagsFromEnv();

    process.env.CE_PERF_PROFILE = 'default';
    const explicitDefaultFlags = getFeatureFlagsFromEnv();

    expect(unsetFlags).toEqual(explicitDefaultFlags);
    expect(Object.values(unsetFlags).every((value) => value === false)).toBe(true);
  });

  it('applies the fast perf profile bundle deterministically', () => {
    process.env.CE_PERF_PROFILE = 'fast';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.index_state_store).toBe(true);
    expect(flags.skip_unchanged_indexing).toBe(true);
    expect(flags.hash_normalize_eol).toBe(true);
    expect(flags.retrieval_request_memo_v2).toBe(true);
    expect(flags.retrieval_hybrid_v1).toBe(false);
    expect(flags.retrieval_lancedb_v1).toBe(false);
  });

  it('applies the quality perf profile bundle deterministically', () => {
    process.env.CE_PERF_PROFILE = 'quality';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.index_state_store).toBe(true);
    expect(flags.skip_unchanged_indexing).toBe(true);
    expect(flags.hash_normalize_eol).toBe(true);
    expect(flags.retrieval_rewrite_v2).toBe(true);
    expect(flags.retrieval_ranking_v3).toBe(true);
    expect(flags.retrieval_request_memo_v2).toBe(true);
    expect(flags.retrieval_hybrid_v1).toBe(true);
    expect(flags.context_packs_v2).toBe(true);
    expect(flags.retrieval_quality_guard_v1).toBe(true);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(true);
    expect(flags.retrieval_lancedb_v1).toBe(true);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(true);
    expect(flags.retrieval_cross_encoder_rerank_v1).toBe(false);
    expect(flags.retrieval_ranking_v2).toBe(false);
    expect(flags.retrieval_provider_v2).toBe(false);
  });

  it('lets explicit env vars override perf profile defaults', () => {
    process.env.CE_PERF_PROFILE = 'fast';
    process.env.CE_RETRIEVAL_REQUEST_MEMO_V2 = 'false';
    process.env.CE_RETRIEVAL_HYBRID_V1 = 'true';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_request_memo_v2).toBe(false);
    expect(flags.retrieval_hybrid_v1).toBe(true);
  });

  it('lets kill switches override profile defaults and direct enables', async () => {
    process.env.CE_PERF_PROFILE = 'quality';
    process.env.CE_RETRIEVAL_REQUEST_MEMO_V2 = 'true';
    process.env.CE_RETRIEVAL_HYBRID_V1 = 'true';
    process.env.CE_FEATURE_KILL_SWITCHES = 'retrieval_request_memo_v2, retrieval_hybrid_v1';

    const flags = getFeatureFlagsFromEnv();
    const { FEATURE_FLAGS, featureEnabled } = await loadFreshFeaturesModule();

    expect(flags.retrieval_request_memo_v2).toBe(false);
    expect(flags.retrieval_hybrid_v1).toBe(false);
    expect(FEATURE_FLAGS.retrieval_request_memo_v2).toBe(false);
    expect(featureEnabled('retrieval_request_memo_v2')).toBe(false);
  });

  it('rejects invalid perf profiles', () => {
    process.env.CE_PERF_PROFILE = 'turbo';

    expect(() => getFeatureFlagsFromEnv()).toThrow(
      'Invalid CE_PERF_PROFILE value "turbo". Allowed values: default, fast, quality'
    );
  });

  it('rejects unknown kill switch names', () => {
    process.env.CE_FEATURE_KILL_SWITCHES = 'retrieval_request_memo_v2, unknown_flag';

    expect(() => getFeatureFlagsFromEnv()).toThrow(
      'Invalid CE_FEATURE_KILL_SWITCHES value. Unknown feature flag(s): unknown_flag'
    );
  });

  it('rejects incompatible flag combinations deterministically', () => {
    process.env.CE_SKIP_UNCHANGED_INDEXING = 'true';
    process.env.CE_HTTP_METRICS = 'true';
    process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1 = 'true';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'true';

    const flags = getFeatureFlagsFromEnv();

    expect(() => validateFlagCombinations(flags)).toThrow(
      'Invalid feature flag configuration: skip_unchanged_indexing requires index_state_store; http_metrics requires metrics; retrieval_transformer_embeddings_v1 requires retrieval_lancedb_v1; retrieval_shadow_control_v2 requires retrieval_provider_v2'
    );
  });
});
