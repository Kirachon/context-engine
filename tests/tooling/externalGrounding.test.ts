import { describe, expect, it, jest } from '@jest/globals';

import {
  fetchExternalGrounding,
  serializeExternalSourcesForCache,
  validateAndNormalizeExternalSources,
} from '../../src/mcp/tooling/externalGrounding.js';

describe('externalGrounding', () => {
  it('normalizes and deduplicates external sources while preserving first label', () => {
    const normalized = validateAndNormalizeExternalSources([
      { type: 'docs_url', url: 'https://example.com/docs#intro', label: 'Docs' },
      { type: 'docs_url', url: 'https://example.com/docs', label: 'Other' },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({
        type: 'docs_url',
        url: 'https://example.com/docs',
        label: 'Docs',
      }),
    ]);
  });

  it('rejects unsupported github surfaces', () => {
    expect(() =>
      validateAndNormalizeExternalSources([
        { type: 'github_url', url: 'https://github.com/openai/openai/pull/1' },
      ])
    ).toThrow(/repo, tree, blob, or docs-like page/i);
  });

  it('serializes normalized sources deterministically for cache keys', () => {
    const normalized = validateAndNormalizeExternalSources([
      { type: 'docs_url', url: 'https://example.com/docs' },
      { type: 'github_url', url: 'https://github.com/openai/openai' },
    ]);

    expect(serializeExternalSourcesForCache(normalized)).toBe(
      JSON.stringify({
        version: '1.0.0',
        sources: [
          { type: 'docs_url', url: 'https://example.com/docs', label: undefined, host: 'example.com' },
          { type: 'github_url', url: 'https://github.com/openai/openai', label: undefined, host: 'github.com' },
        ],
      })
    );
  });

  it('returns warnings when fetched content is unsupported', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        body: undefined,
        text: async () => '',
      } as unknown as Response)
    );

    try {
      const normalized = validateAndNormalizeExternalSources([
        { type: 'docs_url', url: 'https://example.com/docs' },
      ]);
      const result = await fetchExternalGrounding(normalized);

      expect(result.references).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'unsupported_content_type' }),
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
