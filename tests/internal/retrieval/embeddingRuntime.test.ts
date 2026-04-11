import { describe, expect, it, jest } from '@jest/globals';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import {
  clearConfiguredEmbeddingRuntimeCacheForTests,
  createConfiguredEmbeddingRuntime,
  createHashEmbeddingRuntime,
  describeConfiguredEmbeddingRuntimeStatus,
  getConfiguredEmbeddingRuntime,
  describeEmbeddingRuntimeSelection,
} from '../../../src/internal/retrieval/embeddingRuntime.js';

const originalTransformerEmbeddings = FEATURE_FLAGS.retrieval_transformer_embeddings_v1;

function createTransformerExtractor(vectorDimension: number) {
  return jest.fn(async (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => {
    const values = Array.isArray(texts) ? texts : [texts];
    return {
      tolist: () => values.map((text) => Array.from(
        { length: vectorDimension },
        (_, index) => (index === 0 ? text.length : index === 1 ? (options?.normalize === true ? 1 : 0) : 0)
      )),
    };
  });
}

describe('embedding runtime selection', () => {
  afterEach(() => {
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = originalTransformerEmbeddings;
    delete process.env.CE_RETRIEVAL_TRANSFORMER_MODEL_ID;
    delete process.env.CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION;
    delete process.env.CE_RETRIEVAL_TRANSFORMER_LOCAL_MODEL_PATH;
    clearConfiguredEmbeddingRuntimeCacheForTests();
    jest.restoreAllMocks();
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
    const extractor = createTransformerExtractor(16);
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
    expect(query).toEqual([10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(docs).toEqual([
      [10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [15, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    expect(extractor).toHaveBeenCalledTimes(3);
  });

  it('falls back to the hash runtime when transformer loading fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    const extractor = createTransformerExtractor(16);
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => extractor),
    }) as never);

    const runtimeA = getConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 16,
      loadTransformersModule,
    });
    const runtimeB = getConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 16,
      loadTransformersModule,
    });

    expect(runtimeA).toBe(runtimeB);
    expect(loadTransformersModule).not.toHaveBeenCalled();

    await runtimeA.embedQuery('auth login');
    await runtimeB.embedDocuments(['auth login']);

    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(3);
  });

  it('uses env-selected transformer settings when explicit options are omitted', async () => {
    FEATURE_FLAGS.retrieval_transformer_embeddings_v1 = true;
    process.env.CE_RETRIEVAL_TRANSFORMER_MODEL_ID = 'Xenova/bge-small-en-v1.5';
    process.env.CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION = '16';

    const extractor = createTransformerExtractor(16);
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => extractor),
    }) as never);

    expect(describeEmbeddingRuntimeSelection(true)).toEqual({
      id: 'transformers:Xenova/bge-small-en-v1.5',
      modelId: 'Xenova/bge-small-en-v1.5',
      vectorDimension: 16,
    });

    const runtime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      loadTransformersModule,
    });
    const query = await runtime.embedQuery('auth');

    expect(runtime.id).toBe('transformers:Xenova/bge-small-en-v1.5');
    expect(runtime.modelId).toBe('Xenova/bge-small-en-v1.5');
    expect(runtime.vectorDimension).toBe(16);
    expect(query).toHaveLength(16);
    expect(query.slice(0, 2)).toEqual([4, 1]);
  });

  it('preserves the hash runtime default when transformer embeddings are not enabled', async () => {
    process.env.CE_RETRIEVAL_TRANSFORMER_MODEL_ID = 'Xenova/bge-small-en-v1.5';
    process.env.CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION = '16';

    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => createTransformerExtractor(16)),
    }) as never);

    const runtime = createConfiguredEmbeddingRuntime({
      loadTransformersModule,
    });
    const query = await runtime.embedQuery('auth');

    expect(runtime.id).toBe('hash-128');
    expect(runtime.modelId).toBe('hash-128');
    expect(runtime.vectorDimension).toBe(128);
    expect(query).toHaveLength(128);
    expect(loadTransformersModule).not.toHaveBeenCalled();
  });

  it('lets explicit transformer settings override env-selected defaults', async () => {
    process.env.CE_RETRIEVAL_TRANSFORMER_MODEL_ID = 'Xenova/bge-small-en-v1.5';
    process.env.CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION = '32';

    const extractor = createTransformerExtractor(16);
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

    await runtime.prepareForSearch?.();

    expect(runtime.id).toBe('transformers:Xenova/all-MiniLM-L6-v2');
    expect(runtime.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(runtime.vectorDimension).toBe(16);
  });

  it('falls back when the configured vector dimension does not match the model output', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loadTransformersModule = jest.fn(async () => ({
      env: { localModelPath: '' },
      pipeline: jest.fn(async () => createTransformerExtractor(16)),
    }) as never);
    const runtime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/bge-small-en-v1.5',
      transformerVectorDimension: 32,
      fallbackRuntime: createHashEmbeddingRuntime(16),
      loadTransformersModule,
    });

    const query = await runtime.embedQuery('fallback query');
    const status = describeConfiguredEmbeddingRuntimeStatus({
      preferTransformers: true,
      transformerModelId: 'Xenova/bge-small-en-v1.5',
      transformerVectorDimension: 32,
      fallbackRuntime: createHashEmbeddingRuntime(16),
      loadTransformersModule,
    });

    expect(query).toHaveLength(16);
    expect(loadTransformersModule).toHaveBeenCalledTimes(1);
    expect(runtime.id).toBe('hash-16');
    expect(runtime.modelId).toBe('hash-16');
    expect(runtime.vectorDimension).toBe(16);
    expect(status).toMatchObject({
      state: 'degraded',
      configured: {
        id: 'transformers:Xenova/bge-small-en-v1.5',
        modelId: 'Xenova/bge-small-en-v1.5',
        vectorDimension: 32,
      },
      active: {
        id: 'hash-16',
      },
      loadFailures: 1,
    });
    expect(status?.lastFailure).toContain('embedding dimension 16');
    expect(status?.lastFailure).toContain('configured for 32');
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
