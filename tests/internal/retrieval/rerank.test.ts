import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  clearRerankerRuntimeCacheForTests,
  rerankCandidates,
  rerankResults,
  type TransformerRerankOptions,
} from '../../../src/internal/retrieval/rerank.js';
import type { InternalSearchResult } from '../../../src/internal/retrieval/types.js';

function createResult(
  path: string,
  content: string,
  relevanceScore: number,
  lines = '1-2'
): InternalSearchResult {
  return {
    path,
    content,
    relevanceScore,
    lines,
    queryVariant: 'query',
    variantIndex: 0,
    variantWeight: 1,
  } as InternalSearchResult;
}

function createVectorExtractor() {
  return jest.fn(async (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => {
    const values = Array.isArray(texts) ? texts : [texts];
    return {
      tolist: () => values.map((text) => {
        const normalizedText = text.toLowerCase();
        if (normalizedText.includes('login handler')) {
          return [1, 0, options?.normalize === true ? 1 : 0];
        }
        if (normalizedText.includes('database schema')) {
          return [0, 1, options?.normalize === true ? 1 : 0];
        }
        if (normalizedText.includes('shared alpha')) {
          return [0.5, 0.5, 1];
        }
        return [0.25, 0.25, options?.normalize === true ? 1 : 0];
      }),
    };
  });
}

async function createTransformersModule(extractor: ReturnType<typeof createVectorExtractor>) {
  return {
    pipeline: jest.fn(async () => extractor),
  } as never;
}

describe('reranker', () => {
  afterEach(() => {
    clearRerankerRuntimeCacheForTests();
  });

  it('uses transformer similarity ahead of heuristic score when available', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.99),
      createResult('src/auth/login.ts', 'login handler', 0.1),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.5),
    ];

    const ranked = await rerankCandidates(candidates, options);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(ranked.map((item) => item.path)).toEqual([
      'src/auth/login.ts',
      'src/shared/alpha.ts',
      'src/database/schema.ts',
    ]);
    expect(ranked[0]?.combinedScore).toBeGreaterThanOrEqual(ranked[1]?.combinedScore ?? -Infinity);
  });

  it('reuses the lazy transformer runtime for repeated reranks', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/auth/login.ts', 'login handler', 0.9),
      createResult('src/database/schema.ts', 'database schema', 0.1),
    ];

    await rerankCandidates(candidates, options);
    await rerankCandidates(candidates, options);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('falls back to the heuristic ranking when transformer loading fails', async () => {
    const loadTransformersModule = jest.fn(async () => {
      throw new Error('transformer unavailable');
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v2',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/z.ts', 'z', 0.2),
      createResult('src/a.ts', 'a', 0.9),
      createResult('src/m.ts', 'm', 0.5),
    ];

    const ranked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(ranked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
  });

  it('keeps deterministic ordering when transformer scores tie', async () => {
    const extractor = jest.fn(async (texts: string | string[]) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map(() => [1, 1, 1]),
      };
    });
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor as ReturnType<typeof createVectorExtractor>));
    const options: TransformerRerankOptions = {
      originalQuery: 'shared alpha',
      mode: 'v3',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/beta.ts', 'shared beta', 0.6),
      createResult('src/alpha.ts', 'shared alpha', 0.6),
      createResult('src/gamma.ts', 'shared gamma', 0.6),
    ];

    const ranked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(ranked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
  });

  it('short-circuits runtime when batch tensor extraction fails with float32 type error', async () => {
    const extractor = jest.fn(async (
      texts: string | string[],
      _options?: { pooling?: string; normalize?: boolean }
    ) => {
      if (Array.isArray(texts)) {
        throw new TypeError("A float32 tensor's data must be type of Float32Array() { [native code] }");
      }

      const normalizedText = texts.toLowerCase();
      return {
        tolist: () => {
          if (normalizedText.includes('login handler')) {
            return [1, 0, 1];
          }
          if (normalizedText.includes('database schema')) {
            return [0, 1, 1];
          }
          return [0.5, 0.5, 1];
        },
      };
    });
    const loadTransformersModule = jest.fn(async () => ({
      pipeline: jest.fn(async () => extractor),
    }) as never);
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.99),
      createResult('src/auth/login.ts', 'login handler', 0.1),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.5),
    ];

    const firstRanked = await rerankCandidates(candidates, options);
    const secondRanked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(firstRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(secondRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(extractor.mock.calls[0]?.[0]).toEqual([
      'login handler',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(extractor.mock.calls[0]?.[1]).toEqual({ pooling: 'mean', normalize: true });
    const batchCallCount = extractor.mock.calls.filter(([firstArg]) => Array.isArray(firstArg)).length;
    expect(batchCallCount).toBe(1);
  });

  it('disables transformer runtime after single-text extraction failure', async () => {
    const extractor = jest.fn(async (texts: string | string[]) => {
      if (Array.isArray(texts)) {
        throw new TypeError('batch extraction failure');
      }
      throw new TypeError('single extraction failure');
    });
    const loadTransformersModule = jest.fn(async () => ({
      pipeline: jest.fn(async () => extractor),
    }) as never);
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.99),
      createResult('src/auth/login.ts', 'login handler', 0.1),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.5),
    ];

    const firstRanked = await rerankCandidates(candidates, options);
    const secondRanked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(firstRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(secondRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('short-circuits runtime when batch fails with float32 tensor type error', async () => {
    const extractor = jest.fn(async (_texts: string | string[]) => {
      throw new TypeError("A float32 tensor's data must be type of Float32Array() { [native code] }");
    });
    const loadTransformersModule = jest.fn(async () => ({
      pipeline: jest.fn(async () => extractor),
    }) as never);
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
    };
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.99),
      createResult('src/auth/login.ts', 'login handler', 0.1),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.5),
    ];

    const firstRanked = await rerankCandidates(candidates, options);
    const secondRanked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(firstRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(secondRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(extractor).toHaveBeenCalledTimes(1);
  });
});
