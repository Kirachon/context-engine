import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FEATURE_FLAGS } from '../../src/config/features.js';
import {
  clearConfiguredEmbeddingRuntimeCacheForTests,
  createHashEmbeddingRuntime,
  describeConfiguredEmbeddingRuntimeStatus,
  describeLastEmbeddingRuntimeStatus,
  describeEmbeddingRuntimeStatus,
  getConfiguredEmbeddingRuntime,
} from '../../src/internal/retrieval/embeddingRuntime.js';
import { renderPrometheusMetrics } from '../../src/metrics/metrics.js';

function getFailureMetricCount(metricsText: string): number {
  const match = metricsText.match(
    /context_engine_embedding_transformer_load_failures_total\{[^}]*fallback_runtime="hash-32"[^}]*model_id="Xenova\/all-MiniLM-L6-v2"[^}]*\}\s+(\d+)/
  );
  return Number(match?.[1] ?? 0);
}

describe('embedding runtime degradation', () => {
  const originalMetrics = FEATURE_FLAGS.metrics;
  const originalLanceDb = FEATURE_FLAGS.retrieval_lancedb_v1;
  const originalTransformerEmbeddings = FEATURE_FLAGS.retrieval_transformer_embeddings_v1;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    FEATURE_FLAGS.metrics = true;
    FEATURE_FLAGS.retrieval_lancedb_v1 = true;
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = true;
    clearConfiguredEmbeddingRuntimeCacheForTests();
  });

  afterEach(() => {
    FEATURE_FLAGS.metrics = originalMetrics;
    FEATURE_FLAGS.retrieval_lancedb_v1 = originalLanceDb;
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = originalTransformerEmbeddings;
    clearConfiguredEmbeddingRuntimeCacheForTests();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('records fallback failures, exposes degraded status, and recovers on retry', async () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const extractor = jest.fn(async (texts: string | string[], options?: { normalize?: boolean }) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map((text) => Array.from(
          { length: 16 },
          (_, index) => (index === 0 ? text.length : index === 1 ? (options?.normalize === true ? 1 : 0) : 0)
        )),
      };
    });
    let shouldFail = true;
    const loadTransformersModule = jest.fn(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('model unavailable');
      }
      return ({
        env: { localModelPath: '' },
        pipeline: jest.fn(async () => extractor),
      }) as never;
    });
    const runtime = getConfiguredEmbeddingRuntime({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });
    const beforeMetrics = getFailureMetricCount(renderPrometheusMetrics());

    const fallbackVector = await runtime.embedQuery('fallback query');
    const degradedStatus = describeConfiguredEmbeddingRuntimeStatus({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    expect(fallbackVector).toHaveLength(32);
    expect(runtime.id).toBe('hash-32');
    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(getFailureMetricCount(renderPrometheusMetrics())).toBe(beforeMetrics + 1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Falling back to "hash-32"'));
    expect(degradedStatus).toMatchObject({
      state: 'degraded',
      configured: {
        id: 'transformers:Xenova/all-MiniLM-L6-v2',
      },
      active: {
        id: 'hash-32',
      },
      lastFailure: 'model unavailable',
      loadFailures: 1,
    });
    expect(degradedStatus?.nextRetryAt).toBe('2026-01-01T00:01:00.000Z');
    expect(describeEmbeddingRuntimeStatus(true)?.state).toBe('uninitialized');
    expect(describeLastEmbeddingRuntimeStatus()?.state).toBe('degraded');

    jest.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
    expect(runtime.id).toBe('hash-32');

    await runtime.prepareForSearch?.();
    expect(runtime.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');

    const recoveredVector = await runtime.embedQuery('recovered');
    const recoveredStatus = describeConfiguredEmbeddingRuntimeStatus({
      fallbackRuntime: createHashEmbeddingRuntime(32),
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    expect(loadTransformersModule).toHaveBeenCalledTimes(2);
    expect(recoveredVector).toHaveLength(16);
    expect(recoveredVector.slice(0, 2)).toEqual([9, 1]);
    expect(runtime.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(recoveredStatus).toMatchObject({
      state: 'healthy',
      active: {
        id: 'transformers:Xenova/all-MiniLM-L6-v2',
      },
      loadFailures: 1,
    });
    expect(recoveredStatus?.lastFailure).toBeUndefined();
    expect(recoveredStatus?.nextRetryAt).toBeUndefined();
    expect(describeLastEmbeddingRuntimeStatus()?.state).toBe('healthy');
  });
});
