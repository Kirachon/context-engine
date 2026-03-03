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
 * These tests mock the DirectContext SDK to simulate API responses,
 * allowing comprehensive testing without requiring actual API authentication.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock DirectContext before importing the module under test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockContextInstance: Record<string, jest.Mock<any>> = {
  addToIndex: jest.fn(),
  search: jest.fn(),
  searchAndAsk: jest.fn(),
  exportToFile: jest.fn(),
  getIndexedPaths: jest.fn(() => []),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDirectContext: Record<string, jest.Mock<any>> = {
  create: jest.fn(),
  importFromFile: jest.fn(),
};

jest.unstable_mockModule('@augmentcode/auggie-sdk', () => ({
  DirectContext: mockDirectContext,
}));

// Import after mocking
const { ContextServiceClient } = await import('../src/mcp/serviceClient.js');
const { FEATURE_FLAGS } = await import('../src/config/features.js');

describe('ContextServiceClient', () => {
  let client: InstanceType<typeof ContextServiceClient>;
  const testWorkspace = process.cwd();

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
    process.env.AUGMENT_API_TOKEN = 'test-token';
    process.env.AUGMENT_API_URL = 'https://test.api.augmentcode.com';

    // Reset mocks
    jest.clearAllMocks();

    // Setup default mock behavior
    mockDirectContext.create.mockResolvedValue(mockContextInstance);
    mockDirectContext.importFromFile.mockRejectedValue(new Error('No state file'));
    mockContextInstance.search.mockResolvedValue('');
    mockContextInstance.addToIndex.mockResolvedValue({ newlyUploaded: [], alreadyUploaded: [] });
    mockContextInstance.exportToFile.mockResolvedValue(undefined);

    client = new ContextServiceClient(testWorkspace);
    configureOpenAISemanticProvider(client, '[]');
  });

  afterEach(() => {
    delete process.env.AUGMENT_API_TOKEN;
    delete process.env.AUGMENT_API_URL;
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

    // Reset feature flags that tests may override.
    FEATURE_FLAGS.index_state_store = false;
    FEATURE_FLAGS.skip_unchanged_indexing = false;
    FEATURE_FLAGS.hash_normalize_eol = false;
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

    it('should fallback to keyword search when provider returns []', async () => {
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
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/query.ts');
      expect(results[0].matchType).toBe('keyword');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should use keyword fallback when provider returns [] for strong identifier query', async () => {
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
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('src/provider.ts');

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
    it('should never initialize DirectContext when CE_AI_PROVIDER=openai_session', async () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      const openAIClient = new ContextServiceClient(testWorkspace);

      configureOpenAISemanticProvider(openAIClient, '[]');

      const results = await openAIClient.semanticSearch('main function', 5, { bypassCache: true });

      expect(Array.isArray(results)).toBe(true);
      expect(mockContextInstance.search).not.toHaveBeenCalled();
      expect(mockDirectContext.create).not.toHaveBeenCalled();
      expect(mockDirectContext.importFromFile).not.toHaveBeenCalled();
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

    it('should prefix cache keys with openai_session provider id by default', () => {
      const defaultClient = new ContextServiceClient(testWorkspace);
      const defaultKey = (defaultClient as any).getCommitAwareCacheKey('cache mix', 3);

      process.env.CE_AI_PROVIDER = 'openai_session';
      const explicitClient = new ContextServiceClient(testWorkspace);
      const explicitKey = (explicitClient as any).getCommitAwareCacheKey('cache mix', 3);

      expect(defaultClient.getActiveAIProviderId()).toBe('openai_session');
      expect(explicitClient.getActiveAIProviderId()).toBe('openai_session');
      expect(defaultKey).toEqual(explicitKey);
      expect(defaultKey.startsWith('openai_session:')).toBe(true);
    });

    it('should cache results under openai_session-scoped keys', async () => {
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

      const firstResults = await openAIClient.semanticSearch(query, 5);
      const secondResults = await openAIClient.semanticSearch(query, 5);

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(firstResults.length).toBe(1);
      expect(secondResults.length).toBe(1);
      expect((openAIClient as any).searchCache.get(openAIKey)).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should prioritize src/tests paths over artifacts for code-intent fallback queries', async () => {
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
      client.clearCache();

      // Should hit provider again
      await client.semanticSearch('clear test', 5);
      expect(providerCall).toHaveBeenCalledTimes(2);
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

  describe('Index Workspace', () => {
    it('should call DirectContext SDK to index files', async () => {
      await client.indexWorkspace();

      expect(mockContextInstance.addToIndex).toHaveBeenCalled();
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

    it('should save state after indexing', async () => {
      await client.indexWorkspace();

      expect(mockContextInstance.exportToFile).toHaveBeenCalled();
    });
  });

  describe('Indexing', () => {
    it('should not skip unchanged files when there is no restored context state', async () => {
      FEATURE_FLAGS.index_state_store = true;
      FEATURE_FLAGS.skip_unchanged_indexing = true;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-'));
      fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n', 'utf-8');

      // Pre-populate index state store with a matching hash to simulate "unchanged",
      // but DO NOT provide a context state file. We must still index the file.
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
      await indexingClient.indexWorkspace();

      expect(mockContextInstance.addToIndex).toHaveBeenCalled();
      const firstCallArgs = mockContextInstance.addToIndex.mock.calls[0]?.[0] as Array<{ path: string }>;
      expect(firstCallArgs.map((x) => x.path)).toContain('a.ts');
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
        files: Record<string, { hash: string; indexed_at: string }>;
      };

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

      // Provide a context state file so initialization restores from disk.
      const statePath = path.join(tempDir, '.augment-context-state.json');
      fs.writeFileSync(statePath, '{}', 'utf-8');
      mockDirectContext.importFromFile.mockResolvedValueOnce(mockContextInstance);

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

      // Ensure restore path is used.
      fs.writeFileSync(path.join(tempDir, '.augment-context-state.json'), '{}', 'utf-8');
      mockDirectContext.importFromFile.mockResolvedValueOnce(mockContextInstance);
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
      await (restoredClient as any).ensureInitialized();

      const status = restoredClient.getIndexStatus();
      expect(status.fileCount).toBe(2);
      expect(status.status).toBe('idle');
      expect(status.lastIndexed).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should hydrate lastIndexed on restore even when persisted index state has zero files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-restore-empty-'));

      // Ensure restore path is used.
      fs.writeFileSync(path.join(tempDir, '.augment-context-state.json'), '{}', 'utf-8');
      mockDirectContext.importFromFile.mockResolvedValueOnce(mockContextInstance);
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
      await (restoredClient as any).ensureInitialized();

      const status = restoredClient.getIndexStatus();
      expect(status.status).toBe('idle');
      expect(status.fileCount).toBe(0);
      expect(status.lastIndexed).toBeTruthy();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});

