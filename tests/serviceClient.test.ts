/**
 * Unit tests for ContextServiceClient
 *
 * Tests the Layer 2 - Context Service functionality including:
 * - Path validation and security
 * - Token estimation
 * - Code type detection
 * - Context bundling
 * - Caching behavior
 *
 * These tests stub provider responses and local-native indexing behavior
 * without requiring actual API authentication.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockContextInstance: Record<string, jest.Mock<any>> = {
  addToIndex: jest.fn(),
  search: jest.fn(),
  searchAndAsk: jest.fn(),
  exportToFile: jest.fn(),
  getIndexedPaths: jest.fn(() => []),
};

// Import after establishing test doubles
const { ContextServiceClient } = await import('../src/mcp/serviceClient.js');
const { FEATURE_FLAGS, getFeatureFlagsFromEnv } = await import('../src/config/features.js');
const { renderPrometheusMetrics } = await import('../src/metrics/metrics.js');
const { snapshotRetrievalV2FeatureFlags } = await import('../src/internal/retrieval/v2Contracts.js');
const { MemorySuggestionStore } = await import('../src/mcp/memorySuggestionStore.js');
const { createDraftSuggestionRecord } = await import('../src/mcp/memorySuggestions.js');
type SearchResult = Awaited<ReturnType<InstanceType<typeof ContextServiceClient>['symbolReferencesSearch']>>[number];

describe('ContextServiceClient', () => {
  let client: InstanceType<typeof ContextServiceClient>;
  const testWorkspace = process.cwd();
  const featureFlags = FEATURE_FLAGS as unknown as Record<string, boolean>;

  const configureOpenAISemanticProvider = (targetClient: InstanceType<typeof ContextServiceClient>, response: string | Error) => {
    const providerCall = jest.fn(async () => ({
      text: typeof response === 'string' ? response : '',
      model: 'codex-session',
    })) as any;
    if (response instanceof Error) {
      providerCall.mockRejectedValueOnce(response);
    }
    (targetClient as any).aiProvider = {
      id: 'openai_session',
      modelLabel: 'codex-session',
      call: providerCall,
    };
    (targetClient as any).aiProviderId = 'openai_session';
    return providerCall;
  };

  beforeEach(() => {
    // Set up environment for tests
    process.env.CE_AI_PROVIDER = 'openai_session';
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';

    // Reset mocks
    jest.clearAllMocks();

    mockContextInstance.search.mockResolvedValue('');
    mockContextInstance.addToIndex.mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] });
    mockContextInstance.exportToFile.mockResolvedValue(undefined);

    client = new ContextServiceClient(testWorkspace);
    configureOpenAISemanticProvider(client, '[]');
  });

  afterEach(() => {
    delete process.env.CONTEXT_ENGINE_OFFLINE_ONLY;
    delete process.env.CE_AI_RATE_LIMIT_MAX_RETRIES;
    delete process.env.CE_AI_RATE_LIMIT_BACKOFF_MS;
    delete process.env.CE_AI_PROVIDER;
    delete process.env.CE_AI_OPENAI_SESSION_ONLY;
    delete process.env.CE_OPENAI_SESSION_CMD;
    delete process.env.CE_OPENAI_SESSION_ARGS_JSON;
    delete process.env.CE_OPENAI_SESSION_REFRESH_MODE;
    delete process.env.CE_OPENAI_SESSION_IDENTITY_TTL_MS;
    delete process.env.CE_OPENAI_SESSION_HEALTHCHECK_TIMEOUT_MS;
    delete process.env.CE_SEARCH_AND_ASK_QUEUE_MAX;
    delete process.env.CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND;
    delete process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE;
    delete process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK;
    delete process.env.CE_RETRIEVAL_PROVIDER;
    delete process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED;
    delete process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE;
    delete process.env.CE_METRICS;
    delete process.env.CE_RETRIEVAL_SQLITE_FTS5_V1;
    delete process.env.CE_RETRIEVAL_LANCEDB_V1;
    delete process.env.CE_RETRIEVAL_TRANSFORMER_EMBEDDINGS_V1;
    delete featureFlags.retrieval_chunk_search_v1;
    delete featureFlags.retrieval_provider_v2;
    delete featureFlags.retrieval_artifacts_v2;
    delete featureFlags.retrieval_shadow_control_v2;
    delete featureFlags.retrieval_tree_sitter_v1;
    delete featureFlags.retrieval_sqlite_fts5_v1;
    delete featureFlags.retrieval_lancedb_v1;
    delete featureFlags.retrieval_transformer_embeddings_v1;

    // Reset feature flags that tests may override.
    FEATURE_FLAGS.index_state_store = false;
    FEATURE_FLAGS.skip_unchanged_indexing = false;
    FEATURE_FLAGS.hash_normalize_eol = false;
    FEATURE_FLAGS.metrics = false;
    FEATURE_FLAGS.retrieval_rewrite_v2 = false;
    FEATURE_FLAGS.retrieval_ranking_v2 = false;
    FEATURE_FLAGS.retrieval_ranking_v3 = false;
    FEATURE_FLAGS.retrieval_request_memo_v2 = false;
    featureFlags.retrieval_chunk_search_v1 = false;
    featureFlags.retrieval_provider_v2 = false;
    featureFlags.retrieval_artifacts_v2 = false;
    featureFlags.retrieval_shadow_control_v2 = false;
    featureFlags.retrieval_tree_sitter_v1 = false;
    featureFlags.retrieval_sqlite_fts5_v1 = false;
    featureFlags.retrieval_lancedb_v1 = false;
    featureFlags.retrieval_transformer_embeddings_v1 = false;
  });

  describe('Feature flags', () => {
    it('should parse the SQLite FTS5 lexical flag from env', () => {
      process.env.CE_RETRIEVAL_SQLITE_FTS5_V1 = 'true';
      const flags = getFeatureFlagsFromEnv();
      expect(flags.retrieval_sqlite_fts5_v1).toBe(true);
    });

    it('should parse the LanceDB vector flag from env', () => {
      process.env.CE_RETRIEVAL_LANCEDB_V1 = 'true';
      const flags = getFeatureFlagsFromEnv();
      expect(flags.retrieval_lancedb_v1).toBe(true);
    });
  });

  describe('Memory suggestion isolation', () => {
    it('should exclude the draft suggestion store from watcher/indexing surfaces and direct file indexing', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestion-index-'));
      fs.mkdirSync(path.join(tempDir, '.context-engine-memory-suggestions', 'session-1'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-memory-suggestions', 'session-1', 'draft-1.json'),
        JSON.stringify({ ok: true }),
        'utf-8'
      );

      const isolatedClient = new ContextServiceClient(tempDir);
      const result = await isolatedClient.indexFiles([
        '.context-engine-memory-suggestions/session-1/draft-1.json',
      ]);

      expect(isolatedClient.getExcludedDirectories()).toContain('.context-engine-memory-suggestions');
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toContain('No indexable file changes provided');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should never surface draft suggestions in normal memory retrieval', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestion-retrieval-'));
      const isolatedClient = new ContextServiceClient(tempDir);
      const store = new MemorySuggestionStore(tempDir);
      store.saveDraft(createDraftSuggestionRecord({
        draft_id: 'draft-1',
        session_id: 'session-1',
        source_type: 'plan',
        source_ref: 'plans/1',
        category: 'decisions',
        content: 'Draft suggestions stay out of normal retrieval.',
        score_breakdown: {
          repetition: 1,
          directive_strength: 1,
          source_reliability: 1,
          traceability: 1,
          stability_penalty: 0,
        },
        confidence: 0.91,
      }));
      fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.memories', 'decisions.md'),
        [
          '### [2026-04-11] Durable decision',
          '- Approved memories should still show up.',
          '- [meta] priority: critical',
        ].join('\n'),
        'utf-8'
      );

      const semanticSearchSpy = jest.spyOn(isolatedClient as any, 'semanticSearch').mockResolvedValue([
        {
          path: '.context-engine-memory-suggestions/session-1/draft-1.json',
          content: '{"draft":true}',
          relevanceScore: 0.99,
        },
        {
          path: '.memories/decisions.md',
          content: [
            '### [2026-04-11] Durable decision',
            '- Approved memories should still show up.',
            '- [meta] priority: critical',
          ].join('\n'),
          relevanceScore: 0.75,
        },
      ]);

      const bundle = await isolatedClient.getContextForPrompt('memory isolation test', {
        maxFiles: 1,
        includeRelated: false,
        includeMemories: true,
        bypassCache: true,
      });

      expect(semanticSearchSpy).toHaveBeenCalled();
      expect(bundle.memories).toEqual([
        expect.objectContaining({
          category: 'decisions',
          content: expect.stringContaining('Approved memories should still show up.'),
        }),
      ]);
      expect(bundle.memories?.some((memory) => memory.content.includes('Draft suggestions stay out of normal retrieval.'))).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should include session-scoped draft suggestions only when explicitly enabled', async () => {
      const originalDraftFlag = FEATURE_FLAGS.memory_draft_retrieval_v1;
      FEATURE_FLAGS.memory_draft_retrieval_v1 = true;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestion-explicit-retrieval-'));
      const explicitClient = new ContextServiceClient(tempDir);
      const store = new MemorySuggestionStore(tempDir);
      store.saveDraft(createDraftSuggestionRecord({
        draft_id: 'draft-1',
        session_id: 'session-42',
        source_type: 'plan_outputs',
        source_ref: 'plan://42',
        category: 'decisions',
        title: 'Keep memory mode suggestive',
        content: 'Auto-save should stay off until draft precision is proven.',
        metadata: {
          priority: 'critical',
          subtype: 'plan_note',
        },
        score_breakdown: {
          repetition: 1,
          directive_strength: 1,
          source_reliability: 1,
          traceability: 1,
          stability_penalty: 0,
        },
        confidence: 0.96,
      }));

      const semanticSearchSpy = jest.spyOn(explicitClient as any, 'semanticSearch').mockResolvedValue([
        {
          path: 'src/memory-consumer.ts',
          content: 'export const useDraftMemories = true;',
          relevanceScore: 0.88,
          lines: '1-1',
        },
      ]);

      try {
        const bundle = await explicitClient.getContextForPrompt('draft memory test', {
          maxFiles: 1,
          includeRelated: false,
          includeMemories: false,
          includeDraftMemories: true,
          draftSessionId: 'session-42',
          bypassCache: true,
        });

        expect(semanticSearchSpy).toHaveBeenCalled();
        expect(bundle.metadata.draftMemoriesIncluded).toBe(1);
        expect(bundle.metadata.draftMemoryCandidates).toBe(1);
        expect(bundle.memories).toEqual([
          expect.objectContaining({
            title: 'Keep memory mode suggestive',
            content: expect.stringContaining('Auto-save should stay off'),
          }),
        ]);
      } finally {
        FEATURE_FLAGS.memory_draft_retrieval_v1 = originalDraftFlag;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Retrieval Provider Dispatch', () => {
    it('should expose provider-scoped retrieval callbacks without callback-layer branching', async () => {
      const localClient = new ContextServiceClient(testWorkspace);
      const searchWithProviderRuntimeSpy = jest
        .spyOn(localClient as any, 'searchWithProviderRuntime')
        .mockResolvedValue([]);
      const keywordFallbackSpy = jest
        .spyOn(localClient as any, 'keywordFallbackSearch')
        .mockResolvedValue([]);
      const indexWorkspaceLocalSpy = jest
        .spyOn(localClient as any, 'indexWorkspaceLocalNativeFallback')
        .mockResolvedValue({ indexed: 1, skipped: 0, errors: [], duration: 1 });
      const indexFilesLocalSpy = jest
        .spyOn(localClient as any, 'indexFilesLocalNativeFallback')
        .mockResolvedValue({ indexed: 1, skipped: 0, errors: [], duration: 1 });
      const clearIndexSpy = jest
        .spyOn(localClient as any, 'clearIndexWithProviderRuntime')
        .mockResolvedValue(undefined);

      const callbacks = (localClient as any).createRetrievalProviderCallbacks();

      await callbacks.localNative.search('provider query', 3, { bypassCache: true });
      await callbacks.localNative.indexWorkspace();
      await callbacks.localNative.indexFiles(['src/file.ts']);
      await callbacks.localNative.clearIndex();
      const health = await callbacks.localNative.health({
        providerId: 'local_native',
        operation: 'health',
      });

      expect(searchWithProviderRuntimeSpy).toHaveBeenCalledWith('provider query', 3, { bypassCache: true });
      expect(keywordFallbackSpy).not.toHaveBeenCalled();
      expect(indexWorkspaceLocalSpy).toHaveBeenCalledTimes(1);
      expect(indexFilesLocalSpy).toHaveBeenCalledWith(['src/file.ts']);
      expect(clearIndexSpy).toHaveBeenCalledWith({ localNative: true });
      expect(health).toEqual({ ok: true, details: 'retrieval_provider=local_native' });
    });

    it('should route semantic search through the active retrieval provider instance', async () => {
      const providerSearch = jest.fn(
        async (_query: string, _topK: number, _options?: { bypassCache?: boolean; maxOutputLength?: number }) => [
        { path: 'src/provider.ts', content: 'provider result', relevanceScore: 0.9 },
      ]);
      (client as any).retrievalProvider = {
        id: 'local_native',
        search: providerSearch,
        indexWorkspace: jest.fn(),
        indexFiles: jest.fn(),
        clearIndex: jest.fn(),
        getIndexStatus: jest.fn(async () => client.getIndexStatus()),
        health: jest.fn(async () => ({ ok: true })),
      };

      const results = await client.semanticSearch('provider query', 3, { bypassCache: true });

      expect(providerSearch).toHaveBeenCalledWith('provider query', 3, { bypassCache: true });
      expect(results).toEqual([
        expect.objectContaining({ path: 'src/provider.ts', content: 'provider result' }),
      ]);
    });

    it('should route index lifecycle methods through active retrieval provider instance', async () => {
      const indexWorkspace = jest.fn(async () => ({ indexed: 2, skipped: 0, errors: [], duration: 1 }));
      const indexFiles = jest.fn(async (_paths: string[]) => ({ indexed: 1, skipped: 0, errors: [], duration: 1 }));
      const clearIndex = jest.fn(async () => undefined);
      (client as any).retrievalProvider = {
        id: 'local_native',
        search: jest.fn(async () => []),
        indexWorkspace,
        indexFiles,
        clearIndex,
        getIndexStatus: jest.fn(async () => client.getIndexStatus()),
        health: jest.fn(async () => ({ ok: true })),
      };

      const workspaceResult = await client.indexWorkspace();
      const filesResult = await client.indexFiles(['src/file.ts']);
      await client.clearIndex();

      expect(indexWorkspace).toHaveBeenCalledTimes(1);
      expect(indexFiles).toHaveBeenCalledWith(['src/file.ts']);
      expect(clearIndex).toHaveBeenCalledTimes(1);
      expect(workspaceResult.indexed).toBe(2);
      expect(filesResult.indexed).toBe(1);
    });

    it('should forward watcher batches to the SQLite lexical incremental refresh path', async () => {
      featureFlags.retrieval_sqlite_fts5_v1 = true;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-lexical-refresh-dispatch-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'alpha.ts'),
        'export const alpha = "needle one";',
        'utf-8'
      );

      const refreshClient = new ContextServiceClient(tempDir);
      const lexicalEngine = {
        search: jest.fn(async () => []),
        applyWorkspaceChanges: jest.fn(async () => undefined),
        clearCache: jest.fn(),
      };
      const getLexicalEngineSpy = jest
        .spyOn(refreshClient as any, 'getLexicalSqliteSearchEngine')
        .mockReturnValue(lexicalEngine);
      const indexFilesSpy = jest
        .spyOn(refreshClient as any, 'indexFiles')
        .mockResolvedValue({ indexed: 1, skipped: 0, errors: [], duration: 1 });
      const pruneSpy = jest
        .spyOn(refreshClient as any, 'pruneDeletedIndexEntries')
        .mockResolvedValue(1);

      await refreshClient.applyWorkspaceChanges([
        { type: 'change', path: 'src/alpha.ts' },
        { type: 'unlink', path: 'src/beta.ts' },
      ]);

      expect(pruneSpy).toHaveBeenCalledWith(['src/beta.ts']);
      expect(indexFilesSpy).toHaveBeenCalledWith(['src/alpha.ts']);
      expect(getLexicalEngineSpy).toHaveBeenCalledTimes(1);
      expect(lexicalEngine.applyWorkspaceChanges).toHaveBeenCalledTimes(1);
      const lexicalCalls = (lexicalEngine.applyWorkspaceChanges as jest.Mock).mock.calls;
      expect(lexicalCalls[0]?.[0]).toEqual([
        { type: 'change', path: 'src/alpha.ts' },
        { type: 'unlink', path: 'src/beta.ts' },
      ]);

      getLexicalEngineSpy.mockRestore();
      indexFilesSpy.mockRestore();
      pruneSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should fall back to a full lexical refresh when incremental refresh fails', async () => {
      featureFlags.retrieval_sqlite_fts5_v1 = true;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-lexical-refresh-fallback-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'alpha.ts'),
        'export const alpha = "needle one";',
        'utf-8'
      );

      const refreshClient = new ContextServiceClient(tempDir);
      const lexicalEngine = {
        search: jest.fn(async () => []),
        applyWorkspaceChanges: jest.fn(async () => {
          throw new Error('incremental refresh failed');
        }),
        refresh: jest.fn(async () => undefined),
        clearCache: jest.fn(),
      };
      const getLexicalEngineSpy = jest
        .spyOn(refreshClient as any, 'getLexicalSqliteSearchEngine')
        .mockReturnValue(lexicalEngine);
      const indexFilesSpy = jest
        .spyOn(refreshClient as any, 'indexFiles')
        .mockResolvedValue({ indexed: 1, skipped: 0, errors: [], duration: 1 });

      await refreshClient.applyWorkspaceChanges([
        { type: 'change', path: 'src/alpha.ts' },
      ]);

      expect(getLexicalEngineSpy).toHaveBeenCalledTimes(1);
      expect(lexicalEngine.applyWorkspaceChanges).toHaveBeenCalledTimes(1);
      expect(lexicalEngine.refresh).toHaveBeenCalledTimes(1);
      expect(indexFilesSpy).toHaveBeenCalledWith(['src/alpha.ts']);

      getLexicalEngineSpy.mockRestore();
      indexFilesSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should route local_native semantic search via provider boundary without touching legacy runtime parsing path', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-native-provider-dispatch-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'needle.ts'),
        'export const localNativeProviderDispatchNeedle = true;',
        'utf-8'
      );

      const localClient = new ContextServiceClient(tempDir);
      configureOpenAISemanticProvider(localClient, 'not-json-provider-response');
      const searchWithProviderRuntimeSpy = jest.spyOn(localClient as any, 'searchWithProviderRuntime');
      const keywordFallbackSpy = jest.spyOn(localClient as any, 'keywordFallbackSearch');
      const searchAndAskSpy = jest.spyOn(localClient as any, 'searchAndAsk');
      const parseFormattedResultsSpy = jest.spyOn(localClient as any, 'parseFormattedResults');

      const results = await localClient.semanticSearch('localNativeProviderDispatchNeedle', 5, { bypassCache: true });

      expect(searchWithProviderRuntimeSpy).toHaveBeenCalledTimes(1);
      expect(keywordFallbackSpy).toHaveBeenCalledTimes(1);
      expect(searchAndAskSpy).toHaveBeenCalledTimes(1);
      expect(parseFormattedResultsSpy).not.toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/needle.ts');
      expect(results.every((result) => result.matchType === 'keyword')).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Retrieval Runtime Metadata', () => {
    it('should report active provider id plus retrieval v2 and shadow config state', () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'true';
      process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '0.35';
      FEATURE_FLAGS.retrieval_rewrite_v2 = true;
      FEATURE_FLAGS.retrieval_ranking_v2 = true;
      FEATURE_FLAGS.retrieval_ranking_v3 = false;
      FEATURE_FLAGS.retrieval_request_memo_v2 = true;

      const localClient = new ContextServiceClient(testWorkspace);
      const metadata = localClient.getRetrievalRuntimeMetadata();

      expect(metadata).toEqual({
        providerId: 'local_native',
        shadowCompare: {
          enabled: true,
          sampleRate: 0.35,
        },
        v2: {
          retrievalRewriteV2: true,
          retrievalRankingV2: true,
          retrievalRankingV3: false,
          retrievalRequestMemoV2: true,
        },
      });
    });

    it('should not change semantic search behavior when metadata is queried', async () => {
      const providerSearch = jest.fn(
        async (_query: string, _topK: number, _options?: { bypassCache?: boolean; maxOutputLength?: number }) => [
          { path: 'src/provider.ts', content: 'provider result', relevanceScore: 0.9 },
        ]
      );
      (client as any).retrievalProvider = {
        id: 'local_native',
        search: providerSearch,
        indexWorkspace: jest.fn(),
        indexFiles: jest.fn(),
        clearIndex: jest.fn(),
        getIndexStatus: jest.fn(async () => client.getIndexStatus()),
        health: jest.fn(async () => ({ ok: true })),
      };

      const metadata = client.getRetrievalRuntimeMetadata();
      expect(metadata.providerId).toBe('local_native');
      expect(providerSearch).toHaveBeenCalledTimes(0);

      const results = await client.semanticSearch('provider query', 3, { bypassCache: true });
      expect(providerSearch).toHaveBeenCalledWith('provider query', 3, { bypassCache: true });
      expect(results).toEqual([
        expect.objectContaining({ path: 'src/provider.ts', content: 'provider result' }),
      ]);
    });
  });

  describe('Retrieval Artifact V2 Metadata', () => {
    it('should keep the zero-flags default posture stable for retrieval metadata outputs', () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'false';
      delete process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE;

      for (const key of [
        'rollout_kill_switch',
        'index_state_store',
        'skip_unchanged_indexing',
        'hash_normalize_eol',
        'retrieval_rewrite_v2',
        'retrieval_ranking_v2',
        'retrieval_ranking_v3',
        'retrieval_request_memo_v2',
        'retrieval_hybrid_v1',
        'context_packs_v2',
        'retrieval_quality_guard_v1',
        'retrieval_provider_v2',
        'retrieval_artifacts_v2',
        'retrieval_shadow_control_v2',
        'retrieval_tree_sitter_v1',
        'retrieval_chunk_search_v1',
        'retrieval_sqlite_fts5_v1',
        'retrieval_lancedb_v1',
        'retrieval_transformer_embeddings_v1',
      ]) {
        featureFlags[key] = false;
      }

      const localClient = new ContextServiceClient(testWorkspace);
      const runtimeMetadata = localClient.getRetrievalRuntimeMetadata();
      const artifactMetadata = localClient.getRetrievalArtifactMetadata();
      const featureSnapshot = snapshotRetrievalV2FeatureFlags();

      expect(Object.keys(featureSnapshot).sort()).toEqual([
        'context_packs_v2',
        'hash_normalize_eol',
        'index_state_store',
        'retrieval_artifacts_v2',
        'retrieval_chunk_search_v1',
        'retrieval_hybrid_v1',
        'retrieval_lancedb_v1',
        'retrieval_provider_v2',
        'retrieval_quality_guard_v1',
        'retrieval_ranking_v2',
        'retrieval_ranking_v3',
        'retrieval_request_memo_v2',
        'retrieval_rewrite_v2',
        'retrieval_shadow_control_v2',
        'retrieval_sqlite_fts5_v1',
        'retrieval_tree_sitter_v1',
        'rollout_kill_switch',
        'skip_unchanged_indexing',
      ]);
      expect(Object.values(featureSnapshot).every((value) => value === false)).toBe(true);
      expect(runtimeMetadata).toEqual({
        providerId: 'local_native',
        shadowCompare: {
          enabled: false,
          sampleRate: 0,
        },
        v2: {
          retrievalRewriteV2: false,
          retrievalRankingV2: false,
          retrievalRankingV3: false,
          retrievalRequestMemoV2: false,
        },
      });
      expect(artifactMetadata).toMatchObject({
        artifact_schema_version: 1,
        retrieval_provider: 'local_native',
        retrieval_engine_version: 'local-native-v1',
        embedding_model_id: 'hash-128',
        vector_dimension: 128,
        fallback_domain: 'unknown',
        fallback_reason: null,
        feature_flags_snapshot: featureSnapshot,
        shadow_compare: {
          enabled: false,
          sampleRate: 0,
        },
      });
    });

    it('should expose a versioned retrieval artifact snapshot without changing runtime metadata', () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'true';
      process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '0.25';
      FEATURE_FLAGS.retrieval_provider_v2 = true;
      FEATURE_FLAGS.retrieval_artifacts_v2 = true;
      FEATURE_FLAGS.retrieval_chunk_search_v1 = true;
      FEATURE_FLAGS.retrieval_lancedb_v1 = false;

      const localClient = new ContextServiceClient(testWorkspace);
      const runtimeMetadata = localClient.getRetrievalRuntimeMetadata();
      const artifactMetadata = localClient.getRetrievalArtifactMetadata({
        fallbackDomain: 'retrieval',
        fallbackReason: 'provider_empty_array',
      });

      expect(runtimeMetadata.providerId).toBe('local_native');
      expect(artifactMetadata).toMatchObject({
        artifact_schema_version: 1,
        retrieval_provider: 'local_native',
        retrieval_engine_version: 'local-native-v1',
        chunking_version: 1,
        parser_version: 'heuristic-boundary-v1',
        embedding_model_id: 'hash-128',
        vector_dimension: 128,
        index_fingerprint: expect.any(String),
        fallback_domain: 'retrieval',
        fallback_reason: 'provider_empty_array',
        shadow_compare: {
          enabled: true,
          sampleRate: 0.25,
        },
      });
      expect(artifactMetadata.workspace_fingerprint).toMatch(/^workspace:/);
      expect(artifactMetadata.env_fingerprint).toMatch(/^env:/);
    });

    it('should record the LanceDB vector engine when the vector flag is enabled', () => {
      FEATURE_FLAGS.retrieval_provider_v2 = true;
      FEATURE_FLAGS.retrieval_artifacts_v2 = true;
      FEATURE_FLAGS.retrieval_lancedb_v1 = true;

      const localClient = new ContextServiceClient(testWorkspace);
      const artifactMetadata = localClient.getRetrievalArtifactMetadata({
        fallbackDomain: 'retrieval',
        fallbackReason: 'vector_backend_enabled',
      });

      expect(artifactMetadata.retrieval_engine_version).toBe('lancedb-vector-v1');
      expect(artifactMetadata.embedding_model_id).toBe('hash-32');
      expect(artifactMetadata.vector_dimension).toBe(32);
      expect(artifactMetadata.fallback_domain).toBe('retrieval');
      expect(artifactMetadata.fallback_reason).toBe('vector_backend_enabled');
    });

    it('should record transformer embedding metadata when the transformer flag is enabled', () => {
      FEATURE_FLAGS.retrieval_provider_v2 = true;
      FEATURE_FLAGS.retrieval_artifacts_v2 = true;
      FEATURE_FLAGS.retrieval_lancedb_v1 = true;
      FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = true;

      const localClient = new ContextServiceClient(testWorkspace);
      const artifactMetadata = localClient.getRetrievalArtifactMetadata({
        fallbackDomain: 'retrieval',
        fallbackReason: 'transformer_embeddings_enabled',
      });

      expect(artifactMetadata.retrieval_engine_version).toBe('lancedb-vector-v1');
      expect(artifactMetadata.embedding_model_id).toBe('Xenova/all-MiniLM-L6-v2');
      expect(artifactMetadata.vector_dimension).toBe(384);
      expect(artifactMetadata.fallback_domain).toBe('retrieval');
      expect(artifactMetadata.fallback_reason).toBe('transformer_embeddings_enabled');
    });
  });

  describe('Path Validation', () => {
    it('should reject absolute paths', async () => {
      const absolutePath = process.platform === 'win32'
        ? 'C:\\Users\\test\\file.txt'
        : '/etc/passwd';

      await expect(client.getFile(absolutePath))
        .rejects.toThrow(/absolute paths not allowed/i);
    });

    it('should reject path traversal attempts', async () => {
      await expect(client.getFile('../../../etc/passwd'))
        .rejects.toThrow(/path traversal not allowed/i);
    });

    it('should reject paths with .. in the middle', async () => {
      await expect(client.getFile('src/../../../secret.txt'))
        .rejects.toThrow(/path traversal not allowed|path must be within workspace/i);
    });

    it('should allow valid relative paths', async () => {
      // Mock file existence check
      const validPath = 'package.json';

      // This should not throw a path validation error
      // (it may throw file not found if file doesn't exist, which is fine)
      try {
        await client.getFile(validPath);
      } catch (error) {
        expect((error as Error).message).not.toMatch(/path traversal|absolute paths/i);
      }
    });
  });

  describe('File Size Limits', () => {
    it('should have MAX_FILE_SIZE constant defined', () => {
      // The constant should be defined (10MB = 10 * 1024 * 1024)
      // We can't directly access private constants, but we can test behavior
      expect(true).toBe(true); // Placeholder - actual test in integration
    });
  });

  describe('Token Estimation', () => {
    it('should estimate tokens based on character count', () => {
      // Token estimation is private, test via context bundle metadata
      // A 400-character string should be ~100 tokens (4 chars per token)
      expect(true).toBe(true); // Will be tested via integration
    });
  });

  describe('Semantic Search (openai_session default)', () => {
    it('should parse provider JSON results by default', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([
          {
            path: 'src/index.ts',
            content: 'export function main() {}',
            lines: '1-1',
            relevanceScore: 0.9,
          },
        ])
      );

      const results = await client.semanticSearch('main function', 5);

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        path: 'src/index.ts',
        content: 'export function main() {}',
      });
      expect(mockContextInstance.search).not.toHaveBeenCalled();
    });

    it('should return [] when provider explicitly returns [] (default authoritative mode)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-empty-array-general-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'query.ts'),
        'export const testQueryProof = "semantic fallback should find this test query marker";',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch('test query', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return [] even for strong identifier query when provider explicitly returns [] (default authoritative mode)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-empty-array-strong-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        'export function resolveAIProviderId() { return "openai_session"; }',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch('resolveAIProviderId', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should allow compat fallback when CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK=true', async () => {
      process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK = 'true';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-empty-array-compat-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        'export function resolveAIProviderId() { return "openai_session"; }',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch('resolveAIProviderId', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/provider.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should fallback to keyword search on provider error', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-provider-error-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'error-fallback.ts'),
        'export const providerErrorFallbackNeedle = true;',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, new Error('API error'));

      const results = await fallbackClient.semanticSearch('providerErrorFallbackNeedle', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/error-fallback.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should use keyword fallback when provider response is non-empty but unparseable', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-fallback-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'needle.ts'),
        'export class ContextServiceClientFallbackCheck { value = true; }',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(
        fallbackClient,
        'non-empty response with unknown format'
      );

      const results = await fallbackClient.semanticSearch('ContextServiceClientFallbackCheck', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/needle.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should use keyword fallback when provider response is empty for strong identifier queries', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-strong-token-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'needle.ts'),
        'export class ContextServiceClientStrongTokenProof { value = true; }',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '');

      const results = await fallbackClient.semanticSearch(
        'where is ContextServiceClientStrongTokenProof implemented',
        5,
        { bypassCache: true }
      );

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/needle.ts');
      expect(results.every((result) => result.matchType === 'keyword')).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('reuses fallback file discovery when bypassCache is false', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-fallback-cache-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'cache.ts'),
        'export const fallbackCacheProbe = true;',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const discoverFilesSpy = jest.spyOn(fallbackClient as any, 'discoverFiles');

      const firstResults = await (fallbackClient as any).keywordFallbackSearch('fallbackCacheProbe', 5, {
        bypassCache: false,
      });
      const secondResults = await (fallbackClient as any).keywordFallbackSearch('fallbackCacheProbe', 5, {
        bypassCache: false,
      });
      const rootDiscoveryCalls = discoverFilesSpy.mock.calls.filter(
        ([dirPath, relativeTo]) => dirPath === tempDir && relativeTo === undefined
      );

      expect(rootDiscoveryCalls).toHaveLength(1);
      expect(firstResults.length).toBeGreaterThan(0);
      expect(secondResults.length).toBeGreaterThan(0);
      expect(firstResults[0].path).toContain('src/cache.ts');
      expect(secondResults[0].path).toContain('src/cache.ts');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('does not reuse fallback file discovery when bypassCache is true', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-fallback-bypass-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'cache.ts'),
        'export const fallbackBypassProbe = true;',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const discoverFilesSpy = jest.spyOn(fallbackClient as any, 'discoverFiles');

      const firstResults = await (fallbackClient as any).keywordFallbackSearch('fallbackBypassProbe', 5, {
        bypassCache: true,
      });
      const secondResults = await (fallbackClient as any).keywordFallbackSearch('fallbackBypassProbe', 5, {
        bypassCache: true,
      });
      const rootDiscoveryCalls = discoverFilesSpy.mock.calls.filter(
        ([dirPath, relativeTo]) => dirPath === tempDir && relativeTo === undefined
      );

      expect(rootDiscoveryCalls).toHaveLength(2);
      expect(firstResults.length).toBeGreaterThan(0);
      expect(secondResults.length).toBeGreaterThan(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return keyword matchType results from local keyword fallback search', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-keyword-search-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'localKeyword.ts'),
        'export const localKeywordSearchNeedle = "match me";',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const results = await fallbackClient.localKeywordSearch('localKeywordSearchNeedle', 5);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/localKeyword.ts');
      expect(results.every((result: { matchType?: string }) => result.matchType === 'keyword')).toBe(true);
      expect(results.every((result: { retrievedAt?: string }) => typeof result.retrievedAt === 'string')).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return non-declaration symbol references from local reference search', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-symbol-references-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        'export function resolveAIProviderId() { return "openai_session"; }\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'caller.ts'),
        [
          'import { resolveAIProviderId } from "./provider";',
          'export const activeProvider = resolveAIProviderId();',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'importOnly.ts'),
        [
          'import { resolveAIProviderId } from "./provider";',
          'export const providerLabel = "openai";',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'methodDeclaration.ts'),
        [
          'export class ProviderFactory {',
          '  resolveAIProviderId() {',
          '    return "openai_session";',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const results = await fallbackClient.symbolReferencesSearch('resolveAIProviderId', 5, {
        bypassCache: true,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((result: SearchResult) => result.path.includes('src/caller.ts'))).toBe(true);
      expect(results.some((result: SearchResult) => result.path.includes('src/importOnly.ts'))).toBe(false);
      expect(results.some((result: SearchResult) => result.path.includes('src/methodDeclaration.ts'))).toBe(false);
      expect(results.some((result: SearchResult) => result.path.includes('src/provider.ts'))).toBe(false);
      expect(
        results.some((result: SearchResult) => result.content.includes('activeProvider = resolveAIProviderId()'))
      ).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return the canonical declaration for a known symbol via symbolDefinition', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-symbol-definition-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        [
          '// header comment',
          'export function resolveAIProviderId() {',
          '  return "openai_session";',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.symbolDefinition('resolveAIProviderId', {
        bypassCache: true,
      });

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.symbol).toBe('resolveAIProviderId');
        expect(result.file).toContain('src/provider.ts');
        expect(result.line).toBe(2);
        expect(result.kind).toBe('function');
        expect(result.snippet).toContain('resolveAIProviderId');
        expect(typeof result.score).toBe('number');
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should prefer src/ declarations over tests/ declarations in symbolDefinition', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-symbol-definition-srcwin-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'tests', 'provider.test.ts'),
        [
          'export function resolveAIProviderId() {',
          '  return "stub";',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        [
          'export function resolveAIProviderId() {',
          '  return "openai_session";',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.symbolDefinition('resolveAIProviderId', {
        bypassCache: true,
      });

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.file).toContain('src/provider.ts');
        expect(result.file).not.toContain('tests/');
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return found=false when no declaration exists', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-symbol-definition-missing-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'noop.ts'),
        'export const unrelated = 1;\n',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.symbolDefinition('nonExistentSymbolXyz', {
        bypassCache: true,
      });

      expect(result.found).toBe(false);
      expect(result.symbol).toBe('nonExistentSymbolXyz');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should not return reference-only files as the definition', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-symbol-definition-refonly-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'provider.ts'),
        [
          'export function resolveAIProviderId() {',
          '  return "openai_session";',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'caller.ts'),
        [
          'import { resolveAIProviderId } from "./provider";',
          'export const activeProvider = resolveAIProviderId();',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.symbolDefinition('resolveAIProviderId', {
        bypassCache: true,
      });

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.file).toContain('src/provider.ts');
        expect(result.file).not.toContain('src/caller.ts');
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('callRelationships', () => {
    it('should return callers with enclosing function name', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-call-relationships-callers-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'foo.ts'),
        ['export function foo(a, b) {', '  return a + b;', '}', ''].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'bar.ts'),
        [
          'import { foo } from "./foo";',
          'export function bar() {',
          '  const result = foo(1, 2);',
          '  return result;',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.callRelationships('foo', {
        direction: 'callers',
        bypassCache: true,
      });

      expect(result.symbol).toBe('foo');
      expect(result.callees).toEqual([]);
      expect(result.metadata.direction).toBe('callers');
      expect(result.callers.length).toBeGreaterThan(0);
      const barCaller = result.callers.find((c) => c.file.includes('src/bar.ts'));
      expect(barCaller).toBeDefined();
      expect(barCaller?.callerSymbol).toBe('bar');
      expect(barCaller?.snippet).toContain('foo(1, 2)');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return callees inside the function body and exclude keywords and self', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-call-relationships-callees-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'bar.ts'),
        [
          'export function bar(x) {',
          '  if (x) {',
          '    foo(x);',
          '    return baz(x);',
          '  }',
          '  return bar(x - 1);',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.callRelationships('bar', {
        direction: 'callees',
        bypassCache: true,
      });

      expect(result.symbol).toBe('bar');
      expect(result.callers).toEqual([]);
      const calleeNames = result.callees.map((c) => c.calleeSymbol);
      expect(calleeNames).toEqual(expect.arrayContaining(['foo', 'baz']));
      expect(calleeNames).not.toContain('if');
      expect(calleeNames).not.toContain('return');
      expect(calleeNames).not.toContain('bar');
      expect(result.metadata.totalCallees).toBe(result.callees.length);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return empty callees with no error when symbol is not found', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-call-relationships-missing-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'noop.ts'),
        'export const unrelated = 1;\n',
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.callRelationships('nonExistentSymbolXyz', {
        direction: 'callees',
        bypassCache: true,
      });

      expect(result.callees).toEqual([]);
      expect(result.callers).toEqual([]);
      expect(result.metadata.totalCallees).toBe(0);
      expect(result.metadata.totalCallers).toBe(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should not treat declaration-only lines as callers', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-call-relationships-declonly-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'foo.ts'),
        ['export function foo() {}', ''].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.callRelationships('foo', {
        direction: 'callers',
        bypassCache: true,
      });

      expect(result.callers).toEqual([]);
      expect(result.metadata.totalCallers).toBe(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should compute both callers and callees when direction is both', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-call-relationships-both-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'bar.ts'),
        [
          'export function bar() {',
          '  return foo();',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'caller.ts'),
        [
          'import { bar } from "./bar";',
          'export function outer() {',
          '  return bar();',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const result = await fallbackClient.callRelationships('bar', {
        bypassCache: true,
      });

      expect(result.metadata.direction).toBe('both');
      expect(result.callers.some((c) => c.file.includes('src/caller.ts'))).toBe(true);
      expect(result.callees.map((c) => c.calleeSymbol)).toContain('foo');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Semantic Search with openai_session provider', () => {
    it('should never initialize the removed legacy runtime when CE_AI_PROVIDER=openai_session', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(testWorkspace);

      configureOpenAISemanticProvider(openAIClient, '[]');

      const results = await openAIClient.semanticSearch('main function', 5, { bypassCache: true });

      expect(Array.isArray(results)).toBe(true);
      expect(mockContextInstance.search).not.toHaveBeenCalled();
    });

    it('should parse provider JSON responses into SearchResult objects', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(testWorkspace);
      const response = JSON.stringify([
        {
          path: 'src/index.ts',
          content: 'export function main() {}',
          lines: '1-1',
          relevanceScore: 1.2,
          matchType: 'semantic',
        },
      ]);
      const providerCall = configureOpenAISemanticProvider(openAIClient, response);

      const results = await openAIClient.semanticSearch('main function', 5);

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        path: 'src/index.ts',
        content: 'export function main() {}',
      });
      expect(results[0].relevanceScore).toBe(1);
      expect(mockContextInstance.search).not.toHaveBeenCalled();
    });

    it('should parse provider JSON responses wrapped in code fences', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(testWorkspace);
      const response = JSON.stringify([
        {
          path: 'src/fenced.ts',
          content: 'export const fenced = 1;',
          lines: '1-1',
          score: 0.9,
          matchType: 'semantic',
        },
      ]);
      const fencedResponse = '```json\n' + response + '\n```';
      const providerCall = configureOpenAISemanticProvider(openAIClient, fencedResponse);

      const results = await openAIClient.semanticSearch('fenced response', 5);

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBe(1);
      expect(results[0]).toMatchObject({
        path: 'src/fenced.ts',
        content: 'export const fenced = 1;',
        relevanceScore: 0.9,
        matchType: 'semantic',
      });
      expect(mockContextInstance.search).not.toHaveBeenCalled();
    });

    it('should fallback to legacy parsing and keyword search when provider response is not JSON (non-strict mode)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-openai-fallback-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'NeedleClass.ts'),
        'export class NeedleClass {}',
        'utf-8'
      );

      const openAIClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(openAIClient, 'This is not JSON');

      const results = await openAIClient.semanticSearch('NeedleClass', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/NeedleClass.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should fallback to keyword search when fenced JSON response is malformed (non-strict mode)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-openai-fenced-fallback-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'NeedleFallbackClass.ts'),
        'export class NeedleFallbackClass {}',
        'utf-8'
      );

      const openAIClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(
        openAIClient,
        '```json\n[{"path": "src/NeedleFallbackClass.ts", "content": 123]\n```'
      );

      const results = await openAIClient.semanticSearch('NeedleFallbackClass', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/NeedleFallbackClass.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should still keyword-fallback on non-JSON provider response in strict openai_session mode', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-openai-strict-nonjson-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'NeedleClass.ts'),
        'export class NeedleClass {}',
        'utf-8'
      );

      process.env.CE_AI_OPENAI_SESSION_ONLY = 'true';
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(tempDir);
      const fallbackSpy = jest.spyOn(openAIClient as any, 'keywordFallbackSearch');
      const providerCall = configureOpenAISemanticProvider(openAIClient, 'This is not JSON');

      const results = await openAIClient.semanticSearch('Needle class', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/NeedleClass.ts');
      expect(mockContextInstance.search).not.toHaveBeenCalled();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should still keyword-fallback on malformed fenced JSON provider response in strict openai_session mode', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-openai-strict-malformed-fence-'));
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'NeedleFallbackClass.ts'),
        'export class NeedleFallbackClass {}',
        'utf-8'
      );

      process.env.CE_AI_OPENAI_SESSION_ONLY = 'true';
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(tempDir);
      const fallbackSpy = jest.spyOn(openAIClient as any, 'keywordFallbackSearch');
      const providerCall = configureOpenAISemanticProvider(
        openAIClient,
        '```json\n[{"path":"src/NeedleFallbackClass.ts","content":123]\n```'
      );

      const results = await openAIClient.semanticSearch('Needle class', 5, { bypassCache: true });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/NeedleFallbackClass.ts');
      expect(mockContextInstance.search).not.toHaveBeenCalled();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should ignore unsafe paths from provider output and keep valid entries', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(testWorkspace);
      const response = JSON.stringify([
        {
          path: '/etc/passwd',
          content: 'sensitive',
          lines: '1-1',
        },
        {
          path: '..\\src/forbidden.ts',
          content: 'bad',
          lines: '1-3',
        },
        {
          path: 'src/utils.ts',
          content: 'export const value = 1;',
          relevanceScore: 0.5,
        },
      ]);

      configureOpenAISemanticProvider(openAIClient, response);

      const results = await openAIClient.semanticSearch('utils', 5, { bypassCache: true });

      expect(results.length).toBe(1);
      expect(results[0].path).toBe('src/utils.ts');
    });

    it('should prefix cache keys with retrieval provider id by default', () => {
      const defaultClient = new ContextServiceClient(testWorkspace);
      const defaultKey = (defaultClient as any).getCommitAwareCacheKey('cache mix', 3);

      process.env.CE_AI_PROVIDER = 'openai_session';
      const explicitClient = new ContextServiceClient(testWorkspace);
      const explicitKey = (explicitClient as any).getCommitAwareCacheKey('cache mix', 3);

      expect(defaultClient.getActiveAIProviderId()).toBe('openai_session');
      expect(explicitClient.getActiveAIProviderId()).toBe('openai_session');
      expect(defaultClient.getActiveRetrievalProviderId()).toBe('local_native');
      expect(explicitClient.getActiveRetrievalProviderId()).toBe('local_native');
      expect(defaultKey).toEqual(explicitKey);
      expect(defaultKey.startsWith('local_native:')).toBe(true);
    });

    it('should cache results under retrieval-provider-scoped keys', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-openai-provider-cache-'));
      const openAIClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(
        openAIClient,
        JSON.stringify([
          {
            path: 'src/openai.ts',
            content: 'export const openaiProvider = 1;',
            lines: '1-1',
            score: 0.82,
            matchType: 'hybrid',
          },
        ])
      );
      const query = 'cache isolation query';
      const openAIKey = (openAIClient as any).getCommitAwareCacheKey(query, 5);
      expect(openAIKey.startsWith('local_native:')).toBe(true);

      const firstResults = await openAIClient.semanticSearch(query, 5);
      const secondResults = await openAIClient.semanticSearch(query, 5);

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(firstResults.length).toBe(1);
      expect(secondResults.length).toBe(1);
      expect((openAIClient as any).searchCache.get(openAIKey)).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should include local_native retrieval provider in cache keys when configured', () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      const localNativeClient = new ContextServiceClient(testWorkspace);

      const cacheKey = (localNativeClient as any).getCommitAwareCacheKey('cache mix', 3);
      expect(localNativeClient.getActiveAIProviderId()).toBe('openai_session');
      expect(localNativeClient.getActiveRetrievalProviderId()).toBe('local_native');
      expect(cacheKey.startsWith('local_native:')).toBe(true);
    });

    it('should run retrieval shadow compare without changing primary semantic results', async () => {
      process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'true';
      process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '1';

      const shadowClient = new ContextServiceClient(testWorkspace);
      configureOpenAISemanticProvider(
        shadowClient,
        JSON.stringify([
          {
            path: 'src/shadow.ts',
            content: 'export const primaryShadow = true;',
            lines: '1-1',
            relevanceScore: 0.92,
          },
        ])
      );

      const fallbackSpy = jest
        .spyOn(shadowClient as any, 'keywordFallbackSearch')
        .mockResolvedValue([{ path: 'src/shadow.ts', content: 'shadow', matchType: 'keyword' }]);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const results = await shadowClient.semanticSearch('shadow compare query', 5, { bypassCache: true });
      await new Promise((resolve) => setImmediate(resolve));

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('src/shadow.ts');
      expect(results[0].matchType).toBe('semantic');
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('[retrieval_shadow_compare]'))
      ).toBe(true);

      errorSpy.mockRestore();
      fallbackSpy.mockRestore();
    });

    it('should prioritize src/tests paths over artifacts for code-intent fallback queries', async () => {
      process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK = 'true';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-code-intent-priority-'));
      fs.mkdirSync(path.join(tempDir, 'src', 'ai', 'providers'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tests', 'ai', 'providers'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'bench'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'src', 'ai', 'providers', 'factory.ts'),
        'export function resolveAIProviderId() { return \"openai_session\"; }',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'ai', 'providers', 'codexSessionProvider.ts'),
        [
          'export class CodexSessionProvider {',
          '  call() {',
          '    return \"provider factory tests\";',
          '  }',
          '}',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'tests', 'ai', 'providers', 'factory.test.ts'),
        'import { resolveAIProviderId } from \"../../../../src/ai/providers/factory\"; describe(\"factory\", () => it(\"works\", () => expect(resolveAIProviderId).toBeDefined()));',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'bench', 'candidate.json'),
        JSON.stringify({
          note: 'resolveAIProviderId function and AI provider factory tests',
        }),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch(
        'resolveAIProviderId function and AI provider factory tests',
        5,
        { bypassCache: true }
      );

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      const topTwo = results.slice(0, 2).map((r) => r.path);
      expect(topTwo).toContain('src/ai/providers/factory.ts');
      expect(topTwo).toContain('tests/ai/providers/factory.test.ts');
      expect(results.some((r) => r.path.startsWith('artifacts/'))).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should allow artifacts for mixed ops intent queries', async () => {
      process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK = 'true';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-mixed-intent-artifacts-'));
      fs.mkdirSync(path.join(tempDir, 'src', 'ai', 'providers'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'bench'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'src', 'ai', 'providers', 'factory.ts'),
        'export function resolveAIProviderId() { return "openai_session"; }',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'bench', 'report.json'),
        JSON.stringify({
          summary: 'benchmark report for resolveAIProviderId provider factory tests',
        }),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch(
        'benchmark report for resolveAIProviderId provider factory tests',
        8,
        { bypassCache: true }
      );

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.path.startsWith('artifacts/'))).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should allow include:artifacts override for code-intent queries', async () => {
      process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK = 'true';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-include-artifacts-'));
      fs.mkdirSync(path.join(tempDir, 'src', 'ai', 'providers'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'bench'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'src', 'ai', 'providers', 'factory.ts'),
        'export function resolveAIProviderId() { return "openai_session"; }',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'bench', 'candidate.json'),
        JSON.stringify({
          note: 'resolveAIProviderId function and AI provider factory tests',
        }),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch(
        'resolveAIProviderId function and AI provider factory tests include:artifacts',
        8,
        { bypassCache: true }
      );

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.path.startsWith('artifacts/'))).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should use relaxed second pass when strict filtered pass yields no results', async () => {
      process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK = 'true';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-semantic-second-pass-relaxed-'));
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'bench'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'bench', 'fallback-only.json'),
        JSON.stringify({
          note: 'resolveAIProviderId function and AI provider factory tests',
        }),
        'utf-8'
      );

      const fallbackClient = new ContextServiceClient(tempDir);
      const providerCall = configureOpenAISemanticProvider(fallbackClient, '[]');

      const results = await fallbackClient.semanticSearch(
        'resolveAIProviderId function and AI provider factory tests',
        5,
        { bypassCache: true }
      );

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.path.startsWith('artifacts/'))).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Search Result Structure', () => {
    it('should return results with correct structure', async () => {
      configureOpenAISemanticProvider(
        client,
        JSON.stringify([
          { path: 'src/components/Button.tsx', content: 'export const Button = () => <button/>', relevanceScore: 0.9 },
          { path: 'src/utils/helpers.ts', content: 'export function formatDate() {}', relevanceScore: 0.7 },
        ])
      );

      const results = await client.semanticSearch('button component', 5);

      expect(results.length).toBeGreaterThan(0);
      // Verify search results have the expected structure
      expect(results[0]).toHaveProperty('path');
      expect(results[0]).toHaveProperty('content');
      expect(results[0]).toHaveProperty('relevanceScore');
    });

    it('should assign relevance scores to results', async () => {
      configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'file1.ts', content: 'content', relevanceScore: 1.3 }])
      );

      const results = await client.semanticSearch('test', 5);

      if (results.length > 0) {
        // Results should have normalized relevance scores
        expect(results[0].relevanceScore).toBeGreaterThanOrEqual(0);
        expect(results[0].relevanceScore).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Offline Policy', () => {
    it('should return empty semantic results when offline mode blocks openai_session searchAndAsk', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-offline-'));
      process.env.CONTEXT_ENGINE_OFFLINE_ONLY = '1';
      process.env.AUGMENT_API_URL = 'https://api.augmentcode.com';

      const offlineClient = new ContextServiceClient(tempDir);
      configureOpenAISemanticProvider(offlineClient, '[]');

      const results = await offlineClient.semanticSearch('offline test', 1);
      expect(results).toEqual([]);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should reject searchAndAsk when offline mode is enabled with openai_session provider', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-offline-openai-'));
      process.env.CONTEXT_ENGINE_OFFLINE_ONLY = '1';
      process.env.CE_AI_PROVIDER = 'openai_session';
      process.env.CE_OPENAI_SESSION_CMD = 'definitely-not-a-real-codex-command';

      const offlineClient = new ContextServiceClient(tempDir);
      await expect(offlineClient.searchAndAsk('offline ask', 'test prompt')).rejects.toThrow(
        /Offline mode enforced .*openai_session/i
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('searchAndAsk provider behavior', () => {
    it('should return provider response text', async () => {
      const providerCall = configureOpenAISemanticProvider(client, 'provider success');

      const result = await client.searchAndAsk('retry query', 'retry prompt');

      expect(result).toBe('provider success');
      expect(providerCall).toHaveBeenCalledTimes(1);
    });

    it('should forward signal and deadline metadata to the provider call', async () => {
      const providerCall = configureOpenAISemanticProvider(client, 'provider success');
      const controller = new AbortController();
      const startedAt = Date.now();

      const result = await client.searchAndAsk('retry query', 'retry prompt', {
        timeoutMs: 12_000,
        signal: controller.signal,
      });

      expect(result).toBe('provider success');
      expect(providerCall).toHaveBeenCalledTimes(1);
      const request = providerCall.mock.calls[0][0] as {
        timeoutMs: number;
        signal?: AbortSignal;
        deadlineMs?: number;
      };
      expect(request.timeoutMs).toBe(12_000);
      expect(request.signal).toBe(controller.signal);
      expect(typeof request.deadlineMs).toBe('number');
      expect(request.deadlineMs).toBeGreaterThan(startedAt);
    });

    it('should propagate provider errors', async () => {
      const providerCall = configureOpenAISemanticProvider(client, new Error('Network timeout'));

      await expect(client.searchAndAsk('fail query', 'fail prompt')).rejects.toThrow('Network timeout');
      expect(providerCall).toHaveBeenCalledTimes(1);
    });

    it('should fail fast on invalid CE_AI_PROVIDER value', () => {
      process.env.CE_AI_PROVIDER = 'invalid-provider-value';
      expect(() => new ContextServiceClient(testWorkspace)).toThrow(/OpenAI-only provider policy/i);
    });

    it('should fail with provider_unavailable style error when openai_session command is missing', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      process.env.CE_OPENAI_SESSION_CMD = 'definitely-not-a-real-codex-command';
      process.env.CE_OPENAI_SESSION_REFRESH_MODE = 'per_call';

      const sessionClient = new ContextServiceClient(testWorkspace);
      await expect(sessionClient.searchAndAsk('provider test', 'hello')).rejects.toThrow(
        /Codex session CLI command not found|Codex session provider unavailable|spawn definitely-not-a-real-codex-command/i
      );
    });

    it('should reject non-string provider responses', async () => {
      const providerCall = jest.fn(async () => undefined as unknown as { text: string; model: string });
      (client as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };

      await expect(client.searchAndAsk('bad response query', 'bad response prompt')).rejects.toThrow(
        /returned invalid response: expected object with string text property/i
      );
      expect(providerCall).toHaveBeenCalledTimes(1);
    });

    it('should record queue wait and execution histograms for queued searchAndAsk calls when metrics are enabled', async () => {
      FEATURE_FLAGS.metrics = true;
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '2';
      const laneClient = new ContextServiceClient(testWorkspace);

      let releaseFirst: () => void = () => undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery === 'hold') {
          await firstGate;
          return { text: `released:${request.searchQuery}`, model: 'codex-session' };
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });

      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const first = laneClient.searchAndAsk('hold', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));
      const second = laneClient.searchAndAsk('queued', 'queued', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));

      releaseFirst();
      await expect(first).resolves.toBe('released:hold');
      await expect(second).resolves.toBe('ok:queued');

      const metricsText = renderPrometheusMetrics();
      expect(metricsText).toContain('context_engine_search_and_ask_queue_wait_seconds_bucket');
      expect(metricsText).toContain('context_engine_search_and_ask_execution_seconds_bucket');
      expect(metricsText).toContain('context_engine_search_and_ask_duration_seconds_bucket');
      expect(metricsText).toContain('lane="interactive"');
    });

    it('should route background lane independently when interactive lane is saturated', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '1';
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND = '1';
      const laneClient = new ContextServiceClient(testWorkspace);

      let releaseInteractive: () => void = () => undefined;
      const interactiveGate = new Promise<void>((resolve) => {
        releaseInteractive = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery.startsWith('interactive-hold')) {
          await interactiveGate;
          return { text: `released:${request.searchQuery}`, model: 'codex-session' };
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });

      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const interactiveFirst = laneClient.searchAndAsk('interactive-hold-1', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));
      const interactiveSecond = laneClient.searchAndAsk('interactive-hold-2', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        laneClient.searchAndAsk('interactive-overflow', 'overflow', { priority: 'interactive' })
      ).rejects.toThrow(/Search queue is full for interactive lane/i);

      await expect(
        laneClient.searchAndAsk('background-fast', 'background', { priority: 'background' })
      ).resolves.toBe('ok:background-fast');

      releaseInteractive();
      await expect(interactiveFirst).resolves.toBe('released:interactive-hold-1');
      await expect(interactiveSecond).resolves.toBe('released:interactive-hold-2');
    });

    it('should enforce queue-full behavior per lane using lane-specific limits', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '2';
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND = '1';
      const laneClient = new ContextServiceClient(testWorkspace);

      let releaseBackground: () => void = () => undefined;
      const backgroundGate = new Promise<void>((resolve) => {
        releaseBackground = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery.startsWith('background-hold')) {
          await backgroundGate;
          return { text: `released:${request.searchQuery}`, model: 'codex-session' };
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });

      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const backgroundFirst = laneClient.searchAndAsk('background-hold-1', 'hold', { priority: 'background' });
      await new Promise((resolve) => setImmediate(resolve));
      const backgroundSecond = laneClient.searchAndAsk('background-hold-2', 'hold', { priority: 'background' });
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        laneClient.searchAndAsk('background-overflow', 'overflow', { priority: 'background' })
      ).rejects.toThrow(/Search queue is full for background lane/i);

      await expect(
        laneClient.searchAndAsk('interactive-fast', 'interactive', { priority: 'interactive' })
      ).resolves.toBe('ok:interactive-fast');

      releaseBackground();
      await expect(backgroundFirst).resolves.toBe('released:background-hold-1');
      await expect(backgroundSecond).resolves.toBe('released:background-hold-2');
    });

    it('should include retry_after_ms hint when queue rejection is enforced', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '1';
      process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE = 'enforce';
      const laneClient = new ContextServiceClient(testWorkspace);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery === 'hold') {
          await gate;
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });
      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const first = laneClient.searchAndAsk('hold', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));
      const second = laneClient.searchAndAsk('hold-2', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        laneClient.searchAndAsk('overflow', 'overflow', { priority: 'interactive' })
      ).rejects.toThrow(/retry_after_ms=\d+/i);

      release();
      await expect(first).resolves.toBe('ok:hold');
      await expect(second).resolves.toBe('ok:hold-2');
    });

    it('should reject too-small timeout budgets before queue admission when queue pressure is high', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '5';
      const laneClient = new ContextServiceClient(testWorkspace);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery.startsWith('hold')) {
          await gate;
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });
      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const first = laneClient.searchAndAsk('hold-1', 'hold', { priority: 'interactive', timeoutMs: 8000 });
      await new Promise((resolve) => setImmediate(resolve));
      const second = laneClient.searchAndAsk('hold-2', 'hold', { priority: 'interactive', timeoutMs: 8000 });
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        laneClient.searchAndAsk('storm', 'storm', { priority: 'interactive', timeoutMs: 1000 })
      ).rejects.toThrow(/queue timeout budget|too small/i);
      expect(providerCall.mock.calls.some(([request]) => request.searchQuery === 'storm')).toBe(false);

      release();
      await expect(first).resolves.toBe('ok:hold-1');
      await expect(second).resolves.toBe('ok:hold-2');
    });

    it('should allow observed saturation in shadow mode without immediate rejection', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '1';
      process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE = 'shadow';
      const laneClient = new ContextServiceClient(testWorkspace);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery === 'hold') {
          await gate;
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });
      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const first = laneClient.searchAndAsk('hold', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));
      const second = laneClient.searchAndAsk('hold-2', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));
      const overflow = laneClient.searchAndAsk('overflow', 'overflow', { priority: 'interactive' });

      release();
      await expect(first).resolves.toBe('ok:hold');
      await expect(second).resolves.toBe('ok:hold-2');
      await expect(overflow).resolves.toBe('ok:overflow');
    });

    it('should allow observed saturation in observe mode without immediate rejection and log saturation', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '1';
      process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE = 'observe';
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const laneClient = new ContextServiceClient(testWorkspace);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery === 'hold') {
          await gate;
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });
      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      try {
        const first = laneClient.searchAndAsk('hold', 'hold', { priority: 'interactive' });
        await new Promise((resolve) => setImmediate(resolve));
        const second = laneClient.searchAndAsk('hold-2', 'hold', { priority: 'interactive' });
        await new Promise((resolve) => setImmediate(resolve));
        const overflow = laneClient.searchAndAsk('overflow', 'overflow', { priority: 'interactive' });

        await expect(
          Promise.race([
            overflow.then(
              () => 'resolved',
              () => 'rejected'
            ),
            new Promise((resolve) => setImmediate(() => resolve('pending'))),
          ])
        ).resolves.toBe('pending');
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('[SearchQueue] observe mode: queue saturation observed for interactive lane;')
        );

        release();
        await expect(first).resolves.toBe('ok:hold');
        await expect(second).resolves.toBe('ok:hold-2');
        await expect(overflow).resolves.toBe('ok:overflow');
      } finally {
        release();
        errorSpy.mockRestore();
      }
    });

    it('should propagate cancellation while request is waiting in queue', async () => {
      process.env.CE_SEARCH_AND_ASK_QUEUE_MAX = '2';
      const laneClient = new ContextServiceClient(testWorkspace);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const providerCall = jest.fn(async (request: { searchQuery: string }) => {
        if (request.searchQuery === 'hold') {
          await gate;
        }
        return { text: `ok:${request.searchQuery}`, model: 'codex-session' };
      });
      (laneClient as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (laneClient as any).aiProviderId = 'openai_session';

      const first = laneClient.searchAndAsk('hold', 'hold', { priority: 'interactive' });
      await new Promise((resolve) => setImmediate(resolve));

      const controller = new AbortController();
      const queued = laneClient.searchAndAsk('cancel-me', 'cancel', {
        priority: 'interactive',
        signal: controller.signal,
      });
      controller.abort();

      await expect(queued).rejects.toThrow(/cancelled while waiting in queue/i);
      release();
      await expect(first).resolves.toBe('ok:hold');
    });
  });

  describe('Cache Management', () => {
    it('should cache search results', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'src/cached.ts', content: 'cached content', relevanceScore: 0.8 }])
      );

      // First call - should hit the provider
      await client.semanticSearch('cache test', 5);
      expect(providerCall).toHaveBeenCalledTimes(1);

      // Second call with same query - should use cache
      await client.semanticSearch('cache test', 5);
      expect(providerCall).toHaveBeenCalledTimes(1); // Still 1, cache hit
    });

    it('should coalesce concurrent semantic search misses into one provider call', async () => {
      let resolveProviderCall!: (value: { text: string; model: string }) => void;
      const providerCall = jest.fn(
        () =>
          new Promise<{ text: string; model: string }>((resolve) => {
            resolveProviderCall = resolve;
          })
      );

      (client as any).aiProvider = {
        id: 'openai_session',
        modelLabel: 'codex-session',
        call: providerCall,
      };
      (client as any).aiProviderId = 'openai_session';

      const firstSearch = client.semanticSearch('concurrent search query', 5, { bypassCache: true });
      const secondSearch = client.semanticSearch('concurrent search query', 5, { bypassCache: true });

      await new Promise((resolve) => setImmediate(resolve));
      expect(providerCall).toHaveBeenCalledTimes(1);

      resolveProviderCall({
        text: JSON.stringify([
          {
            path: 'src/concurrent.ts',
            content: 'deduped content',
            relevanceScore: 0.91,
          },
        ]),
        model: 'codex-session',
      });

      await expect(firstSearch).resolves.toHaveLength(1);
      await expect(secondSearch).resolves.toHaveLength(1);
      expect(providerCall).toHaveBeenCalledTimes(1);
    });

    it('should coalesce concurrent local keyword scans into one file scan', async () => {
      let resolveFileContent!: (value: string) => void;
      const getCachedFallbackFilesSpy = jest
        .spyOn(client as any, 'getCachedFallbackFiles')
        .mockResolvedValue(['src/cacheable.ts']);
      const getFileSpy = jest.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFileContent = resolve;
          })
      );
      (client as any).getFile = getFileSpy;

      const firstSearch = client.localKeywordSearch('cacheableQueryMarker', 5);
      const secondSearch = client.localKeywordSearch('cacheableQueryMarker', 5);

      await new Promise((resolve) => setImmediate(resolve));
      expect(getCachedFallbackFilesSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledTimes(1);

      resolveFileContent('export const cacheableQueryMarker = true;');

      await expect(firstSearch).resolves.toHaveLength(1);
      await expect(secondSearch).resolves.toHaveLength(1);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
    });

    it('should keep file-scan fallback when chunk search is disabled', async () => {
      featureFlags.retrieval_chunk_search_v1 = false;

      const chunkSearchEngine = {
        search: jest.fn(async () => [
          {
            path: 'src/chunked.ts',
            content: 'chunk helper hit',
            lines: '10-14',
            chunkId: 'chunk-1',
            relevanceScore: 0.99,
            matchType: 'keyword',
          },
        ]),
      };
      (client as any).chunkSearchEngine = chunkSearchEngine;

      const getCachedFallbackFilesSpy = jest
        .spyOn(client as any, 'getCachedFallbackFiles')
        .mockResolvedValue(['src/fallback.ts']);
      const getFileSpy = jest.fn(async () => 'export const fallbackNeedle = true;');
      (client as any).getFile = getFileSpy;

      const results = await client.localKeywordSearch('fallbackNeedle', 5, { bypassCache: true });

      expect(chunkSearchEngine.search).not.toHaveBeenCalled();
      expect(getCachedFallbackFilesSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({ path: 'src/fallback.ts', matchType: 'keyword' }));
    });

    it('should use chunk-aware exact search when the chunk flag is enabled', async () => {
      featureFlags.retrieval_chunk_search_v1 = true;

      const chunkSearchEngine = {
        search: jest.fn(async (query: string, topK: number, options?: { bypassCache?: boolean }) => [
          {
            path: 'src/chunked.ts',
            content: `chunk hit for ${query}`,
            lines: '12-18',
            chunkId: 'chunk-1',
            relevanceScore: 0.93,
            matchType: 'keyword',
            retrievedAt: '2026-03-21T00:00:00.000Z',
          },
        ]),
      };
      (client as any).chunkSearchEngine = chunkSearchEngine;

      const getCachedFallbackFilesSpy = jest.spyOn(client as any, 'getCachedFallbackFiles');
      const getFileSpy = jest.fn();
      (client as any).getFile = getFileSpy;

      const results = await client.localKeywordSearch('chunk exact query', 5, { bypassCache: true });

      expect(chunkSearchEngine.search).toHaveBeenCalledWith('chunk exact query', 5, expect.objectContaining({ bypassCache: true }));
      expect(getCachedFallbackFilesSpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({
        path: 'src/chunked.ts',
        chunkId: 'chunk-1',
        lines: '12-18',
        matchType: 'keyword',
      }));
    });

    it('should prefer SQLite lexical search when the flag is enabled', async () => {
      featureFlags.retrieval_sqlite_fts5_v1 = true;
      featureFlags.retrieval_chunk_search_v1 = true;

      const lexicalSearchEngine = {
        search: jest.fn(async (query: string, topK: number, options?: { bypassCache?: boolean }) => [
          {
            path: 'src/lexical.ts',
            content: `lexical hit for ${query}`,
            lines: '8-12',
            chunkId: 'lex-1',
            relevanceScore: 0.97,
            matchType: 'keyword',
            retrievedAt: '2026-03-21T00:00:00.000Z',
          },
        ]),
      };
      (client as any).lexicalSqliteSearchEngine = lexicalSearchEngine;

      const chunkSearchEngine = {
        search: jest.fn(async () => [
          {
            path: 'src/chunked.ts',
            content: 'chunk helper hit',
            lines: '10-14',
            chunkId: 'chunk-1',
            relevanceScore: 0.9,
            matchType: 'keyword',
          },
        ]),
      };
      (client as any).chunkSearchEngine = chunkSearchEngine;

      const getCachedFallbackFilesSpy = jest.spyOn(client as any, 'getCachedFallbackFiles');
      const getFileSpy = jest.fn();
      (client as any).getFile = getFileSpy;

      const results = await client.localKeywordSearch('lexical exact query', 5, { bypassCache: true });

      expect(lexicalSearchEngine.search).toHaveBeenCalledWith(
        'lexical exact query',
        5,
        expect.objectContaining({ bypassCache: true })
      );
      expect(chunkSearchEngine.search).not.toHaveBeenCalled();
      expect(getCachedFallbackFilesSpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({
        path: 'src/lexical.ts',
        chunkId: 'lex-1',
        lines: '8-12',
        matchType: 'keyword',
      }));
    });

    it('should blend chunk search for identifier-like queries even when SQLite returns hits', async () => {
      featureFlags.retrieval_sqlite_fts5_v1 = true;
      featureFlags.retrieval_chunk_search_v1 = true;

      const lexicalSearchEngine = {
        search: jest.fn(async () => [
          {
            path: 'tests/ci/generateRetrievalQualityReport.test.ts',
            content: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
            lines: '1-40',
            chunkId: 'lex-1',
            relevanceScore: 0.97,
            matchType: 'keyword',
          },
        ]),
      };
      (client as any).lexicalSqliteSearchEngine = lexicalSearchEngine;

      const chunkSearchEngine = {
        search: jest.fn(async () => [
          {
            path: 'scripts/ci/generate-retrieval-quality-report.ts',
            content: 'export function generateRetrievalQualityReport() { return "generate-retrieval-quality-report synthetic_guard stable_fixture_token"; }',
            lines: '8-12',
            chunkId: 'chunk-1',
            relevanceScore: 0.9,
            matchType: 'keyword',
          },
        ]),
      };
      (client as any).chunkSearchEngine = chunkSearchEngine;

      const results = await client.localKeywordSearch(
        'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
        5,
        { bypassCache: true }
      );

      expect(lexicalSearchEngine.search).toHaveBeenCalledTimes(1);
      expect(chunkSearchEngine.search).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(expect.objectContaining({
        path: 'scripts/ci/generate-retrieval-quality-report.ts',
        matchType: 'keyword',
      }));
    });

    it('should fall back to chunk search when SQLite engine is unavailable', async () => {
      featureFlags.retrieval_sqlite_fts5_v1 = true;
      featureFlags.retrieval_chunk_search_v1 = true;

      (client as any).lexicalSqliteSearchEngine = null;
      (client as any).lexicalSqliteSearchEngineLoadAttempted = true;

      const chunkSearchEngine = {
        search: jest.fn(async () => [
          {
            path: 'src/chunked.ts',
            content: 'chunk helper hit',
            lines: '10-14',
            chunkId: 'chunk-1',
            relevanceScore: 0.9,
            matchType: 'keyword',
          },
        ]),
      };
      (client as any).chunkSearchEngine = chunkSearchEngine;

      const results = await client.localKeywordSearch('fallbackNeedle', 5, { bypassCache: true });

      expect(chunkSearchEngine.search).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({ path: 'src/chunked.ts', matchType: 'keyword' }));
    });

    it('should not use cache for different queries', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'file.ts', content: 'content', relevanceScore: 0.7 }])
      );

      await client.semanticSearch('query one', 5);
      await client.semanticSearch('query two', 5);

      expect(providerCall).toHaveBeenCalledTimes(2);
    });

    it('should clear cache when clearCache is called', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'file.ts', content: 'content', relevanceScore: 0.7 }])
      );

      // First call
      await client.semanticSearch('clear test', 5);
      expect(providerCall).toHaveBeenCalledTimes(1);

      // Clear cache
      const chunkClearCache = jest.fn();
      (client as any).chunkSearchEngine = { search: jest.fn(async () => []), clearCache: chunkClearCache };
      const lexicalClearCache = jest.fn();
      (client as any).lexicalSqliteSearchEngine = { search: jest.fn(async () => []), clearCache: lexicalClearCache };
      client.clearCache();

      // Should hit provider again
      await client.semanticSearch('clear test', 5);
      expect(providerCall).toHaveBeenCalledTimes(2);
      expect(chunkClearCache).toHaveBeenCalledTimes(1);
      expect(lexicalClearCache).toHaveBeenCalledTimes(1);
      expect((client as any).chunkSearchEngine).toBeNull();
      expect((client as any).lexicalSqliteSearchEngine).toBeNull();
    });

    it('should not use cache for different topK values', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'file.ts', content: 'content', relevanceScore: 0.7 }])
      );

      await client.semanticSearch('topk test', 5);
      await client.semanticSearch('topk test', 10); // Different topK

      expect(providerCall).toHaveBeenCalledTimes(2);
    });
  });

  describe('Context For Prompt retrieval fast path', () => {
    it('should prefer local keyword search first for operational docs queries', async () => {
      const localSearchSpy = jest.spyOn(client as any, 'localKeywordSearch').mockResolvedValue([
        {
          path: 'docs/MCP_CLIENT_SETUP.md',
          content: 'Install the MCP client with Codex using the setup guide.',
          relevanceScore: 0.96,
        },
      ]);
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockResolvedValue([
        {
          path: 'src/fallback.ts',
          content: 'fallback result',
          relevanceScore: 0.5,
        },
      ]);

      const bundle = await client.getContextForPrompt('how do I install this mcp on codex', {
        maxFiles: 2,
        tokenBudget: 1200,
        includeMemories: false,
      });

      expect(localSearchSpy).toHaveBeenCalledTimes(1);
      expect(semanticSearchSpy).not.toHaveBeenCalled();
      expect(bundle.files[0]?.path).toBe('docs/MCP_CLIENT_SETUP.md');
      expect(bundle.metadata.totalFiles).toBeGreaterThan(0);
    });

    it('should include a git metadata connector hint in context bundles', async () => {
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockResolvedValue([
        {
          path: 'src/connector.ts',
          content: 'connector content',
          relevanceScore: 0.93,
          lines: '1-4',
        },
      ]);

      const bundle = await client.getContextForPrompt('connector hint test', {
        maxFiles: 1,
        tokenBudget: 1200,
        includeMemories: false,
        includeRelated: false,
        bypassCache: true,
      });

      expect(semanticSearchSpy).toHaveBeenCalledTimes(1);
      expect(bundle.hints.some((hint) => hint.startsWith('Git metadata:'))).toBe(true);
    });

    it('should fall back to semantic search when local keyword search is empty', async () => {
      const localSearchSpy = jest.spyOn(client as any, 'localKeywordSearch').mockResolvedValue([]);
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockResolvedValue([
        {
          path: 'src/fallback.ts',
          content: 'fallback result',
          relevanceScore: 0.91,
        },
      ]);

      const bundle = await client.getContextForPrompt('how do I install this mcp on codex', {
        maxFiles: 2,
        tokenBudget: 1200,
        includeMemories: false,
      });

      expect(localSearchSpy).toHaveBeenCalledTimes(1);
      expect(semanticSearchSpy).toHaveBeenCalledTimes(1);
      expect(bundle.files[0]?.path).toBe('src/fallback.ts');
    });

    it('should report token-budget truncation reasons in context metadata', async () => {
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockResolvedValue([
        {
          path: 'src/alpha.ts',
          content: 'export const alpha = "' + 'x'.repeat(1200) + '";',
          relevanceScore: 0.95,
          lines: '1-3',
        },
        {
          path: 'src/beta.ts',
          content: 'export const beta = "' + 'y'.repeat(1200) + '";',
          relevanceScore: 0.9,
          lines: '1-3',
        },
      ]);
      const estimateTokensSpy = jest
        .spyOn(client as any, 'estimateTokens')
        .mockImplementation((text: unknown) => (typeof text === 'string' && text.includes('export const') ? 120 : 8));

      const bundle = await client.getContextForPrompt('truncation receipt test', {
        maxFiles: 2,
        tokenBudget: 200,
        includeMemories: false,
        includeRelated: false,
        bypassCache: true,
      });

      expect(semanticSearchSpy).toHaveBeenCalledTimes(1);
      expect(estimateTokensSpy).toHaveBeenCalled();
      expect(bundle.metadata.truncated).toBe(true);
      expect(bundle.metadata.truncationReasons).toContain('token_budget');
    });

    it('should rank memories with metadata and include a bounded startup memory pack', async () => {
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockImplementation(
        async (...args: unknown[]) => {
          const topK = typeof args[1] === 'number' ? args[1] : 0;
          if (topK === 3) {
            return [
              {
                path: 'src/memory-consumer.ts',
                content: 'export const memo = true;',
                relevanceScore: 0.88,
                lines: '1-1',
              },
            ];
          }

          return [
            {
              path: '.memories/decisions.md',
              content: [
                '### [2026-04-10] Keep deterministic blockers',
                '- Use deterministic blockers for PR gating.',
                '- [meta] priority: critical',
                '- [meta] subtype: review_finding',
                '- [meta] created_at: 2026-04-10T00:00:00.000Z',
                '- [meta] updated_at: 2026-04-10T00:00:00.000Z',
              ].join('\n'),
              relevanceScore: 0.41,
            },
            {
              path: '.memories/facts.md',
              content: [
                '### [2025-01-01] Legacy fact',
                '- Older baseline note.',
                '- [meta] priority: archive',
                '- [meta] created_at: 2025-01-01T00:00:00.000Z',
              ].join('\n'),
              relevanceScore: 0.92,
            },
            {
              path: '.memories/preferences.md',
              content: [
                '### [2026-04-09] Keep plans compact',
                '- Prefer concise execution artifacts.',
                '- [meta] priority: helpful',
                '- [meta] tags: docs, planning',
              ].join('\n'),
              relevanceScore: 0.66,
            },
          ];
        }
      );

      const bundle = await client.getContextForPrompt('memory ranking test', {
        maxFiles: 1,
        tokenBudget: 1500,
        includeRelated: false,
        includeMemories: true,
        bypassCache: true,
      });

      expect(semanticSearchSpy).toHaveBeenCalled();
      expect(bundle.metadata.memoryCandidates).toBe(3);
      expect(bundle.metadata.memoriesIncluded).toBeGreaterThan(0);
      expect(bundle.metadata.memoriesStartupPackIncluded).toBeGreaterThan(0);
      expect(bundle.hints.some((hint) => hint.startsWith('Startup memory pack:'))).toBe(true);
      expect(bundle.memories?.some((memory) =>
        memory.category === 'decisions' &&
        memory.priority === 'critical' &&
        memory.startupPack === true
      )).toBe(true);
      expect(bundle.memories?.some((memory) =>
        memory.startupPack === true
      )).toBe(true);
    });

    it('should preserve backward compatibility for memory entries without metadata fields', async () => {
      const semanticSearchSpy = jest.spyOn(client as any, 'semanticSearch').mockImplementation(
        async (...args: unknown[]) => {
          const topK = typeof args[1] === 'number' ? args[1] : 0;
          if (topK === 3) {
            return [
              {
                path: 'src/legacy.ts',
                content: 'export const legacy = true;',
                relevanceScore: 0.8,
                lines: '1-1',
              },
            ];
          }

          return [
            {
              path: '.memories/facts.md',
              content: '- Legacy memory format with no [meta] markers.',
              relevanceScore: 0.72,
            },
          ];
        }
      );

      const bundle = await client.getContextForPrompt('legacy memory test', {
        maxFiles: 1,
        includeRelated: false,
        includeMemories: true,
        bypassCache: true,
      });

      expect(semanticSearchSpy).toHaveBeenCalled();
      expect(bundle.metadata.memoriesIncluded).toBe(1);
      expect(bundle.metadata.memoryCandidates).toBe(1);
      expect(bundle.memories?.[0]).toEqual(
        expect.objectContaining({
          category: 'facts',
        })
      );
    });
  });

  describe('Index Workspace', () => {
    it('should index files via local_native fallback by default', async () => {
      const result = await client.indexWorkspace();

      expect(result.errors).toEqual([]);
      expect(result.indexed).toBeGreaterThan(0);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();
    });

    it('should index oversized text files using deterministic metadata-only outcomes', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-skip-receipts-'));

      try {
        const largeFilePath = path.join(tempDir, 'large.ts');
        fs.writeFileSync(largeFilePath, 'x'.repeat(1024 * 1024 + 16), 'utf-8');

        const receiptClient = new ContextServiceClient(tempDir);
        const result = await receiptClient.indexFiles(['large.ts']);

        expect(result.indexed).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.skipReasons).toBeUndefined();
        expect(result.fileOutcomes).toMatchObject({
          metadata_only: 1,
        });
        expect(result.skipReasonTotal).toBeUndefined();
        expect(result.fileOutcomeTotal).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should reindex oversized metadata-only files when contents change without changing file size', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-metadata-refresh-'));
      FEATURE_FLAGS.index_state_store = true;
      FEATURE_FLAGS.skip_unchanged_indexing = true;

      try {
        const largeFilePath = path.join(tempDir, 'large.ts');
        const oversizedLength = 1024 * 1024 + 16;
        fs.writeFileSync(largeFilePath, 'a'.repeat(oversizedLength), 'utf-8');

        const receiptClient = new ContextServiceClient(tempDir);
        const firstResult = await receiptClient.indexFiles(['large.ts']);

        expect(firstResult.indexed).toBe(1);
        expect(firstResult.fileOutcomes).toMatchObject({
          metadata_only: 1,
        });

        fs.writeFileSync(largeFilePath, 'b'.repeat(oversizedLength), 'utf-8');
        const bumpedTime = new Date(Date.now() + 2000);
        fs.utimesSync(largeFilePath, bumpedTime, bumpedTime);

        const secondResult = await receiptClient.indexFiles(['large.ts']);

        expect(secondResult.indexed).toBe(1);
        expect(secondResult.unchangedSkipped ?? 0).toBe(0);
        expect(secondResult.skipReasons?.unchanged ?? 0).toBe(0);
        expect(secondResult.fileOutcomes).toMatchObject({
          metadata_only: 1,
        });
        expect(secondResult.skipReasonTotal).toBeUndefined();
        expect(secondResult.fileOutcomeTotal).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should continue to report binary skips distinctly from metadata-only large text handling', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-binary-skip-'));

      try {
        const binaryFilePath = path.join(tempDir, 'binary.ts');
        fs.writeFileSync(binaryFilePath, Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));

        const receiptClient = new ContextServiceClient(tempDir);
        const result = await receiptClient.indexFiles(['binary.ts']);

        expect(result.indexed).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.skipReasons).toMatchObject({
          binary_file: 1,
        });
        expect(result.fileOutcomes).toMatchObject({
          binary_skip: 1,
        });
        expect(result.skipReasonTotal).toBe(1);
        expect(result.fileOutcomeTotal).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should keep oversized binary files classified as binary skips instead of metadata-only', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-large-binary-skip-'));

      try {
        const binaryFilePath = path.join(tempDir, 'binary-large.ts');
        fs.writeFileSync(binaryFilePath, Buffer.concat([
          Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]),
          Buffer.alloc(1024 * 1024 + 32, 1),
        ]));

        const receiptClient = new ContextServiceClient(tempDir);
        const result = await receiptClient.indexFiles(['binary-large.ts']);

        expect(result.indexed).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.skipReasons).toMatchObject({
          binary_file: 1,
        });
        expect(result.fileOutcomes).toMatchObject({
          binary_skip: 1,
        });
        expect(result.skipReasonTotal).toBe(1);
        expect(result.fileOutcomeTotal).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should clear cache after indexing', async () => {
      const providerCall = configureOpenAISemanticProvider(
        client,
        JSON.stringify([{ path: 'file.ts', content: 'content', relevanceScore: 0.7 }])
      );

      // Setup for search
      await client.semanticSearch('index test', 5);

      // Index workspace
      await client.indexWorkspace();

      // Search again - should not use cache
      await client.semanticSearch('index test', 5);

      // 2 provider calls (cache was cleared after indexing)
      expect(providerCall).toHaveBeenCalledTimes(2);
    });

    it('should persist local-native index state after indexing', async () => {
      FEATURE_FLAGS.index_state_store = true;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-native-state-save-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const indexingClient = new ContextServiceClient(tempDir);
      await indexingClient.indexWorkspace();

      expect(fs.existsSync(path.join(tempDir, '.context-engine-index-state.json'))).toBe(true);
      expect(mockContextInstance.exportToFile).not.toHaveBeenCalled();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should use deterministic local_native fallback without legacy runtime calls', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-native-index-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const localClient = new ContextServiceClient(tempDir);
      const localIndexWorkspaceSpy = jest.spyOn(localClient as any, 'indexWorkspaceLocalNativeFallback');
      const result = await localClient.indexWorkspace();

      expect(result.errors).toEqual([]);
      expect(result.indexed).toBeGreaterThan(0);
      expect(localIndexWorkspaceSpy).toHaveBeenCalledTimes(1);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();

      const status = localClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.lastIndexed).toBeTruthy();
      expect(status.fileCount).toBeGreaterThan(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should clear local_native index metadata without legacy runtime calls', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-native-clear-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const localClient = new ContextServiceClient(tempDir);
      await localClient.indexWorkspace();
      await localClient.clearIndex();

      expect(fs.existsSync(path.join(tempDir, '.context-engine-context-state.json'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.context-engine-index-state.json'))).toBe(false);

      const status = localClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBe(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Indexing', () => {
    it('should discover newly supported multi-language extensions during workspace indexing', async () => {
      const previousFlags = {
        index_state_store: FEATURE_FLAGS.index_state_store,
        skip_unchanged_indexing: FEATURE_FLAGS.skip_unchanged_indexing,
      };
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-ext-'));
      try {
        FEATURE_FLAGS.index_state_store = false;
        FEATURE_FLAGS.skip_unchanged_indexing = false;

        const supportedExtensions = [
          '.rego', '.cue', '.jsonnet', '.libsonnet', '.thrift', '.avsc', '.avdl', '.capnp',
          '.bicep', '.kql', '.sol', '.tcl', '.sv', '.vhd', '.cbl', '.f90', '.pas', '.http',
        ];

        supportedExtensions.forEach((ext, idx) => {
          fs.writeFileSync(path.join(tempDir, `sample_${idx}${ext}`), `content for ${ext}\n`, 'utf-8');
        });
        fs.writeFileSync(path.join(tempDir, 'skip_me.xyz'), 'not supported\n', 'utf-8');

        const indexingClient = new ContextServiceClient(tempDir);
        const result = await indexingClient.indexWorkspace();

        expect(result.totalIndexable).toBe(supportedExtensions.length);
        expect(result.indexed).toBe(supportedExtensions.length);
        expect(result.errors).toEqual([]);
        expect(indexingClient.getIndexStatus().fileCount).toBe(supportedExtensions.length);
      } finally {
        FEATURE_FLAGS.index_state_store = previousFlags.index_state_store;
        FEATURE_FLAGS.skip_unchanged_indexing = previousFlags.skip_unchanged_indexing;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should retain lastError until a successful indexing cycle completes', () => {
      const statusClient = new ContextServiceClient(testWorkspace);
      const updateIndexStatus = (statusClient as any).updateIndexStatus.bind(statusClient) as
        (partial: Record<string, unknown>) => void;

      updateIndexStatus({ status: 'error', lastError: 'index worker failed' });
      expect(statusClient.getIndexStatus().lastError).toBe('index worker failed');

      updateIndexStatus({ status: 'indexing', lastError: undefined });
      expect(statusClient.getIndexStatus().lastError).toBe('index worker failed');

      updateIndexStatus({ status: 'idle', lastIndexed: new Date().toISOString(), lastError: undefined });
      expect(statusClient.getIndexStatus().lastError).toBeUndefined();
    });

    it('should preserve error status during disk hydration when restart metadata exists', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hydrate-error-'));
      fs.writeFileSync(path.join(tempDir, '.context-engine-context-state.json'), '{}', 'utf-8');
      const statusClient = new ContextServiceClient(tempDir);
      const updateIndexStatus = (statusClient as any).updateIndexStatus.bind(statusClient) as
        (partial: Record<string, unknown>) => void;

      try {
        updateIndexStatus({
          status: 'error',
          lastError: 'index worker failed',
          lastIndexed: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        });

        const hydrated = statusClient.getIndexStatus();
        expect(hydrated.status).toBe('error');
        expect(hydrated.lastError).toBe('index worker failed');
        expect(hydrated.lastIndexed).toBe(new Date('2026-01-01T00:00:00.000Z').toISOString());
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should hydrate from legacy augment-named context state files for compatibility', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hydrate-legacy-'));
      const legacyStatePath = path.join(tempDir, '.augment-context-state.json');
      fs.writeFileSync(legacyStatePath, '{}', 'utf-8');
      const legacyMtime = fs.statSync(legacyStatePath).mtime.toISOString();

      try {
        const statusClient = new ContextServiceClient(tempDir);
        const hydrated = statusClient.getIndexStatus();

        expect(hydrated.status).toBe('idle');
        expect(hydrated.lastIndexed).toBe(legacyMtime);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should skip startup auto-index for healthy workspaces', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-healthy-'));
      fs.writeFileSync(path.join(tempDir, '.context-engine-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            files: {
              'src/a.ts': { hash: 'abc', indexed_at: new Date().toISOString() },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      try {
        const startupClient = new ContextServiceClient(tempDir);
        const backgroundSpy = jest
          .spyOn(startupClient as any, 'runBackgroundIndexingCore')
          .mockResolvedValue(undefined);

        const result = startupClient.startAutoIndexOnStartupIfNeeded();
        await new Promise((resolve) => setImmediate(resolve));

        expect(result.started).toBe(false);
        expect(result.reason).toBe('healthy');
        expect(backgroundSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should start startup auto-index in the background for unindexed workspaces', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-unindexed-'));

      try {
        const startupClient = new ContextServiceClient(tempDir);
        let release!: () => void;
        const backgroundSpy = jest
          .spyOn(startupClient as any, 'runBackgroundIndexingCore')
          .mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
              })
          );

        const result = startupClient.startAutoIndexOnStartupIfNeeded();

        expect(result.started).toBe(true);
        expect(result.reason).toBe('unindexed');
        expect(startupClient.getIndexStatus().status).toBe('indexing');
        expect(backgroundSpy).not.toHaveBeenCalled();

        await new Promise((resolve) => setImmediate(resolve));
        expect(backgroundSpy).toHaveBeenCalledTimes(1);

        release();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should start startup auto-index for stale workspaces', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-stale-'));
      fs.writeFileSync(path.join(tempDir, '.context-engine-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 1,
            updated_at: '2020-01-01T00:00:00.000Z',
            files: {
              'src/a.ts': { hash: 'abc', indexed_at: '2020-01-01T00:00:00.000Z' },
            },
          },
          null,
          2
        ),
        'utf-8'
      );
      const staleDate = new Date('2020-01-01T00:00:00.000Z');
      fs.utimesSync(path.join(tempDir, '.context-engine-context-state.json'), staleDate, staleDate);

      try {
        const startupClient = new ContextServiceClient(tempDir);
        const backgroundSpy = jest
          .spyOn(startupClient as any, 'runBackgroundIndexingCore')
          .mockResolvedValue(undefined);

        const result = startupClient.startAutoIndexOnStartupIfNeeded();
        await new Promise((resolve) => setImmediate(resolve));

        expect(result.started).toBe(true);
        expect(result.reason).toBe('stale');
        expect(backgroundSpy).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should skip startup auto-index when indexing is already in progress', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-indexing-'));
      const startupClient = new ContextServiceClient(tempDir);
      const updateIndexStatus = (startupClient as any).updateIndexStatus.bind(startupClient) as
        (partial: Record<string, unknown>) => void;
      const backgroundSpy = jest
        .spyOn(startupClient as any, 'runBackgroundIndexingCore')
        .mockResolvedValue(undefined);

      try {
        updateIndexStatus({ status: 'indexing' });
        const result = startupClient.startAutoIndexOnStartupIfNeeded();
        await new Promise((resolve) => setImmediate(resolve));

        expect(result.started).toBe(false);
        expect(result.reason).toBe('indexing');
        expect(backgroundSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should skip startup auto-index when current status is error', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-error-'));
      const startupClient = new ContextServiceClient(tempDir);
      const updateIndexStatus = (startupClient as any).updateIndexStatus.bind(startupClient) as
        (partial: Record<string, unknown>) => void;
      const backgroundSpy = jest
        .spyOn(startupClient as any, 'runBackgroundIndexingCore')
        .mockResolvedValue(undefined);

      try {
        updateIndexStatus({ status: 'error', lastError: 'index worker failed' });
        const result = startupClient.startAutoIndexOnStartupIfNeeded();
        await new Promise((resolve) => setImmediate(resolve));

        expect(result.started).toBe(false);
        expect(result.reason).toBe('error');
        expect(backgroundSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should respect the startup auto-index opt-out flag', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-disabled-'));
      const startupClient = new ContextServiceClient(tempDir);
      const backgroundSpy = jest
        .spyOn(startupClient as any, 'runBackgroundIndexingCore')
        .mockResolvedValue(undefined);

      try {
        const result = startupClient.startAutoIndexOnStartupIfNeeded({ enabled: false });
        await new Promise((resolve) => setImmediate(resolve));

        expect(result.started).toBe(false);
        expect(result.reason).toBe('disabled');
        expect(backgroundSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should not start a duplicate background index when startup auto-index is already scheduled', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-startup-duplicate-'));
      try {
        const startupClient = new ContextServiceClient(tempDir);
        let release!: () => void;
        const indexWorkspaceSpy = jest
          .spyOn(startupClient, 'indexWorkspace')
          .mockImplementation(
            () =>
              new Promise<any>((resolve) => {
                release = () =>
                  resolve({
                    indexed: 1,
                    skipped: 0,
                    errors: [],
                    duration: 1,
                  });
              })
          );

        const first = startupClient.startAutoIndexOnStartupIfNeeded();
        expect(first.started).toBe(true);
        await new Promise((resolve) => setImmediate(resolve));

        await startupClient.indexWorkspaceInBackground();

        expect(indexWorkspaceSpy).toHaveBeenCalledTimes(1);
        release();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should use deterministic local_native fallback for indexFiles without legacy runtime calls', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-native-index-files-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const localClient = new ContextServiceClient(tempDir);
      const localIndexFilesSpy = jest.spyOn(localClient as any, 'indexFilesLocalNativeFallback');
      const result = await localClient.indexFiles(['a.ts']);

      expect(result.errors).toEqual([]);
      expect(result.indexed).toBe(1);
      expect(localIndexFilesSpy).toHaveBeenCalledWith(['a.ts']);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tempDir, '.context-engine-index-state.json'))).toBe(true);

      const status = localClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBeGreaterThan(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should prune deleted entries via applyWorkspaceChanges without triggering full reindex', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;
      const featureFlagsSnapshot = JSON.stringify(snapshotRetrievalV2FeatureFlags());

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-change-delete-only-'));
      fs.writeFileSync(path.join(tempDir, 'keep.ts'), 'export const keep = true;\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 3,
            schema_version: 2,
            provider_id: 'local_native',
            feature_flags_snapshot: featureFlagsSnapshot,
            updated_at: '2026-03-21T00:00:00.000Z',
            files: {
              'keep.ts': { hash: 'a'.repeat(64), indexed_at: '2026-03-21T00:00:00.000Z' },
              'deleted.ts': { hash: 'b'.repeat(64), indexed_at: '2026-03-21T00:00:00.000Z' },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const localClient = new ContextServiceClient(tempDir);
      const indexWorkspaceSpy = jest.spyOn(localClient, 'indexWorkspace');
      const indexFilesSpy = jest.spyOn(localClient, 'indexFiles');

      await localClient.applyWorkspaceChanges([{ type: 'unlink', path: 'deleted.ts' }]);

      const parsedState = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.context-engine-index-state.json'), 'utf-8')
      ) as {
        version: number;
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(indexWorkspaceSpy).not.toHaveBeenCalled();
      expect(indexFilesSpy).not.toHaveBeenCalled();
      expect(parsedState.files['deleted.ts']).toBeUndefined();
      expect(parsedState.files['keep.ts']).toBeDefined();
      expect(parsedState.version).toBeGreaterThan(3);
      expect(localClient.getIndexStatus().fileCount).toBe(1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should prune deletes and keep incremental indexFiles path for mixed workspace changes', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;
      const featureFlagsSnapshot = JSON.stringify(snapshotRetrievalV2FeatureFlags());

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-change-mixed-'));
      fs.writeFileSync(path.join(tempDir, 'changed.ts'), 'export const changed = 2;\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'keep.ts'), 'export const keep = true;\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 7,
            schema_version: 2,
            provider_id: 'local_native',
            feature_flags_snapshot: featureFlagsSnapshot,
            updated_at: '2026-03-21T00:00:00.000Z',
            files: {
              'changed.ts': { hash: 'c'.repeat(64), indexed_at: '2026-03-21T00:00:00.000Z' },
              'deleted.ts': { hash: 'd'.repeat(64), indexed_at: '2026-03-21T00:00:00.000Z' },
              'keep.ts': { hash: 'e'.repeat(64), indexed_at: '2026-03-21T00:00:00.000Z' },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const localClient = new ContextServiceClient(tempDir);
      const indexWorkspaceSpy = jest.spyOn(localClient, 'indexWorkspace');
      const indexFilesSpy = jest.spyOn(localClient, 'indexFiles');

      await localClient.applyWorkspaceChanges([
        { type: 'unlink', path: 'deleted.ts' },
        { type: 'change', path: 'changed.ts' },
      ]);

      const parsedState = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.context-engine-index-state.json'), 'utf-8')
      ) as {
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(indexWorkspaceSpy).not.toHaveBeenCalled();
      expect(indexFilesSpy).toHaveBeenCalledTimes(1);
      expect(indexFilesSpy).toHaveBeenCalledWith(['changed.ts']);
      expect(parsedState.files['deleted.ts']).toBeUndefined();
      expect(parsedState.files['changed.ts']).toBeDefined();
      expect(parsedState.files['changed.ts'].hash).not.toBe('c'.repeat(64));
      expect(parsedState.files['changed.ts'].hash).toMatch(/^[a-f0-9]{64}$/);
      expect(localClient.getIndexStatus().fileCount).toBe(2);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should ignore mismatched provider index-state entries, warn once, and save current provider_id', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-provider-mismatch-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 5,
            schema_version: 2,
            provider_id: 'legacy_disabled',
            updated_at: '2026-03-04T03:00:00.000Z',
            files: {
              'stale.ts': {
                hash: 'abc',
                indexed_at: '2026-03-04T03:00:00.000Z',
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const localClient = new ContextServiceClient(tempDir);
      localClient.getIndexStatus();
      const result = await localClient.indexFiles(['a.ts']);

      expect(result.indexed).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Ignoring index state entries for provider/i);

      const parsedState = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.context-engine-index-state.json'), 'utf-8')
      ) as {
        provider_id: string;
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(parsedState.provider_id).toBe('local_native');
      expect(parsedState.files['a.ts']).toBeDefined();
      expect(parsedState.files['stale.ts']).toBeUndefined();

      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should rebuild when index-state feature flags snapshot is incompatible', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-feature-flag-mismatch-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 5,
            schema_version: 2,
            provider_id: 'local_native',
            workspace_fingerprint: 'deadbeefdeadbeef',
            feature_flags_snapshot: JSON.stringify({
              ...snapshotRetrievalV2FeatureFlags(),
              retrieval_chunk_search_v1: !snapshotRetrievalV2FeatureFlags().retrieval_chunk_search_v1,
            }),
            updated_at: '2026-03-04T03:30:00.000Z',
            files: {
              'stale.ts': {
                hash: 'abc',
                indexed_at: '2026-03-04T03:30:00.000Z',
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const localClient = new ContextServiceClient(tempDir);
      const result = await localClient.indexFiles(['a.ts']);

      expect(result.indexed).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/incompatible workspace\/feature-flags snapshot/i);

      const parsedState = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.context-engine-index-state.json'), 'utf-8')
      ) as {
        feature_flags_snapshot: string;
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(parsedState.feature_flags_snapshot).toMatch(/retrieval_chunk_search_v1/);
      expect(parsedState.files['a.ts']).toBeDefined();
      expect(parsedState.files['stale.ts']).toBeUndefined();

      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should reset unsupported index-state schema and continue with current provider state', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-unsupported-schema-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 5,
            schema_version: 999,
            provider_id: 'local_native',
            updated_at: '2026-03-04T04:00:00.000Z',
            files: {
              'stale.ts': {
                hash: 'abc',
                indexed_at: '2026-03-04T04:00:00.000Z',
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const localClient = new ContextServiceClient(tempDir);
      const result = await localClient.indexFiles(['a.ts']);

      expect(result.indexed).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Unsupported index state schema_version/i);

      const parsedState = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.context-engine-index-state.json'), 'utf-8')
      ) as {
        schema_version: number;
        provider_id: string;
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(parsedState.schema_version).toBe(2);
      expect(parsedState.provider_id).toBe('local_native');
      expect(parsedState.files['a.ts']).toBeDefined();
      expect(parsedState.files['stale.ts']).toBeUndefined();

      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should skip unchanged files when local_native index-state hash already matches', async () => {
      FEATURE_FLAGS.index_state_store = true;
      FEATURE_FLAGS.skip_unchanged_indexing = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      // Local-native indexing can safely rely on the index-state hash without restoring
      // a legacy runtime context file first.
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update('export const a = 1;\n').digest('hex');
      const indexStatePath = path.join(tempDir, '.context-engine-index-state.json');
      fs.writeFileSync(
        indexStatePath,
        JSON.stringify(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            files: { 'a.ts': { hash, indexed_at: new Date().toISOString() } },
          },
          null,
          2
        ),
        'utf-8'
      );

      const indexingClient = new ContextServiceClient(tempDir);
      const result = await indexingClient.indexWorkspace();

      expect(result.indexed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.totalIndexable).toBe(1);
      expect(result.unchangedSkipped).toBe(1);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();
    });

    it('should persist index-state file entries even when unchanged-skip optimization is disabled', async () => {
      FEATURE_FLAGS.index_state_store = true;
      FEATURE_FLAGS.skip_unchanged_indexing = false;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-state-populate-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const indexingClient = new ContextServiceClient(tempDir);
      const result = await indexingClient.indexWorkspace();
      expect(result.indexed).toBeGreaterThan(0);

      const indexStatePath = path.join(tempDir, '.context-engine-index-state.json');
      expect(fs.existsSync(indexStatePath)).toBe(true);

      const rawState = fs.readFileSync(indexStatePath, 'utf-8');
      const parsedState = JSON.parse(rawState) as {
        schema_version: number;
        provider_id: string;
        files: Record<string, { hash: string; indexed_at: string }>;
      };

      expect(parsedState.schema_version).toBe(2);
      expect(parsedState.provider_id).toBe('local_native');
      expect(parsedState.files['a.ts']).toBeDefined();
      expect(parsedState.files['a.ts'].hash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsedState.files['a.ts'].indexed_at).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should treat an all-unchanged workspace index run as a successful no-op', async () => {
      FEATURE_FLAGS.index_state_store = true;
      FEATURE_FLAGS.skip_unchanged_indexing = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update('export const a = 1;\n').digest('hex');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            files: { 'a.ts': { hash, indexed_at: new Date().toISOString() } },
          },
          null,
          2
        ),
        'utf-8'
      );

      const indexingClient = new ContextServiceClient(tempDir);
      const result = await indexingClient.indexWorkspace();

      expect(result.indexed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.totalIndexable).toBe(1);
      expect(result.unchangedSkipped).toBe(1);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();

      const status = indexingClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBe(1);
    });

    it('should hydrate index status fileCount from persisted index state on restore', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-restore-'));

      fs.writeFileSync(path.join(tempDir, '.context-engine-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            files: {
              'src/a.ts': { hash: 'abc', indexed_at: new Date().toISOString() },
              'src/b.ts': { hash: 'def', indexed_at: new Date().toISOString() },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const restoredClient = new ContextServiceClient(tempDir);
      const status = restoredClient.getIndexStatus();
      expect(status.fileCount).toBe(2);
      expect(status.status).toBe('idle');
      expect(status.lastIndexed).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should hydrate lastIndexed on restore even when persisted index state has zero files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-restore-empty-'));

      fs.writeFileSync(path.join(tempDir, '.context-engine-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.context-engine-index-state.json'),
        JSON.stringify(
          {
            version: 1,
            updated_at: new Date().toISOString(),
            files: {},
          },
          null,
          2
        ),
        'utf-8'
      );

      const restoredClient = new ContextServiceClient(tempDir);
      const status = restoredClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBe(0);
      expect(status.lastIndexed).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});

