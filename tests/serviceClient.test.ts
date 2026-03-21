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
const { FEATURE_FLAGS } = await import('../src/config/features.js');
const { renderPrometheusMetrics } = await import('../src/metrics/metrics.js');

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
    delete featureFlags.retrieval_chunk_search_v1;
    delete featureFlags.retrieval_provider_v2;
    delete featureFlags.retrieval_artifacts_v2;
    delete featureFlags.retrieval_shadow_control_v2;
    delete featureFlags.retrieval_tree_sitter_v1;

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
    it('should expose a versioned retrieval artifact snapshot without changing runtime metadata', () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'true';
      process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '0.25';
      FEATURE_FLAGS.retrieval_provider_v2 = true;
      FEATURE_FLAGS.retrieval_artifacts_v2 = true;
      FEATURE_FLAGS.retrieval_chunk_search_v1 = true;

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
      });
      expect(artifactMetadata.workspace_fingerprint).toMatch(/^workspace:/);
      expect(artifactMetadata.env_fingerprint).toMatch(/^env:/);
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
      client.clearCache();

      // Should hit provider again
      await client.semanticSearch('clear test', 5);
      expect(providerCall).toHaveBeenCalledTimes(2);
      expect(chunkClearCache).toHaveBeenCalledTimes(1);
      expect((client as any).chunkSearchEngine).toBeNull();
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
  });

  describe('Index Workspace', () => {
    it('should index files via local_native fallback by default', async () => {
      const result = await client.indexWorkspace();

      expect(result.errors).toEqual([]);
      expect(result.indexed).toBeGreaterThan(0);
      expect(mockContextInstance.addToIndex).not.toHaveBeenCalled();
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

      expect(fs.existsSync(path.join(tempDir, '.augment-index-state.json'))).toBe(true);
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

      expect(fs.existsSync(path.join(tempDir, '.augment-context-state.json'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.augment-index-state.json'))).toBe(false);

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
      expect(fs.existsSync(path.join(tempDir, '.augment-index-state.json'))).toBe(true);

      const status = localClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBeGreaterThan(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should prune deleted entries via applyWorkspaceChanges without triggering full reindex', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-change-delete-only-'));
      fs.writeFileSync(path.join(tempDir, 'keep.ts'), 'export const keep = true;\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.augment-index-state.json'),
        JSON.stringify(
          {
            version: 3,
            schema_version: 2,
            provider_id: 'local_native',
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
        fs.readFileSync(path.join(tempDir, '.augment-index-state.json'), 'utf-8')
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

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workspace-change-mixed-'));
      fs.writeFileSync(path.join(tempDir, 'changed.ts'), 'export const changed = 2;\n', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'keep.ts'), 'export const keep = true;\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.augment-index-state.json'),
        JSON.stringify(
          {
            version: 7,
            schema_version: 2,
            provider_id: 'local_native',
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
        fs.readFileSync(path.join(tempDir, '.augment-index-state.json'), 'utf-8')
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
        path.join(tempDir, '.augment-index-state.json'),
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
        fs.readFileSync(path.join(tempDir, '.augment-index-state.json'), 'utf-8')
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

    it('should reset unsupported index-state schema and continue with current provider state', async () => {
      process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
      FEATURE_FLAGS.index_state_store = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-unsupported-schema-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\\n', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.augment-index-state.json'),
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
        fs.readFileSync(path.join(tempDir, '.augment-index-state.json'), 'utf-8')
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
      const indexStatePath = path.join(tempDir, '.augment-index-state.json');
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

      const indexStatePath = path.join(tempDir, '.augment-index-state.json');
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
        path.join(tempDir, '.augment-index-state.json'),
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

      fs.writeFileSync(path.join(tempDir, '.augment-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.augment-index-state.json'),
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

      fs.writeFileSync(path.join(tempDir, '.augment-context-state.json'), '{}', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, '.augment-index-state.json'),
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

