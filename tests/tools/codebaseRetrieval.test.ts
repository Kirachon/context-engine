/**
 * Unit tests for codebase_retrieval tool
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleCodebaseRetrieval,
  codebaseRetrievalTool,
} from '../../src/mcp/tools/codebaseRetrieval.js';
import { SearchResult } from '../../src/mcp/serviceClient.js';

describe('codebase_retrieval Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      semanticSearch: jest.fn(),
      getLastFallbackDiagnostics: jest.fn(() => null),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
    };
  });

  it('validates input query', async () => {
    await expect(
      handleCodebaseRetrieval({ query: '' } as any, mockServiceClient as any)
    ).rejects.toThrow(/invalid query/i);
  });

  it('rejects whitespace-only query', async () => {
    await expect(
      handleCodebaseRetrieval({ query: '   ' } as any, mockServiceClient as any)
    ).rejects.toThrow(/invalid query/i);
  });

  it('returns JSON string with expected structure', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/a.ts', content: 'code a', lines: '1-5', relevanceScore: 0.9 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval({ query: 'test' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results[0].file).toBe('src/a.ts');
    expect(parsed.results[0].score).toBeCloseTo(0.9);
    expect(parsed).toHaveProperty('metadata');
    expect(parsed.metadata.workspace).toBe('/tmp/workspace');
    expect(parsed.metadata.filtersApplied).toEqual([]);
    expect(parsed.metadata.filteredPathsCount).toBe(0);
    expect(parsed.metadata.secondPassUsed).toBe(false);
  });

  it('respects top_k parameter and delegates to semanticSearch', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval({ query: 'test', top_k: 5 }, mockServiceClient as any);

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith('test', 5);
  });

  it('trims query before delegating to semanticSearch', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval({ query: '  test  ' }, mockServiceClient as any);

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith('test', 10);
  });

  it('adds reason text for each result', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/b.ts', content: 'code b', relevanceScore: 0.5 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval({ query: 'reason' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.results[0].reason).toMatch(/Semantic match/);
  });

  it('includes fallback diagnostics metadata when provided by service client', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    mockServiceClient.getLastFallbackDiagnostics.mockReturnValue({
      filtersApplied: ['exclude:artifacts', 'exclude:docs'],
      filteredPathsCount: 9,
      secondPassUsed: true,
    });

    const result = await handleCodebaseRetrieval({ query: 'diagnostics' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.filtersApplied).toEqual(['exclude:artifacts', 'exclude:docs']);
    expect(parsed.metadata.filteredPathsCount).toBe(9);
    expect(parsed.metadata.secondPassUsed).toBe(true);
  });

  it('returns a structured empty payload when retrieval backend rejects', async () => {
    mockServiceClient.semanticSearch.mockRejectedValue(
      new Error('Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1)')
    );
    mockServiceClient.getIndexStatus.mockReturnValue({
      workspace: '/tmp/workspace',
      lastIndexed: null,
      status: 'error',
      fileCount: 0,
      isStale: true,
      lastError: 'offline policy violation',
    });

    const result = await handleCodebaseRetrieval({ query: 'strict offline' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.results).toEqual([]);
    expect(parsed.metadata.totalResults).toBe(0);
    expect(parsed.metadata.indexStatus.status).toBe('error');
    expect(parsed.metadata.freshnessWarning).toMatch(/index status is error/i);
  });

  it('adds freshness warning metadata when index is stale', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    mockServiceClient.getIndexStatus.mockReturnValue({
      workspace: '/tmp/workspace',
      lastIndexed: '2024-01-01T00:00:00.000Z',
      status: 'idle',
      fileCount: 10,
      isStale: true,
    });

    const result = await handleCodebaseRetrieval({ query: 'stale' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.freshnessWarning).toMatch(/index is stale/i);
    expect(parsed.metadata.indexStatus.isStale).toBe(true);
  });

  it('does not emit unindexed freshness warning when lastIndexed exists and fileCount is 0', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    mockServiceClient.getIndexStatus.mockReturnValue({
      workspace: '/tmp/workspace',
      lastIndexed: '2024-01-01T00:00:00.000Z',
      status: 'idle',
      fileCount: 0,
      isStale: false,
    });

    const result = await handleCodebaseRetrieval({ query: 'restored-empty-index' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.indexStatus.fileCount).toBe(0);
    expect(parsed.metadata.indexStatus.isStale).toBe(false);
    expect(parsed.metadata).not.toHaveProperty('freshnessWarning');
  });

  it('adds freshness warning metadata when index is unhealthy', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    mockServiceClient.getIndexStatus.mockReturnValue({
      workspace: '/tmp/workspace',
      lastIndexed: null,
      status: 'error',
      fileCount: 0,
      isStale: true,
      lastError: 'index worker failed',
    });

    const result = await handleCodebaseRetrieval({ query: 'unhealthy' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.freshnessWarning).toMatch(/index status is error/i);
    expect(parsed.metadata.freshnessWarning).toMatch(/workspace appears unindexed/i);
    expect(parsed.metadata.indexStatus.status).toBe('error');
  });

  it('exposes correct tool schema', () => {
    expect(codebaseRetrievalTool.name).toBe('codebase_retrieval');
    expect(codebaseRetrievalTool.inputSchema.required).toContain('query');
  });
});
