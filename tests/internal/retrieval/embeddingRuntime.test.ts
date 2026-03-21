import { describe, expect, it, jest } from '@jest/globals';
import {
  clearConfiguredEmbeddingRuntimeCacheForTests,
  createConfiguredEmbeddingRuntime,
  createHashEmbeddingRuntime,
  getConfiguredEmbeddingRuntime,
  describeEmbeddingRuntimeSelection,
} from '../../../src/internal/retrieval/embeddingRuntime.js';

describe('embedding runtime selection', () => {
  afterEach(() => {
    clearConfiguredEmbeddingRuntimeCacheForTests();
  });

  it('keeps the hash runtime deterministic', async () => {
    const runtime = createHashEmbeddingRuntime(32);

    expect(runtime.id).toBe('hash-32');
    expect(runtime.modelId).toBe('hash-32');
    expect(runtime.vectorDimension).toBe(32);

    const query = await runtime.embedQuery('auth login');
    const docs = await runtime.embedDocuments(['auth login', 'database schema']);

    expect(query).toHaveLength(32);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toHaveLength(32);
    expect(docs[1]).toHaveLength(32);
    expect(docs[0]).toEqual(query);
  });

  it('loads a transformer runtime when enabled and returns transformer metadata', async () => {
    const extractor = jest.fn(async (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map((text) => [text.length, options?.normalize === true ? 1 : 0]),
      };
    });
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => extractor),
    }) as never);

    const runtime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    const query = await runtime.embedQuery('auth login');
    const docs = await runtime.embedDocuments(['auth login', 'database schema']);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(runtime.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(runtime.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(runtime.vectorDimension).toBe(16);
    expect(query).toEqual([10, 1]);
    expect(docs).toEqual([
      [10, 1],
      [15, 1],
    ]);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it('falls back to the hash runtime when transformer loading fails', async () => {
    const runtime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      fallbackRuntime: createHashEmbeddingRuntime(16),
      loadTransformersModule: jest.fn(async () => {
        throw new Error('model unavailable');
      }),
    });

    const query = await runtime.embedQuery('fallback query');
    const docs = await runtime.embedDocuments(['fallback query']);

    expect(runtime.id).toBe('hash-16');
    expect(runtime.modelId).toBe('hash-16');
    expect(runtime.vectorDimension).toBe(16);
    expect(query).toHaveLength(16);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toHaveLength(16);
    expect(docs[0]).toEqual(query);
  });

  it('reuses the configured singleton runtime for the same loader and options', async () => {
    const extractor = jest.fn(async (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return {
        tolist: () => values.map((text) => [text.length, options?.normalize === true ? 1 : 0]),
      };
    });
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => extractor),
    }) as never);

    const runtimeA = getConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 2,
      loadTransformersModule,
    });
    const runtimeB = getConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 2,
      loadTransformersModule,
    });

    expect(runtimeA).toBe(runtimeB);
    expect(loadTransformersModule).not.toHaveBeenCalled();

    await runtimeA.embedQuery('auth login');
    await runtimeB.embedDocuments(['auth login']);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });
});

describe('embedding runtime descriptors', () => {
  it('describes the vector backend embedding runtime for artifact metadata', () => {
    expect(describeEmbeddingRuntimeSelection(false)).toEqual({
      id: 'hash-128',
      modelId: 'hash-128',
      vectorDimension: 128,
    });
    expect(describeEmbeddingRuntimeSelection(true)).toEqual({
      id: 'hash-32',
      modelId: 'hash-32',
      vectorDimension: 32,
    });
  });
});
