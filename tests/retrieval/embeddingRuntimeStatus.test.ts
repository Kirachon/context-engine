import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FEATURE_FLAGS } from '../../src/config/features.js';
import {
  clearConfiguredEmbeddingRuntimeCacheForTests,
  createHashEmbeddingRuntime,
  describeConfiguredEmbeddingRuntimeStatus,
  describeEmbeddingRuntimeStatus,
  getConfiguredEmbeddingRuntime,
} from '../../src/internal/retrieval/embeddingRuntime.js';

describe('describeEmbeddingRuntimeStatus augmented descriptor', () => {
  const originalTransformerEmbeddings = FEATURE_FLAGS.retrieval_transformer_embeddings_v1;
  const originalLanceDb = FEATURE_FLAGS.retrieval_lancedb_v1;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = true;
    FEATURE_FLAGS.retrieval_lancedb_v1 = true;
    clearConfiguredEmbeddingRuntimeCacheForTests();
  });

  afterEach(() => {
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = originalTransformerEmbeddings;
    FEATURE_FLAGS.retrieval_lancedb_v1 = originalLanceDb;
    clearConfiguredEmbeddingRuntimeCacheForTests();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('sets hashFallbackActive=true and a non-empty downgrade reason when hash fallback is selected', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loadTransformersModule = jest.fn(async () => {
      throw new Error('model unavailable');
    });

    const runtime = getConfiguredEmbeddingRuntime({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    await runtime.embedQuery('trigger failure');

    const status = describeConfiguredEmbeddingRuntimeStatus({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    expect(status?.state).toBe('degraded');
    expect(status?.active.id).toBe('hash-32');
    expect(status?.configured.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(status?.hashFallbackActive).toBe(true);
    expect(status?.downgrade).not.toBeNull();
    expect(status?.downgrade?.reason.length ?? 0).toBeGreaterThan(0);
    expect(status?.downgrade?.reason).toMatch(/hash-32/);
    expect(status?.downgrade?.since).toBe(status?.lastFailureAt ?? null);
  });

  it('sets hashFallbackActive=false and downgrade=null when configured runtime is healthy/active', async () => {
    const extractor = jest.fn(async (texts: string | string[]) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map(() => Array.from({ length: 16 }, (_, index) => (index === 0 ? 1 : 0))),
      };
    });
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => extractor),
    }) as never);

    const runtime = getConfiguredEmbeddingRuntime({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    await runtime.prepareForSearch?.();

    const status = describeConfiguredEmbeddingRuntimeStatus({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    expect(status?.state).toBe('healthy');
    expect(status?.active.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(status?.configured.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(status?.hashFallbackActive).toBe(false);
    expect(status?.downgrade).toBeNull();
  });

  it('describeEmbeddingRuntimeStatus uninitialized status includes additive fields with safe defaults', () => {
    const status = describeEmbeddingRuntimeStatus(true);

    expect(status).toBeDefined();
    expect(status?.state).toBe('uninitialized');
    expect(status?.hashFallbackActive).toBe(false);
    expect(status?.downgrade).toBeNull();
  });
});
