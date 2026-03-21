import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getFeatureFlagsFromEnv } from '../../src/config/features.js';

const ORIGINAL_ENV = { ...process.env };

describe('feature flag env parsing', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_RETRIEVAL_PROVIDER_V2;
    delete process.env.CE_RETRIEVAL_ARTIFACTS_V2;
    delete process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2;
    delete process.env.CE_RETRIEVAL_TREE_SITTER_V1;
    delete process.env.CE_RETRIEVAL_CHUNK_SEARCH_V1;
    delete process.env.CE_RETRIEVAL_SQLITE_FTS5_V1;
    delete process.env.CE_RETRIEVAL_LANCEDB_V1;
    delete process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults retrieval V2 migration flags to false', () => {
    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
    expect(flags.retrieval_tree_sitter_v1).toBe(false);
    expect(flags.retrieval_chunk_search_v1).toBe(false);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(false);
    expect(flags.retrieval_lancedb_v1).toBe(false);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(false);
  });

  it('parses retrieval V2 migration flags from env booleans', () => {
    process.env.CE_RETRIEVAL_PROVIDER_V2 = '1';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'true';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'yes';
    process.env.CE_RETRIEVAL_TREE_SITTER_V1 = 'on';
    process.env.CE_RETRIEVAL_CHUNK_SEARCH_V1 = 'on';
    process.env.CE_RETRIEVAL_SQLITE_FTS5_V1 = 'true';
    process.env.CE_RETRIEVAL_LANCEDB_V1 = 'true';
    process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1 = 'true';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(true);
    expect(flags.retrieval_artifacts_v2).toBe(true);
    expect(flags.retrieval_shadow_control_v2).toBe(true);
    expect(flags.retrieval_tree_sitter_v1).toBe(true);
    expect(flags.retrieval_chunk_search_v1).toBe(true);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(true);
    expect(flags.retrieval_lancedb_v1).toBe(true);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(true);
  });

  it('falls back to default false for invalid V2 migration flag values', () => {
    process.env.CE_RETRIEVAL_PROVIDER_V2 = 'definitely';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'maybe';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'sometimes';
    process.env.CE_RETRIEVAL_TREE_SITTER_V1 = 'later';
    process.env.CE_RETRIEVAL_CHUNK_SEARCH_V1 = 'later';
    process.env.CE_RETRIEVAL_SQLITE_FTS5_V1 = 'later';
    process.env.CE_RETRIEVAL_LANCEDB_V1 = 'later';
    process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1 = 'later';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
    expect(flags.retrieval_tree_sitter_v1).toBe(false);
    expect(flags.retrieval_chunk_search_v1).toBe(false);
    expect(flags.retrieval_sqlite_fts5_v1).toBe(false);
    expect(flags.retrieval_lancedb_v1).toBe(false);
    expect(flags.retrieval_transformer_embeddings_v1).toBe(false);
  });
});
