/**
 * Unit tests for semantic_search tool
 *
 * Tests the Layer 3 - MCP Interface functionality for semantic search
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleSemanticSearch,
  handleSymbolSearch,
  handleSymbolReferencesSearch,
  handleSymbolDefinition,
  handleCallRelationships,
  SemanticSearchArgs,
  SymbolSearchArgs,
  SymbolReferencesArgs,
  SymbolDefinitionArgs,
  CallRelationshipsArgs,
  semanticSearchTool,
  symbolSearchTool,
  symbolReferencesTool,
  symbolDefinitionTool,
  callRelationshipsTool,
} from '../../src/mcp/tools/search.js';
import { ContextServiceClient, SearchResult } from '../../src/mcp/serviceClient.js';

describe('semantic_search Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      getFile: jest.fn(),
      semanticSearch: jest.fn(),
      symbolSearch: jest.fn(),
      symbolReferencesSearch: jest.fn(),
      getContextForPrompt: jest.fn(),
      indexWorkspace: jest.fn(),
      clearCache: jest.fn(),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
      getLastSearchDiagnostics: jest.fn(() => null),
    };
  });

  describe('Input Validation', () => {
    it('should reject empty query', async () => {
      await expect(handleSemanticSearch({ query: '' }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject whitespace-only query', async () => {
      await expect(handleSemanticSearch({ query: '   ' }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject null query', async () => {
      await expect(handleSemanticSearch({ query: null as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject query over 500 characters', async () => {
      const longQuery = 'a'.repeat(501);
      await expect(handleSemanticSearch({ query: longQuery }, mockServiceClient as any))
        .rejects.toThrow(/query too long/i);
    });

    it('should reject top_k less than 1', async () => {
      await expect(handleSemanticSearch({ query: 'test', top_k: 0 }, mockServiceClient as any))
        .rejects.toThrow(/invalid top_k/i);
    });

    it('should reject top_k greater than 50', async () => {
      await expect(handleSemanticSearch({ query: 'test', top_k: 51 }, mockServiceClient as any))
        .rejects.toThrow(/invalid top_k/i);
    });

    it('should reject invalid mode values', async () => {
      await expect(handleSemanticSearch({ query: 'test', mode: 'turbo' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid mode/i);
    });

    it('should reject invalid profile values', async () => {
      await expect(handleSemanticSearch({ query: 'test', profile: 'turbo' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid profile/i);
    });

    it('should reject non-boolean bypass_cache', async () => {
      await expect(handleSemanticSearch({ query: 'test', bypass_cache: 'true' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid bypass_cache/i);
    });

    it('should reject out-of-range timeout_ms', async () => {
      await expect(handleSemanticSearch({ query: 'test', timeout_ms: -1 }, mockServiceClient as any))
        .rejects.toThrow(/invalid timeout_ms/i);
    });

    it('should reject absolute include_paths entries', async () => {
      await expect(
        handleSemanticSearch(
          { query: 'test', include_paths: ['C:/repo/**'] },
          mockServiceClient as any
        )
      ).rejects.toThrow(/include_paths/i);
    });

    it('should reject invalid include_paths values', async () => {
      await expect(
        handleSemanticSearch({ query: 'test', include_paths: ['/abs/**'] as any }, mockServiceClient as any)
      ).rejects.toThrow(/invalid include_paths/i);
    });

    it('should accept valid parameters', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await expect(handleSemanticSearch({
        query: 'test query',
        top_k: 10,
      }, mockServiceClient as any)).resolves.toBeDefined();
    });

    it('should trim query before delegating to semanticSearch', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch({ query: '  test query  ' }, mockServiceClient as any);

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'test query',
        10,
        expect.objectContaining({ bypassCache: false })
      );
    });

    it('keeps backward-compatible defaults when mode/profile are omitted', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch({ query: 'compat', top_k: 7 }, mockServiceClient as any);

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'compat',
        7,
        expect.objectContaining({
          bypassCache: false,
          maxOutputLength: 14000,
        })
      );
    });

    it('maps mode=deep to rich retrieval profile settings', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch({ query: 'audit', top_k: 5, mode: 'deep' }, mockServiceClient as any);

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'audit',
        15,
        expect.objectContaining({ bypassCache: false, maxOutputLength: 20000 })
      );
    });

    it('supports explicit balanced retrieval profile', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch({ query: 'audit', top_k: 5, profile: 'balanced' }, mockServiceClient as any);

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'audit',
        10,
        expect.objectContaining({ bypassCache: false, maxOutputLength: 15000 })
      );
    });

    it('normalizes include_paths and exclude_paths before delegating', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch(
        {
          query: 'audit',
          include_paths: ['./src/auth/', 'src/auth/'],
          exclude_paths: ['src/auth/legacy/**'],
        },
        mockServiceClient as any
      );

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'audit',
        10,
        expect.objectContaining({
          includePaths: ['src/auth/**'],
          excludePaths: ['src/auth/legacy/**'],
        })
      );
    });

    it('normalizes scoped path filters before delegating to semanticSearch', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch(
        {
          query: 'audit',
          include_paths: ['src/', './src/**', 'src\\**'],
          exclude_paths: ['dist\\', './dist/**'],
        },
        mockServiceClient as any
      );

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'audit',
        10,
        expect.objectContaining({
          includePaths: ['src/**'],
          excludePaths: ['dist/**'],
        })
      );
    });

    it('prefers explicit profile over mode compatibility mapping', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch(
        { query: 'audit', top_k: 5, mode: 'deep', profile: 'fast' },
        mockServiceClient as any
      );

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledTimes(1);
      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'audit',
        5,
        expect.objectContaining({ bypassCache: false, maxOutputLength: 10000 })
      );
    });

    it('uses a safe default timeout when bypass_cache=true and timeout_ms is omitted', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      await handleSemanticSearch(
        { query: 'no-cache-check', top_k: 5, bypass_cache: true },
        mockServiceClient as any
      );

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'no-cache-check',
        5,
        expect.objectContaining({ bypassCache: true })
      );
    });

    it('ignores unknown legacy fields without changing the semantic search contract', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      const result = await handleSemanticSearch(
        {
          query: '  compat  ',
          top_k: 7,
          legacy_field: 'ignored',
          future_flag: true,
        } as any,
        mockServiceClient as any
      );

      expect(mockServiceClient.semanticSearch).toHaveBeenCalledTimes(1);
      expect(mockServiceClient.semanticSearch).toHaveBeenCalledWith(
        'compat',
        7,
        expect.objectContaining({
          bypassCache: false,
          maxOutputLength: 14000,
        })
      );

      const callOptions = mockServiceClient.semanticSearch.mock.calls[0][2] as Record<string, unknown>;
      expect(Object.keys(callOptions)).not.toContain('legacy_field');
      expect(Object.keys(callOptions)).not.toContain('future_flag');
      expect(result).toContain('# 🔍 Search Results');
      expect(result).toContain('No results found');
    });
  });

  describe('Output Formatting', () => {
    it('should show empty state message when no results', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      const result = await handleSemanticSearch({ query: 'nonexistent' }, mockServiceClient as any);

      expect(result).toContain('No results found');
      expect(result).toContain('# 🔍 Search Results');
    });

    it('should include freshness warning in no-results output when index is stale', async () => {
      mockServiceClient.getIndexStatus = jest.fn(() => ({
        workspace: '/tmp/workspace',
        status: 'idle',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        fileCount: 10,
        isStale: true,
        lastError: undefined,
      }));
      mockServiceClient.semanticSearch.mockResolvedValue([]);

      const result = await handleSemanticSearch({ query: 'nonexistent' }, mockServiceClient as any);

      expect(result).toContain('No results found');
      expect(result).toContain('Index freshness warning');
    });

    it('should include freshness warning when index is stale', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);
      mockServiceClient.getIndexStatus.mockReturnValue({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: true,
      });

      const result = await handleSemanticSearch({ query: 'stale' }, mockServiceClient as any);

      expect(result).toContain('Index freshness warning');
      expect(result).toContain('index is stale');
    });

    it('should include freshness warning when index is unhealthy', async () => {
      mockServiceClient.semanticSearch.mockResolvedValue([]);
      mockServiceClient.getIndexStatus.mockReturnValue({
        workspace: '/tmp/workspace',
        lastIndexed: null,
        status: 'error',
        fileCount: 0,
        isStale: true,
        lastError: 'failed to load index',
      });

      const result = await handleSemanticSearch({ query: 'unhealthy' }, mockServiceClient as any);

      expect(result).toContain('index status is error');
      expect(result).toContain('reindexing succeeds');
    });

    it('should include search results header', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/test.ts', content: 'test content', score: 0.9, lines: '1-5', relevanceScore: 0.9 },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

      const result = await handleSemanticSearch({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('# 🔍 Search Results');
      expect(result).toContain('**Found:**');
      expect(result).toContain('**Query Mode:**');
      expect(result).toContain('**Hybrid Components:**');
      expect(result).toContain('**Fallback State:**');
      expect(result).toContain('**Ranking Diagnostics:**');
      expect(result).toContain('score_spread=');
    });

    it('should group results by file', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/a.ts', content: 'content a', score: 0.9, lines: '1-5', relevanceScore: 0.9 },
        { path: 'src/a.ts', content: 'more a', score: 0.8, lines: '10-15', relevanceScore: 0.8 },
        { path: 'src/b.ts', content: 'content b', score: 0.7, lines: '1-3', relevanceScore: 0.7 },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

      const result = await handleSemanticSearch({ query: 'test' }, mockServiceClient as any);

      // Should have grouped file headings
      expect(result).toContain('`src/a.ts`');
      expect(result).toContain('`src/b.ts`');
    });

    it('should show code previews', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/test.ts', content: 'function test() { return true; }', score: 0.9, lines: '1-1', relevanceScore: 0.9 },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

      const result = await handleSemanticSearch({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('```');
      expect(result).toContain('function test()');
      expect(result).toContain('Trace: source_stage=semantic; match_type=semantic');
    });

    it('should include query variant and variant index in trace output when present', async () => {
      const mockResults: SearchResult[] = [
        {
          path: 'src/test.ts',
          content: 'function test() { return true; }',
          score: 0.9,
          lines: '1-1',
          relevanceScore: 0.9,
          matchType: 'semantic',
          retrievedAt: '2024-01-01T00:00:00.000Z',
          queryVariant: 'test query',
          variantIndex: 2,
        } as any,
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

    const result = await handleSemanticSearch({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('Trace: source_stage=semantic; match_type=semantic');
      expect(result).toContain('query_variant="test"');
      expect(result).toContain('variant_index=0');
    });

    it('should include retrieval audit table when results exist', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/a.ts', content: 'alpha', lines: '1-2', relevanceScore: 0.8, matchType: 'semantic', retrievedAt: '2024-01-01T00:00:00.000Z' },
        { path: 'src/b.ts', content: 'beta', lines: '3-4', relevanceScore: 0.6, matchType: 'keyword', retrievedAt: '2024-01-02T00:00:00.000Z' },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);

      const result = await handleSemanticSearch({ query: 'audit' }, mockServiceClient as any);

      expect(result).toContain('Retrieval Audit');
      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
    });

    it('should include fallback diagnostics line when filters were applied', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/a.ts', content: 'alpha', lines: '1-2', relevanceScore: 0.8, matchType: 'keyword' },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);
      mockServiceClient.getLastSearchDiagnostics.mockReturnValue({
        filters_applied: ['exclude:artifacts'],
        filtered_paths_count: 4,
        second_pass_used: true,
      });

      const result = await handleSemanticSearch({ query: 'audit' }, mockServiceClient as any);

      expect(result).toContain('Fallback Diagnostics');
      expect(result).toContain('filters_applied=exclude:artifacts');
      expect(result).toContain('filtered_paths_count=4');
      expect(result).toContain('second_pass_used=true');
      expect(result).toContain('**Fallback State:** inactive');
      expect(result).toContain('**Ranking Diagnostics:**');
    });

    it('should support legacy diagnostics getter with camelCase fields', async () => {
      const mockResults: SearchResult[] = [
        { path: 'src/a.ts', content: 'alpha', lines: '1-2', relevanceScore: 0.8, matchType: 'keyword' },
      ];
      mockServiceClient.semanticSearch.mockResolvedValue(mockResults);
      delete mockServiceClient.getLastSearchDiagnostics;
      mockServiceClient.getLastFallbackDiagnostics = jest.fn(() => ({
        filtersApplied: ['exclude:legacy'],
        filteredPathsCount: 2,
        secondPassUsed: false,
      }));

      const result = await handleSemanticSearch({ query: 'legacy-audit' }, mockServiceClient as any);

      expect(result).toContain('Fallback Diagnostics');
      expect(result).toContain('filters_applied=exclude:legacy');
      expect(result).toContain('filtered_paths_count=2');
      expect(result).toContain('second_pass_used=false');
    });
  });

  describe('Tool Schema', () => {
    it('should have correct name', () => {
      expect(semanticSearchTool.name).toBe('semantic_search');
    });

    it('should have required query property', () => {
      expect(semanticSearchTool.inputSchema.required).toContain('query');
    });

    it('should have query and top_k properties', () => {
      const props = Object.keys(semanticSearchTool.inputSchema.properties);
      expect(props).toContain('query');
      expect(props).toContain('top_k');
      expect(props).toContain('profile');
    });
  });
});

describe('symbol_search Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      symbolSearch: jest.fn(),
      getLastSymbolNavigationDiagnostics: jest.fn(() => null),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
      getLastSearchDiagnostics: jest.fn(() => null),
    };
  });

  it('delegates trimmed symbol queries to deterministic local symbol search', async () => {
    mockServiceClient.symbolSearch.mockResolvedValue([
      {
        path: 'src/auth/provider.ts',
        content: 'export function resolveAIProviderId() {}',
        relevanceScore: 0.97,
        lines: '1-1',
        matchType: 'keyword',
        retrievedAt: '2024-01-01T00:00:00.000Z',
      },
    ] satisfies SearchResult[]);

    const result = await handleSymbolSearch(
      {
        symbol: '  resolveAIProviderId  ',
        top_k: 5,
        include_paths: ['./src/'],
        exclude_paths: ['src/legacy/**'],
      } satisfies SymbolSearchArgs,
      mockServiceClient as any
    );

    expect(mockServiceClient.symbolSearch).toHaveBeenCalledWith(
      'resolveAIProviderId',
      5,
      expect.objectContaining({
        includePaths: ['src/**'],
        excludePaths: ['src/legacy/**'],
      })
    );
    expect(result).toContain('# 🔎 Symbol Search Results');
    expect(result).toContain('resolveAIProviderId');
    expect(result).toContain('src/auth/provider.ts');
  });

  it('requires a non-empty symbol', async () => {
    await expect(handleSymbolSearch({ symbol: '   ' }, mockServiceClient as any)).rejects.toThrow(/symbol/i);
  });

  it('includes symbol navigation diagnostics when provided', async () => {
    mockServiceClient.symbolSearch.mockResolvedValue([
      {
        path: 'src/auth/provider.ts',
        content: 'export function resolveAIProviderId() {}',
        relevanceScore: 0.97,
        lines: '1-1',
        matchType: 'keyword',
        retrievedAt: '2024-01-01T00:00:00.000Z',
      },
    ] satisfies SearchResult[]);
    mockServiceClient.getLastSymbolNavigationDiagnostics.mockReturnValue({
      backend: 'heuristic_fallback',
      graph_status: 'unavailable',
      graph_degraded_reason: 'graph_unavailable',
      fallback_reason: 'graph_unavailable',
    });

    const result = await handleSymbolSearch({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);

    expect(result).toContain('Resolution Backend');
    expect(result).toContain('heuristic_fallback');
    expect(result).toContain('graph_unavailable');
  });

  it('exposes the symbol_search schema', () => {
    expect(symbolSearchTool.name).toBe('symbol_search');
    expect(symbolSearchTool.inputSchema.required).toContain('symbol');
    expect(Object.keys(symbolSearchTool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['symbol', 'top_k', 'bypass_cache', 'include_paths', 'exclude_paths'])
    );
  });
});

describe('symbol_references Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      symbolReferencesSearch: jest.fn(),
      getLastSymbolNavigationDiagnostics: jest.fn(() => null),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
      getLastSearchDiagnostics: jest.fn(() => null),
    };
  });

  it('delegates trimmed symbols to local symbol reference search', async () => {
    mockServiceClient.symbolReferencesSearch.mockResolvedValue([
      {
        path: 'src/caller.ts',
        content: 'export const activeProvider = resolveAIProviderId();',
        relevanceScore: 0.95,
        lines: '2-2',
        matchType: 'keyword',
        retrievedAt: '2024-01-01T00:00:00.000Z',
      },
    ] satisfies SearchResult[]);

    const result = await handleSymbolReferencesSearch(
      {
        symbol: '  resolveAIProviderId  ',
        top_k: 5,
        include_paths: ['./src/'],
        exclude_paths: ['src/legacy/**'],
      } satisfies SymbolReferencesArgs,
      mockServiceClient as any
    );

    expect(mockServiceClient.symbolReferencesSearch).toHaveBeenCalledWith(
      'resolveAIProviderId',
      5,
      expect.objectContaining({
        includePaths: ['src/**'],
        excludePaths: ['src/legacy/**'],
      })
    );
    expect(result).toContain('# 🔗 Symbol Reference Results');
    expect(result).toContain('src/caller.ts');
  });

  it('requires a non-empty symbol', async () => {
    await expect(handleSymbolReferencesSearch({ symbol: '   ' }, mockServiceClient as any)).rejects.toThrow(/symbol/i);
  });

  it('includes symbol navigation diagnostics when references fall back', async () => {
    mockServiceClient.symbolReferencesSearch.mockResolvedValue([
      {
        path: 'src/caller.ts',
        content: 'return resolveAIProviderId();',
        relevanceScore: 0.95,
        lines: '2-2',
        matchType: 'keyword',
        retrievedAt: '2024-01-01T00:00:00.000Z',
      },
    ] satisfies SearchResult[]);
    mockServiceClient.getLastSymbolNavigationDiagnostics.mockReturnValue({
      backend: 'heuristic_fallback',
      graph_status: 'degraded',
      graph_degraded_reason: 'graph_partial',
      fallback_reason: 'graph_reference_not_found',
    });

    const result = await handleSymbolReferencesSearch({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);

    expect(result).toContain('Resolution Backend');
    expect(result).toContain('graph_reference_not_found');
  });

  it('exposes the symbol_references schema', () => {
    expect(symbolReferencesTool.name).toBe('symbol_references');
    expect(symbolReferencesTool.inputSchema.required).toContain('symbol');
    expect(Object.keys(symbolReferencesTool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['symbol', 'top_k', 'bypass_cache', 'include_paths', 'exclude_paths'])
    );
  });
});

describe('symbol_definition Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      symbolDefinition: jest.fn(),
      getLastSymbolNavigationDiagnostics: jest.fn(() => null),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
      getLastSearchDiagnostics: jest.fn(() => null),
    };
  });

  it('delegates trimmed symbols to local symbol definition lookup', async () => {
    mockServiceClient.symbolDefinition.mockResolvedValue({
      found: true,
      symbol: 'resolveAIProviderId',
      file: 'src/providers.ts',
      line: 12,
      column: 1,
      kind: 'function',
      snippet: 'export function resolveAIProviderId() {}',
      score: 195,
      metadata: {
        backend: 'graph',
        graph_status: 'ready',
        graph_degraded_reason: null,
        fallback_reason: null,
      },
    });

    const result = await handleSymbolDefinition(
      {
        symbol: '  resolveAIProviderId  ',
        include_paths: ['./src/'],
        exclude_paths: ['src/legacy/**'],
      } satisfies SymbolDefinitionArgs,
      mockServiceClient as any
    );

    expect(mockServiceClient.symbolDefinition).toHaveBeenCalledWith(
      'resolveAIProviderId',
      expect.objectContaining({
        includePaths: ['src/**'],
        excludePaths: ['src/legacy/**'],
      })
    );
    expect(result).toContain('# 📍 Symbol Definition');
    expect(result).toContain('src/providers.ts');
    expect(result).toContain('Resolution Backend');
    expect(result).toContain('graph');
  });

  it('requires a non-empty symbol', async () => {
    await expect(handleSymbolDefinition({ symbol: '   ' }, mockServiceClient as any)).rejects.toThrow(/symbol/i);
  });

  it('exposes the symbol_definition schema', () => {
    expect(symbolDefinitionTool.name).toBe('symbol_definition');
    expect(symbolDefinitionTool.inputSchema.required).toContain('symbol');
    expect(Object.keys(symbolDefinitionTool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['symbol', 'language_hint', 'bypass_cache', 'include_paths', 'exclude_paths'])
    );
  });
});

describe('call_relationships Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      callRelationships: jest.fn(),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
      getLastSearchDiagnostics: jest.fn(() => null),
    };
  });

  it('delegates trimmed symbols to local call relationships lookup', async () => {
    mockServiceClient.callRelationships.mockResolvedValue({
      symbol: 'resolveAIProviderId',
      callers: [
        {
          file: 'src/handler.ts',
          line: 42,
          column: 5,
          score: 80,
          callerSymbol: 'handle',
          snippet: '  resolveAIProviderId();',
        },
      ],
      callees: [
        {
          calleeSymbol: 'lookup',
          file: 'src/providers.ts',
          line: 14,
          column: 3,
          score: 10,
          snippet: '  lookup();',
        },
      ],
      metadata: {
        symbol: 'resolveAIProviderId',
        direction: 'both',
        totalCallers: 1,
        totalCallees: 1,
        consideredFiles: 5,
        cacheBypassed: false,
        resolutionBackend: 'graph',
        fallbackReason: null,
        graphStatus: 'ready',
        graphDegradedReason: null,
      },
    });

    const result = await handleCallRelationships(
      {
        symbol: '  resolveAIProviderId  ',
        direction: 'both',
        top_k: 10,
        include_paths: ['./src/'],
        exclude_paths: ['src/legacy/**'],
      } satisfies CallRelationshipsArgs,
      mockServiceClient as any
    );

    expect(mockServiceClient.callRelationships).toHaveBeenCalledWith(
      'resolveAIProviderId',
      expect.objectContaining({
        direction: 'both',
        topK: 10,
        includePaths: ['src/**'],
        excludePaths: ['src/legacy/**'],
      })
    );
    expect(result).toContain('# 🔁 Call Relationships');
    expect(result).toContain('src/handler.ts');
    expect(result).toContain('lookup');
    expect(result).toContain('Resolution Backend');
    expect(result).toContain('graph');
  });

  it('requires a non-empty symbol', async () => {
    await expect(handleCallRelationships({ symbol: '   ' }, mockServiceClient as any)).rejects.toThrow(/symbol/i);
  });

  it('rejects invalid direction values', async () => {
    await expect(
      handleCallRelationships({ symbol: 'foo', direction: 'sideways' as any }, mockServiceClient as any)
    ).rejects.toThrow(/direction/i);
  });

  it('rejects out-of-range top_k', async () => {
    await expect(
      handleCallRelationships({ symbol: 'foo', top_k: 999 }, mockServiceClient as any)
    ).rejects.toThrow(/top_k/i);
  });

  it('exposes the call_relationships schema', () => {
    expect(callRelationshipsTool.name).toBe('call_relationships');
    expect(callRelationshipsTool.inputSchema.required).toContain('symbol');
    expect(Object.keys(callRelationshipsTool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['symbol', 'direction', 'top_k', 'language_hint', 'bypass_cache', 'include_paths', 'exclude_paths'])
    );
  });
});
