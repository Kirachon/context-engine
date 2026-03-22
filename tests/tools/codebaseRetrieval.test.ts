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
      getLastSearchDiagnostics: jest.fn(() => null),
      getActiveRetrievalProviderId: jest.fn(() => 'hybrid'),
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

  it('rejects invalid profile', async () => {
    await expect(
      handleCodebaseRetrieval({ query: 'test', profile: 'turbo' as any }, mockServiceClient as any)
    ).rejects.toThrow(/invalid profile/i);
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
    expect(typeof parsed.results[0].score).toBe('number');
    expect(parsed.results[0].score).toBeGreaterThanOrEqual(0.6);
    expect(parsed.results[0].score).toBeLessThanOrEqual(1);
    expect(parsed.results[0]).toHaveProperty('trace');
    expect(parsed.results[0].trace).toHaveProperty('source_stage');
    expect(parsed).toHaveProperty('metadata');
    expect(parsed.metadata.workspace).toBe('/tmp/workspace');
    expect(parsed.metadata.filtersApplied).toEqual([]);
    expect(parsed.metadata.filteredPathsCount).toBe(0);
    expect(parsed.metadata.secondPassUsed).toBe(false);
    expect(parsed.metadata).toHaveProperty('query_mode');
    expect(parsed.metadata).toHaveProperty('hybrid_components');
    expect(parsed.metadata).toHaveProperty('quality_guard_state');
    expect(parsed.metadata).toHaveProperty('fallback_state');
    expect(parsed.metadata).toHaveProperty('ranking_diagnostics');
    expect(parsed.metadata.ranking_diagnostics).toEqual(
      expect.objectContaining({
        rankingMode: expect.any(String),
        scoreSpread: expect.any(Number),
        sourceConsensus: expect.any(Number),
        fallbackState: expect.any(String),
        fallbackReason: expect.any(String),
        rerankGateState: expect.any(String),
      })
    );
  });

  it('respects top_k parameter and delegates using default fast profile settings', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval({ query: 'test', top_k: 5 }, mockServiceClient as any);

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
      'test',
      5,
      expect.objectContaining({ bypassCache: false, maxOutputLength: 10000 })
    );
  });

  it('uses fast profile by default when profile is omitted', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval({ query: 'default profile' }, mockServiceClient as any);

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
      'default profile',
      10,
      expect.objectContaining({ bypassCache: false, maxOutputLength: 20000 })
    );
  });

  it('applies explicit balanced profile settings when requested', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval(
      { query: 'audit', top_k: 5, profile: 'balanced' },
      mockServiceClient as any
    );

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
      'audit',
      10,
      expect.objectContaining({ bypassCache: false, maxOutputLength: 15000 })
    );
  });

  it('applies explicit rich profile settings when requested', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval(
      { query: 'audit', top_k: 5, profile: 'rich' },
      mockServiceClient as any
    );

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
      'audit',
      15,
      expect.objectContaining({ bypassCache: false, maxOutputLength: 20000 })
    );
  });

  it('keeps v1 result shape when compact is requested', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/v1.ts', content: 'full snippet', lines: '3-6', relevanceScore: 0.8 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval(
      { query: 'v1 compact ignored', compact: true, response_version: 'v1' },
      mockServiceClient as any
    );
    const parsed = JSON.parse(result);

    expect(parsed.results[0].content).toBe('full snippet');
    expect(parsed.results[0]).not.toHaveProperty('preview');
    expect(parsed.metadata).not.toHaveProperty('responseVersion');
    expect(parsed.metadata).not.toHaveProperty('providerResolution');
  });

  it('adds v2 metadata including provider resolution when requested', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/v2.ts', content: 'v2 snippet', lines: '10-12', relevanceScore: 0.7 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval(
      { query: 'v2 metadata', response_version: 'v2' },
      mockServiceClient as any
    );
    const parsed = JSON.parse(result);

    expect(parsed.metadata.responseVersion).toBe('v2');
    expect(parsed.metadata.providerResolution).toBe('hybrid');
    expect(parsed.results[0].content).toBe('v2 snippet');
    expect(parsed.results[0]).not.toHaveProperty('preview');
  });

  it('falls back to the legacy v1 shape when response_version is unknown', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/legacy.ts', content: 'legacy snippet', lines: '1-3', relevanceScore: 0.75 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval(
      { query: 'legacy version', response_version: 'v3' as any, compact: true, legacy_field: 'ignored' } as any,
      mockServiceClient as any
    );
    const parsed = JSON.parse(result);

    expect(parsed.metadata).not.toHaveProperty('responseVersion');
    expect(parsed.metadata).not.toHaveProperty('providerResolution');
    expect(parsed.results[0].content).toBe('legacy snippet');
    expect(parsed.results[0]).not.toHaveProperty('preview');
  });

  it('uses compact preview snippets only in v2 mode', async () => {
    const content = 'x'.repeat(320);
    const mockResults: SearchResult[] = [
      { path: 'src/compact.ts', content, lines: '1-20', relevanceScore: 0.99 },
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval(
      { query: 'compact', response_version: 'v2', compact: true },
      mockServiceClient as any
    );
    const parsed = JSON.parse(result);

    expect(parsed.results[0].file).toBe('src/compact.ts');
    expect(typeof parsed.results[0].score).toBe('number');
    expect(parsed.results[0].score).toBeGreaterThanOrEqual(0.6);
    expect(parsed.results[0].score).toBeLessThanOrEqual(1);
    expect(parsed.results[0].lines).toBe('1-20');
    expect(parsed.results[0].preview).toHaveLength(240);
    expect(parsed.results[0]).not.toHaveProperty('content');
    expect(parsed.metadata.responseVersion).toBe('v2');
  });

  it('trims query before delegating to semanticSearch', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);

    await handleCodebaseRetrieval({ query: '  test  ' }, mockServiceClient as any);

    expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
      'test',
      10,
      expect.objectContaining({ bypassCache: false, maxOutputLength: 20000 })
    );
  });

  it('adds reason text for each result', async () => {
    const mockResults: SearchResult[] = [
      { path: 'src/b.ts', content: 'code b', relevanceScore: 0.5 } as any,
    ];
    mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleCodebaseRetrieval({ query: 'reason' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.results[0].reason).toMatch(/Semantic match/);
    expect(parsed.results[0].trace).toEqual(
      expect.objectContaining({
        match_type: 'semantic',
        source_stage: 'semantic',
        query_variant: 'reason',
        variant_index: 0,
      })
    );
  });

  it('includes fallback diagnostics metadata when provided by service client', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    mockServiceClient.getLastSearchDiagnostics.mockReturnValue({
      filters_applied: ['exclude:artifacts', 'exclude:docs'],
      filtered_paths_count: 9,
      second_pass_used: true,
    });

    const result = await handleCodebaseRetrieval({ query: 'diagnostics' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.filtersApplied).toEqual(['exclude:artifacts', 'exclude:docs']);
    expect(parsed.metadata.filteredPathsCount).toBe(9);
    expect(parsed.metadata.secondPassUsed).toBe(true);
    expect(parsed.metadata.fallback_state).toBe('active');
    expect(parsed.metadata.ranking_diagnostics).toBeDefined();
  });

  it('supports legacy fallback diagnostics getter with camelCase fields', async () => {
    mockServiceClient.semanticSearch.mockResolvedValue([]);
    delete mockServiceClient.getLastSearchDiagnostics;
    mockServiceClient.getLastFallbackDiagnostics = jest.fn(() => ({
      filtersApplied: ['exclude:legacy'],
      filteredPathsCount: 3,
      secondPassUsed: false,
    }));

    const result = await handleCodebaseRetrieval({ query: 'legacy diagnostics' }, mockServiceClient as any);
    const parsed = JSON.parse(result);

    expect(parsed.metadata.filtersApplied).toEqual(['exclude:legacy']);
    expect(parsed.metadata.filteredPathsCount).toBe(3);
    expect(parsed.metadata.secondPassUsed).toBe(false);
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
    expect(parsed.metadata.freshnessWarning).toMatch(/reindexing succeeds/i);
    expect(parsed.metadata.indexStatus.status).toBe('error');
  });

  it('exposes correct tool schema', () => {
    expect(codebaseRetrievalTool.name).toBe('codebase_retrieval');
    expect(codebaseRetrievalTool.inputSchema.required).toContain('query');
    expect(Object.keys(codebaseRetrievalTool.inputSchema.properties)).toContain('profile');
  });
});
