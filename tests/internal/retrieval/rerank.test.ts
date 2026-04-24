import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import {
  clearConfiguredEmbeddingRuntimeCacheForTests,
  createConfiguredEmbeddingRuntime,
} from '../../../src/internal/retrieval/embeddingRuntime.js';
import {
  clearRerankerRuntimeCacheForTests,
  rerankCandidates,
  rerankResults,
  type TransformerRerankTrace,
  type TransformerRerankOptions,
} from '../../../src/internal/retrieval/rerank.js';
import { retrieve } from '../../../src/internal/retrieval/retrieve.js';
import { createRetrievalFlowContext } from '../../../src/internal/retrieval/flow.js';
import { evaluateRankingGate } from '../../../src/internal/retrieval/rankingCalibration.js';
import type { InternalSearchResult } from '../../../src/internal/retrieval/types.js';

function createResult(
  path: string,
  content: string,
  relevanceScore: number,
  lines = '1-2',
  retrievalSource: InternalSearchResult['retrievalSource'] = 'semantic'
): InternalSearchResult {
  return {
    path,
    content,
    relevanceScore,
    lines,
    queryVariant: 'query',
    variantIndex: 0,
    variantWeight: 1,
    retrievalSource,
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
  const originalCrossEncoderRerank = FEATURE_FLAGS.retrieval_cross_encoder_rerank_v1;

  afterEach(() => {
    FEATURE_FLAGS.retrieval_cross_encoder_rerank_v1 = originalCrossEncoderRerank;
    clearRerankerRuntimeCacheForTests();
    clearConfiguredEmbeddingRuntimeCacheForTests();
  });

  it('uses transformer similarity ahead of heuristic score for hard queries', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    expect(gateDecision.shouldUseTransformerRerank).toBe(true);
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    };

    const ranked = await rerankCandidates(candidates, options);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(ranked.map((item) => item.path)).toEqual([
      'src/auth/login.ts',
      'src/shared/alpha.ts',
      'src/shared/beta.ts',
      'src/shared/gamma.ts',
      'src/database/schema.ts',
    ]);
    expect(ranked[0]?.combinedScore).toBeGreaterThanOrEqual(ranked[1]?.combinedScore ?? -Infinity);
  });

  it('uses the cross-encoder text-classification path when enabled', async () => {
    FEATURE_FLAGS.retrieval_cross_encoder_rerank_v1 = true;
    const classifier = jest.fn(async (inputs: string | string[]) => {
      const values = Array.isArray(inputs) ? inputs : [inputs];
      return values.map((value) => (
        value.includes('src/auth/login.ts')
          ? [{ label: 'LABEL_1', score: 0.99 }, { label: 'LABEL_0', score: 0.01 }]
          : [{ label: 'LABEL_1', score: 0.2 }, { label: 'LABEL_0', score: 0.8 }]
      ));
    });
    const pipeline = jest.fn(async () => classifier);
    const loadTransformersModule = jest.fn(async () => ({ pipeline }) as never);
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    const ranked = await rerankCandidates(candidates, {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    });

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledTimes(1);
    const pipelineCalls = (pipeline as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(pipelineCalls[0]?.[0]).toBe('text-classification');
    expect(pipelineCalls[0]?.[1]).toBe('Xenova/ms-marco-MiniLM-L6-v2');
    expect(classifier).toHaveBeenCalledTimes(1);
    const crossEncoderInputs = classifier.mock.calls[0]?.[0];
    expect(Array.isArray(crossEncoderInputs)).toBe(true);
    expect((crossEncoderInputs as string[])[0]).toContain('login handler [SEP]');
    expect(ranked[0]?.path).toBe('src/auth/login.ts');
  });

  it('skips transformer rerank on easy balanced queries', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const candidates = [
      createResult('src/clear.ts', 'clear result', 0.95, '1-2', 'semantic'),
      createResult('src/medium.ts', 'medium result', 0.55, '1-2', 'semantic'),
      createResult('src/low.ts', 'low result', 0.3, '1-2', 'semantic'),
      createResult('src/lower.ts', 'lower result', 0.1, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'balanced',
    });
    expect(gateDecision.shouldUseTransformerRerank).toBe(false);

    const ranked = await rerankCandidates(candidates, {
      originalQuery: 'clear result',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    });

    expect(loadTransformersModule).not.toHaveBeenCalled();
    expect(extractor).not.toHaveBeenCalled();
    expect(ranked.map((item) => item.path)).toEqual(rerankResults(candidates, { originalQuery: 'clear result', mode: 'v3' }).map((item) => item.path));
  });

  it('reports skipped heuristic trace when the ranking gate stays conservative', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const trace = jest.fn<(trace: TransformerRerankTrace) => void>();
    const candidates = [
      createResult('src/clear.ts', 'clear result', 0.95, '1-2', 'semantic'),
      createResult('src/medium.ts', 'medium result', 0.55, '1-2', 'semantic'),
      createResult('src/low.ts', 'low result', 0.3, '1-2', 'semantic'),
      createResult('src/lower.ts', 'lower result', 0.1, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'balanced',
    });

    await rerankCandidates(candidates, {
      originalQuery: 'clear result',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
      onTrace: trace,
    });

    expect(trace).toHaveBeenCalledWith(expect.objectContaining({
      candidateCount: 4,
      selectedPath: 'heuristic',
      appliedPath: 'heuristic',
      state: 'skipped',
      fallbackReason: 'rerank_skipped',
      reasonCode: 'gate_skipped',
      gateDecision,
    }));
    expect(loadTransformersModule).not.toHaveBeenCalled();
  });

  it('keeps the gate conservative when candidate count falls below the hard-query minimum', () => {
    const candidates = [
      createResult('src/a.ts', 'alpha', 0.61, '1-2', 'semantic'),
      createResult('src/b.ts', 'beta', 0.6, '1-2', 'lexical'),
      createResult('src/c.ts', 'gamma', 0.59, '1-2', 'dense'),
      createResult('src/d.ts', 'delta', 0.58, '1-2', 'hybrid'),
    ];

    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    expect(gateDecision.shouldUseTransformerRerank).toBe(false);
    expect(gateDecision.signals.candidateCount).toBe(4);
    expect(gateDecision.reasons).toEqual(
      expect.arrayContaining(['candidate_count=4 < 5'])
    );
  });

  it('keeps the gate conservative when ambiguity signals do not meet the tightened spread thresholds', () => {
    const candidates = [
      createResult('src/a.ts', 'alpha', 0.8, '1-2', 'semantic'),
      createResult('src/b.ts', 'beta', 0.72, '1-2', 'semantic'),
      createResult('src/c.ts', 'gamma', 0.59, '1-2', 'semantic'),
      createResult('src/d.ts', 'delta', 0.58, '1-2', 'semantic'),
      createResult('src/e.ts', 'epsilon', 0.57, '1-2', 'semantic'),
    ];

    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    expect(gateDecision.signals.top1Top2Gap).toBeCloseTo(0.08, 6);
    expect(gateDecision.signals.topKSpread).toBeCloseTo(0.23, 6);
    expect(gateDecision.shouldUseTransformerRerank).toBe(false);
    expect(gateDecision.reasons).toEqual(
      expect.arrayContaining(['query_is_not_ambiguous_enough_for_transformer_rerank'])
    );
  });

  it('uses transformer rerank once the tightened hard-query thresholds are satisfied', () => {
    const candidates = [
      createResult('src/a.ts', 'alpha', 0.61, '1-2', 'semantic'),
      createResult('src/b.ts', 'beta', 0.59, '1-2', 'lexical'),
      createResult('src/c.ts', 'gamma', 0.57, '1-2', 'dense'),
      createResult('src/d.ts', 'delta', 0.55, '1-2', 'hybrid'),
      createResult('src/e.ts', 'epsilon', 0.53, '1-2', 'semantic'),
    ];

    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    expect(gateDecision.signals.candidateCount).toBe(5);
    expect(gateDecision.signals.top1Top2Gap).toBeCloseTo(0.02, 6);
    expect(gateDecision.signals.topKSpread).toBeCloseTo(0.08, 6);
    expect(gateDecision.shouldUseTransformerRerank).toBe(true);
  });

  it('reuses the lazy transformer runtime for repeated reranks', async () => {
    const extractor = createVectorExtractor();
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor));
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      loadTransformersModule,
      gateDecision,
    };

    await rerankCandidates(candidates, options);
    await rerankCandidates(candidates, options);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('shares the feature-extraction pipeline with the embedding runtime when the loader and model match', async () => {
    const extractor = createVectorExtractor();
    const pipeline = jest.fn(async () => extractor);
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline,
    }) as never);
    const embeddingRuntime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 16,
      loadTransformersModule,
    });
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    await embeddingRuntime.embedQuery('login handler');
    await rerankCandidates(candidates, {
      originalQuery: 'login handler',
      loadTransformersModule,
      gateDecision,
    });

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('falls back to the heuristic ranking when transformer loading fails', async () => {
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const loadTransformersModule = jest.fn(async () => {
      throw new Error('transformer unavailable');
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v2',
      loadTransformersModule,
      gateDecision,
    };

    const ranked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(ranked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
  });

  it('reports fail-open transformer trace when runtime loading is unavailable', async () => {
    const trace = jest.fn<(trace: TransformerRerankTrace) => void>();
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });

    await rerankCandidates(candidates, {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule: jest.fn(async () => {
        throw new Error('transformer unavailable');
      }),
      gateDecision,
      onTrace: trace,
    });

    expect(trace).toHaveBeenCalledWith(expect.objectContaining({
      candidateCount: 5,
      selectedPath: 'transformer',
      appliedPath: 'heuristic',
      state: 'fail_open',
      fallbackReason: 'reranker_unavailable',
      reasonCode: 'runtime_unavailable',
      gateDecision,
    }));
  });

  it('keeps deterministic ordering when transformer scores tie', async () => {
    const extractor = jest.fn(async (texts: string | string[]) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map(() => [1, 1, 1]),
      };
    });
    const loadTransformersModule = jest.fn(async () => createTransformersModule(extractor as ReturnType<typeof createVectorExtractor>));
    const candidates = [
      createResult('src/beta.ts', 'shared beta', 0.6, '1-2', 'semantic'),
      createResult('src/alpha.ts', 'shared alpha', 0.6, '1-2', 'lexical'),
      createResult('src/gamma.ts', 'shared gamma', 0.6, '1-2', 'dense'),
      createResult('src/delta.ts', 'shared delta', 0.6, '1-2', 'hybrid'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'shared alpha',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    };

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
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    };

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
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    };

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
    const candidates = [
      createResult('src/database/schema.ts', 'database schema', 0.61, '1-2', 'semantic'),
      createResult('src/auth/login.ts', 'login handler', 0.6, '1-2', 'lexical'),
      createResult('src/shared/alpha.ts', 'shared alpha', 0.59, '1-2', 'dense'),
      createResult('src/shared/beta.ts', 'shared beta', 0.58, '1-2', 'hybrid'),
      createResult('src/shared/gamma.ts', 'shared gamma', 0.57, '1-2', 'semantic'),
    ];
    const gateDecision = evaluateRankingGate(candidates, {
      rankingMode: 'v3',
      profile: 'rich',
    });
    const options: TransformerRerankOptions = {
      originalQuery: 'login handler',
      mode: 'v3',
      loadTransformersModule,
      gateDecision,
    };

    const firstRanked = await rerankCandidates(candidates, options);
    const secondRanked = await rerankCandidates(candidates, options);
    const heuristic = rerankResults(candidates, options);

    expect(firstRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(secondRanked.map((item) => item.path)).toEqual(heuristic.map((item) => item.path));
    expect(extractor).toHaveBeenCalledTimes(1);
  });

  it('records provider path selection and fail-open details on retrieval flow metadata', async () => {
    const flow = createRetrievalFlowContext('xy');
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/x.ts', content: 'x', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/y.ts', content: 'y', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    await retrieve('xy', serviceClient, {
      flow,
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker: {
        id: 'failing-reranker',
        rerank: jest.fn(async () => {
          throw new Error('boom');
        }),
      },
      rerankTopN: 2,
      topK: 5,
    });

    expect(flow.metadata).toMatchObject({
      rerankPath: 'provider',
      rerankSelectedPath: 'provider',
      rerankAppliedPath: 'original_order',
      rerankGateState: 'fail_open',
      rerankFallbackReason: 'rerank_error',
      rerankSelectionReason: 'external_provider',
      rerankCandidateCount: 2,
      rerankHeadCount: 2,
      rerankTailCount: 0,
      rerankProviderId: 'failing-reranker',
    });
    expect(flow.stages).toEqual(expect.arrayContaining([
      'rerank:selected:provider',
      'rerank:applied:original_order',
      'rerank:state:fail_open',
      'rerank:reason:external_provider',
      'rerank:fallback:rerank_error',
    ]));
  });
});
