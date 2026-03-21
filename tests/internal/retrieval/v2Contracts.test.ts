import { afterEach, describe, expect, it } from '@jest/globals';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import {
  buildRetrievalArtifactV2Metadata,
  snapshotRetrievalV2FeatureFlags,
} from '../../../src/internal/retrieval/v2Contracts.js';

describe('retrieval v2 contracts', () => {
  const originalFlags = {
    retrieval_provider_v2: FEATURE_FLAGS.retrieval_provider_v2,
    retrieval_artifacts_v2: FEATURE_FLAGS.retrieval_artifacts_v2,
    retrieval_chunk_search_v1: FEATURE_FLAGS.retrieval_chunk_search_v1,
    retrieval_tree_sitter_v1: FEATURE_FLAGS.retrieval_tree_sitter_v1,
    retrieval_sqlite_fts5_v1: FEATURE_FLAGS.retrieval_sqlite_fts5_v1,
    retrieval_lancedb_v1: FEATURE_FLAGS.retrieval_lancedb_v1,
  };

  afterEach(() => {
    FEATURE_FLAGS.retrieval_provider_v2 = originalFlags.retrieval_provider_v2;
    FEATURE_FLAGS.retrieval_artifacts_v2 = originalFlags.retrieval_artifacts_v2;
    FEATURE_FLAGS.retrieval_chunk_search_v1 = originalFlags.retrieval_chunk_search_v1;
    FEATURE_FLAGS.retrieval_tree_sitter_v1 = originalFlags.retrieval_tree_sitter_v1;
    FEATURE_FLAGS.retrieval_sqlite_fts5_v1 = originalFlags.retrieval_sqlite_fts5_v1;
    FEATURE_FLAGS.retrieval_lancedb_v1 = originalFlags.retrieval_lancedb_v1;
  });

  it('snapshots retrieval-related feature flags deterministically', () => {
    FEATURE_FLAGS.retrieval_provider_v2 = true;
    FEATURE_FLAGS.retrieval_artifacts_v2 = false;
    FEATURE_FLAGS.retrieval_chunk_search_v1 = true;
    FEATURE_FLAGS.retrieval_tree_sitter_v1 = false;
    FEATURE_FLAGS.retrieval_sqlite_fts5_v1 = true;
    FEATURE_FLAGS.retrieval_lancedb_v1 = false;

    const snapshot = snapshotRetrievalV2FeatureFlags();

    expect(snapshot).toMatchObject({
      retrieval_provider_v2: true,
      retrieval_artifacts_v2: false,
      retrieval_chunk_search_v1: true,
      retrieval_tree_sitter_v1: false,
      retrieval_sqlite_fts5_v1: true,
      retrieval_lancedb_v1: false,
    });
  });

  it('builds a stable versioned artifact metadata envelope', () => {
    const first = buildRetrievalArtifactV2Metadata({
      retrieval_provider: 'local_native',
      workspace_path: 'D:/GitProjects/context-engine',
      index_fingerprint: 'fingerprint:abc123',
      fallback_domain: 'retrieval',
      fallback_reason: 'provider_empty_array',
      retrieval_engine_version: 'local-native-v1',
      parser_version: 'heuristic-boundary-v1',
      chunking_version: 1,
      embedding_model_id: 'hash-128',
      vector_dimension: 128,
    });

    const second = buildRetrievalArtifactV2Metadata({
      retrieval_provider: 'local_native',
      workspace_path: 'D:/GitProjects/context-engine',
      index_fingerprint: 'fingerprint:abc123',
      fallback_domain: 'retrieval',
      fallback_reason: 'provider_empty_array',
      retrieval_engine_version: 'local-native-v1',
      parser_version: 'heuristic-boundary-v1',
      chunking_version: 1,
      embedding_model_id: 'hash-128',
      vector_dimension: 128,
    });

    const changedWorkspace = buildRetrievalArtifactV2Metadata({
      retrieval_provider: 'local_native',
      workspace_path: 'D:/GitProjects/context-engine-alt',
      index_fingerprint: 'fingerprint:abc123',
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      artifact_schema_version: 1,
      retrieval_provider: 'local_native',
      retrieval_engine_version: 'local-native-v1',
      chunking_version: 1,
      parser_version: 'heuristic-boundary-v1',
      embedding_model_id: 'hash-128',
      vector_dimension: 128,
      index_fingerprint: 'fingerprint:abc123',
      fallback_domain: 'retrieval',
      fallback_reason: 'provider_empty_array',
    });
    expect(first.workspace_fingerprint).toMatch(/^workspace:/);
    expect(first.env_fingerprint).toMatch(/^env:/);
    expect(changedWorkspace.workspace_fingerprint).not.toBe(first.workspace_fingerprint);
  });
});
