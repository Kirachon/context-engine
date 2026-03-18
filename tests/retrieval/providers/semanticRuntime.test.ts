import { describe, expect, it, jest } from '@jest/globals';
import type { SearchResult } from '../../../src/mcp/serviceClient.js';
import {
  buildSemanticSearchPrompt,
  parseAIProviderSearchResults,
  parseFormattedResults,
  sanitizeResultPath,
  searchWithSemanticRuntime,
} from '../../../src/retrieval/providers/semanticRuntime.js';

describe('semanticRuntime helpers', () => {
  it('sanitizes relative result paths and rejects traversal/absolute paths', () => {
    expect(sanitizeResultPath('src/example.ts')).toBe('src/example.ts');
    expect(sanitizeResultPath('nested\\file.ts')).toBe('nested/file.ts');
    expect(sanitizeResultPath('../secret.ts')).toBeNull();
    expect(sanitizeResultPath('C:/abs/file.ts')).toBeNull();
  });

  it('builds a strict JSON-only semantic search prompt', () => {
    const prompt = buildSemanticSearchPrompt('search queue', 3, { maxOutputLength: 800 });

    expect(prompt).toContain('strict JSON-only retriever');
    expect(prompt).toContain('Query: search queue');
    expect(prompt).toContain('Return up to 3 results as a JSON array only');
    expect(prompt).toContain('around 800 characters');
  });

  it('parses structured AI-provider JSON results and respects topK', () => {
    const raw = JSON.stringify([
      { path: 'src/a.ts', content: 'alpha', relevanceScore: 0.9, lines: '1-2' },
      { file: 'src/b.ts', content: 'beta', score: 2 },
      { path: '../bad.ts', content: 'skip me' },
    ]);

    const results = parseAIProviderSearchResults(raw, 2);

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({
      path: 'src/a.ts',
      content: 'alpha',
      relevanceScore: 0.9,
      lines: '1-2',
      matchType: 'semantic',
    });
    expect(results?.[1]).toMatchObject({
      path: 'src/b.ts',
      content: 'beta',
      relevanceScore: 1,
      matchType: 'semantic',
    });
  });

  it('treats an explicit empty provider array as no matches', () => {
    expect(parseAIProviderSearchResults('[]', 5)).toEqual([]);
  });

  it('parses formatted Path blocks and infers line ranges', () => {
    const raw = [
      'Path: src/example.ts',
      '   10  const alpha = 1;',
      '   11  const beta = 2;',
      '',
      'Path: src/second.ts',
      '   20  export const gamma = 3;',
    ].join('\n');

    const results = parseFormattedResults(raw, 5);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      path: 'src/example.ts',
      content: 'const alpha = 1;\nconst beta = 2;',
      lines: '10-11',
      matchType: 'semantic',
    });
    expect(results[1]).toMatchObject({
      path: 'src/second.ts',
      content: 'export const gamma = 3;',
      lines: '20-20',
    });
  });

  it('falls back to keyword search when provider payload is unparseable', async () => {
    const fallbackResults: SearchResult[] = [
      {
        path: 'src/fallback.ts',
        content: 'fallback',
        matchType: 'keyword',
        relevanceScore: 0.6,
        retrievedAt: new Date().toISOString(),
      },
    ];
    const searchAndAsk = jest.fn(async () => 'not json and not formatted');
    const keywordFallbackSearch = jest.fn(async () => fallbackResults);

    const results = await searchWithSemanticRuntime(
      'VerySpecificIdentifier',
      5,
      undefined,
      { searchAndAsk, keywordFallbackSearch }
    );

    expect(searchAndAsk).toHaveBeenCalledTimes(1);
    expect(keywordFallbackSearch.mock.calls).toEqual([['VerySpecificIdentifier', 5]]);
    expect(results).toBe(fallbackResults);
  });

  it('returns parsed JSON results without touching fallback search', async () => {
    const searchAndAsk = jest.fn(async () => JSON.stringify([
      { path: 'src/a.ts', content: 'alpha', relevanceScore: 0.7, matchType: 'semantic' },
    ]));
    const keywordFallbackSearch = jest.fn(async () => []);

    const results = await searchWithSemanticRuntime(
      'queue handling',
      5,
      undefined,
      { searchAndAsk, keywordFallbackSearch }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'src/a.ts',
      content: 'alpha',
      relevanceScore: 0.7,
      matchType: 'semantic',
    });
    expect(keywordFallbackSearch).not.toHaveBeenCalled();
  });

  it('forwards semantic timeout option to searchAndAsk', async () => {
    const searchAndAsk = jest.fn(async () => JSON.stringify([
      { path: 'src/a.ts', content: 'alpha', relevanceScore: 0.7, matchType: 'semantic' },
    ]));
    const keywordFallbackSearch = jest.fn(async () => []);

    await searchWithSemanticRuntime(
      'timeout forwarding',
      5,
      { timeoutMs: 12345 },
      { searchAndAsk, keywordFallbackSearch }
    );

    expect(searchAndAsk).toHaveBeenCalledTimes(1);
    const timeoutArg = (searchAndAsk as jest.Mock).mock.calls[0]?.[2];
    expect(timeoutArg).toEqual(expect.objectContaining({ timeoutMs: 12345 }));
  });

  it('uses keyword fallback first for setup and install style queries', async () => {
    const fallbackResults: SearchResult[] = [
      {
        path: 'docs/MCP_CLIENT_SETUP.md',
        content: 'install the mcp',
        matchType: 'keyword',
        relevanceScore: 0.98,
        retrievedAt: new Date().toISOString(),
      },
    ];
    const searchAndAsk = jest.fn(async () => JSON.stringify([
      { path: 'src/slow.ts', content: 'slow', relevanceScore: 0.1, matchType: 'semantic' },
    ]));
    const keywordFallbackSearch = jest.fn(async () => fallbackResults);

    const results = await searchWithSemanticRuntime(
      'how do I install this mcp on codex',
      5,
      undefined,
      { searchAndAsk, keywordFallbackSearch }
    );

    expect(keywordFallbackSearch).toHaveBeenCalledTimes(1);
    expect(keywordFallbackSearch.mock.calls[0]).toEqual(['how do I install this mcp on codex', 5]);
    expect(searchAndAsk).not.toHaveBeenCalled();
    expect(results).toBe(fallbackResults);
  });

  it('uses parallel fallback result when provider call fails', async () => {
    const fallbackResults: SearchResult[] = [
      {
        path: 'src/fast-fallback.ts',
        content: 'fallback wins on provider failure',
        matchType: 'keyword',
        relevanceScore: 0.92,
        retrievedAt: new Date().toISOString(),
      },
    ];
    const searchAndAsk = jest.fn(async () => {
      throw new Error('provider timeout');
    });
    const keywordFallbackSearch = jest.fn(async () => fallbackResults);

    const results = await searchWithSemanticRuntime(
      'parallel fallback query',
      5,
      { parallelFallback: true },
      { searchAndAsk, keywordFallbackSearch }
    );

    expect(searchAndAsk).toHaveBeenCalledTimes(1);
    expect(keywordFallbackSearch).toHaveBeenCalledTimes(1);
    expect(results).toBe(fallbackResults);
  });
});
