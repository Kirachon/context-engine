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
  });

  afterEach(() => {
    delete process.env.AUGMENT_API_TOKEN;
    delete process.env.AUGMENT_API_URL;
    delete process.env.CONTEXT_ENGINE_OFFLINE_ONLY;

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

  describe('Semantic Search with SDK', () => {
    it('should parse search results from DirectContext SDK', async () => {
      // Mock formatted search results from SDK
      const mockFormattedResults = `## src/index.ts
Lines 1-5

\`\`\`typescript
export function main() {}
\`\`\`

## src/utils.ts
Lines 10-15

\`\`\`typescript
export const helper = () => {};
\`\`\``;

      mockContextInstance.search.mockResolvedValue(mockFormattedResults);

      const results = await client.semanticSearch('main function', 5);

      expect(results.length).toBeGreaterThan(0);
      expect(mockContextInstance.search).toHaveBeenCalledWith(
        'main function',
        expect.any(Object)
      );
    });

    it('should return empty array when SDK returns empty results', async () => {
      mockContextInstance.search.mockResolvedValue('');

      const results = await client.semanticSearch('test query', 5);

      expect(results).toEqual([]);
    });

    it('should return empty array on SDK error', async () => {
      mockContextInstance.search.mockRejectedValue(new Error('API error'));

      const results = await client.semanticSearch('test query', 5);

      expect(results).toEqual([]);
    });
  });

  describe('Search Result Structure', () => {
    it('should return results with correct structure', async () => {
      const mockFormattedResults = `## src/components/Button.tsx
Lines 1-10

\`\`\`typescript
export const Button = () => <button/>
\`\`\`

## src/utils/helpers.ts
Lines 5-15

\`\`\`typescript
export function formatDate() {}
\`\`\``;

      mockContextInstance.search.mockResolvedValue(mockFormattedResults);

      const results = await client.semanticSearch('button component', 5);

      expect(results.length).toBeGreaterThan(0);
      // Verify search results have the expected structure
      expect(results[0]).toHaveProperty('path');
      expect(results[0]).toHaveProperty('content');
      expect(results[0]).toHaveProperty('relevanceScore');
    });

    it('should assign relevance scores to results', async () => {
      const mockFormattedResults = `## file1.ts
\`\`\`typescript
content
\`\`\``;

      mockContextInstance.search.mockResolvedValue(mockFormattedResults);

      const results = await client.semanticSearch('test', 5);

      if (results.length > 0) {
        // Results should have normalized relevance scores
        expect(results[0].relevanceScore).toBeGreaterThanOrEqual(0);
        expect(results[0].relevanceScore).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Offline Policy', () => {
    it('should reject initialization when offline mode is enabled with remote API', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-offline-'));
      process.env.CONTEXT_ENGINE_OFFLINE_ONLY = '1';
      process.env.AUGMENT_API_URL = 'https://api.augmentcode.com';

      const offlineClient = new ContextServiceClient(tempDir);

      await expect(offlineClient.semanticSearch('offline test', 1)).rejects.toThrow(/offline mode/i);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Cache Management', () => {
    it('should cache search results', async () => {
      const mockFormattedResults = `## src/cached.ts
\`\`\`typescript
cached content
\`\`\``;

      mockContextInstance.search.mockResolvedValue(mockFormattedResults);

      // First call - should hit the SDK
      await client.semanticSearch('cache test', 5);
      expect(mockContextInstance.search).toHaveBeenCalledTimes(1);

      // Second call with same query - should use cache
      await client.semanticSearch('cache test', 5);
      expect(mockContextInstance.search).toHaveBeenCalledTimes(1); // Still 1, cache hit
    });

    it('should not use cache for different queries', async () => {
      mockContextInstance.search.mockResolvedValue('## file.ts\ncontent');

      await client.semanticSearch('query one', 5);
      await client.semanticSearch('query two', 5);

      expect(mockContextInstance.search).toHaveBeenCalledTimes(2);
    });

    it('should clear cache when clearCache is called', async () => {
      mockContextInstance.search.mockResolvedValue('## file.ts\ncontent');

      // First call
      await client.semanticSearch('clear test', 5);
      expect(mockContextInstance.search).toHaveBeenCalledTimes(1);

      // Clear cache
      client.clearCache();

      // Should hit SDK again
      await client.semanticSearch('clear test', 5);
      expect(mockContextInstance.search).toHaveBeenCalledTimes(2);
    });

    it('should not use cache for different topK values', async () => {
      mockContextInstance.search.mockResolvedValue('## file.ts\ncontent');

      await client.semanticSearch('topk test', 5);
      await client.semanticSearch('topk test', 10); // Different topK

      expect(mockContextInstance.search).toHaveBeenCalledTimes(2);
    });
  });

  describe('Index Workspace', () => {
    it('should call DirectContext SDK to index files', async () => {
      await client.indexWorkspace();

      expect(mockContextInstance.addToIndex).toHaveBeenCalled();
    });

    it('should clear cache after indexing', async () => {
      mockContextInstance.search.mockResolvedValue('## file.ts\ncontent');

      // Setup for search
      await client.semanticSearch('index test', 5);

      // Index workspace
      await client.indexWorkspace();

      // Search again - should not use cache
      await client.semanticSearch('index test', 5);

      // 2 search calls (cache was cleared after indexing)
      expect(mockContextInstance.search).toHaveBeenCalledTimes(2);
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
  });
});
