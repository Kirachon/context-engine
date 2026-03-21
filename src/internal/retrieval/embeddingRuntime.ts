import * as path from 'node:path';
import { featureEnabled } from '../../config/features.js';
import { createHashEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';

type TransformersModule = typeof import('@huggingface/transformers');

export interface EmbeddingRuntime extends EmbeddingProvider {
  modelId: string;
  vectorDimension: number;
}

export interface EmbeddingRuntimeSelection {
  id: string;
  modelId: string;
  vectorDimension: number;
}

export interface ConfiguredEmbeddingRuntimeOptions {
  preferTransformers?: boolean;
  transformerModelId?: string;
  transformerVectorDimension?: number;
  localModelPath?: string;
  loadTransformersModule?: () => Promise<TransformersModule>;
  fallbackRuntime?: EmbeddingRuntime;
}

const DEFAULT_TRANSFORMER_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_TRANSFORMER_VECTOR_DIMENSION = 384;
const DEFAULT_HASH_VECTOR_DIMENSION = 128;
const DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX = 'transformers';
type TransformersLoader = () => Promise<TransformersModule>;

const configuredRuntimeCache = new Map<string, EmbeddingRuntime>();
let customConfiguredRuntimeCache = new WeakMap<TransformersLoader, Map<string, EmbeddingRuntime>>();

function normalizeVectorDimension(dimensions: number): number {
  return Math.max(16, Math.min(1024, Math.floor(dimensions)));
}

function normalizeModelId(modelId: string | undefined): string {
  const trimmed = modelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TRANSFORMER_MODEL_ID;
}

function createEmbeddingRuntimeFromProvider(provider: EmbeddingProvider, modelId: string, vectorDimension: number): EmbeddingRuntime {
  return {
    ...provider,
    modelId,
    vectorDimension,
  };
}

function createRuntimeSelection(id: string, modelId: string, vectorDimension: number): EmbeddingRuntimeSelection {
  return { id, modelId, vectorDimension };
}

function toNumericArray(values: unknown): number[] {
  if (Array.isArray(values)) {
    return values.map((value) => (typeof value === 'number' ? value : Number(value)));
  }
  if (ArrayBuffer.isView(values)) {
    return Array.from(values as unknown as ArrayLike<number>, (value) => value);
  }
  return [];
}

function unwrapTensorLike(output: unknown): unknown {
  if (output && typeof output === 'object' && 'tolist' in output && typeof (output as { tolist?: unknown }).tolist === 'function') {
    return (output as { tolist: () => unknown }).tolist();
  }
  return output;
}

function normalizeEmbeddingRows(output: unknown): number[][] {
  const unwrapped = unwrapTensorLike(output);
  if (!Array.isArray(unwrapped)) {
    return [];
  }
  if (unwrapped.length === 0) {
    return [];
  }
  if (Array.isArray(unwrapped[0])) {
    return unwrapped.map((row) => toNumericArray(row));
  }
  return [toNumericArray(unwrapped)];
}

function createTransformerFallbackRuntime(fallbackRuntime: EmbeddingRuntime): EmbeddingRuntime {
  return {
    id: fallbackRuntime.id,
    modelId: fallbackRuntime.modelId,
    vectorDimension: fallbackRuntime.vectorDimension,
    embedQuery: fallbackRuntime.embedQuery,
    embedDocuments: fallbackRuntime.embedDocuments,
  };
}

function buildConfiguredRuntimeCacheKey(
  options: Required<Pick<ConfiguredEmbeddingRuntimeOptions, 'transformerModelId' | 'transformerVectorDimension'>> & {
    preferTransformers: boolean;
    localModelPath?: string;
    fallbackRuntime?: EmbeddingRuntime;
  }
): string {
  const fallbackRuntime = options.fallbackRuntime;
  const fallbackSignature = fallbackRuntime
    ? `${fallbackRuntime.id}|${fallbackRuntime.modelId}|${fallbackRuntime.vectorDimension}`
    : `hash-${DEFAULT_HASH_VECTOR_DIMENSION}`;
  const localModelPath = options.localModelPath?.trim() ?? '';
  return [
    options.preferTransformers ? 'transformers' : 'fallback',
    options.transformerModelId,
    options.transformerVectorDimension,
    localModelPath,
    fallbackSignature,
  ].join('|');
}

function getRuntimeCache(loadTransformersModule?: TransformersLoader): Map<string, EmbeddingRuntime> {
  if (!loadTransformersModule) {
    return configuredRuntimeCache;
  }

  const existing = customConfiguredRuntimeCache.get(loadTransformersModule);
  if (existing) {
    return existing;
  }

  const created = new Map<string, EmbeddingRuntime>();
  customConfiguredRuntimeCache.set(loadTransformersModule, created);
  return created;
}

async function buildTransformersEmbeddingRuntime(
  modelId: string,
  vectorDimension: number,
  localModelPath: string | undefined,
  loadTransformersModule: () => Promise<TransformersModule>
): Promise<EmbeddingRuntime> {
  const transformers = await loadTransformersModule();
  if (localModelPath) {
    transformers.env.localModelPath = path.resolve(localModelPath);
  }

  const extractor = await transformers.pipeline('feature-extraction', modelId, {
    dtype: 'fp32',
  });

  return createEmbeddingRuntimeFromProvider(
    {
      id: `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${modelId}`,
      async embedQuery(query: string): Promise<number[]> {
        const vectors = await normalizeEmbeddingRows(await extractor(query, {
          pooling: 'mean',
          normalize: true,
        }));
        return vectors[0] ?? [];
      },
      async embedDocuments(documents: string[]): Promise<number[][]> {
        if (documents.length === 0) {
          return [];
        }
        return normalizeEmbeddingRows(await extractor(documents, {
          pooling: 'mean',
          normalize: true,
        }));
      },
    },
    modelId,
    vectorDimension
  );
}

function createLazyTransformerRuntime(
  fallbackRuntime: EmbeddingRuntime,
  options: Required<Pick<ConfiguredEmbeddingRuntimeOptions, 'transformerModelId' | 'transformerVectorDimension'>> & {
    localModelPath?: string;
    loadTransformersModule?: () => Promise<TransformersModule>;
  }
): EmbeddingRuntime {
  let resolvedRuntime: EmbeddingRuntime | null = null;
  let resolutionPromise: Promise<EmbeddingRuntime> | null = null;

  const resolveRuntime = async (): Promise<EmbeddingRuntime> => {
    if (resolvedRuntime) {
      return resolvedRuntime;
    }

    if (!resolutionPromise) {
      resolutionPromise = (async () => {
        try {
          const runtime = await buildTransformersEmbeddingRuntime(
            options.transformerModelId,
            options.transformerVectorDimension,
            options.localModelPath,
            options.loadTransformersModule ?? (async () => import('@huggingface/transformers'))
          );
          resolvedRuntime = runtime;
          return runtime;
        } catch {
          resolvedRuntime = fallbackRuntime;
          return fallbackRuntime;
        }
      })();
    }

    const runtime = await resolutionPromise;
    resolvedRuntime = runtime;
    return runtime;
  };

  return {
    get id(): string {
      return resolvedRuntime?.id ?? `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${options.transformerModelId}`;
    },
    get modelId(): string {
      return resolvedRuntime?.modelId ?? options.transformerModelId;
    },
    get vectorDimension(): number {
      return resolvedRuntime?.vectorDimension ?? options.transformerVectorDimension;
    },
    async embedQuery(query: string): Promise<number[]> {
      const runtime = await resolveRuntime();
      return runtime.embedQuery(query);
    },
    async embedDocuments(documents: string[]): Promise<number[][]> {
      const runtime = await resolveRuntime();
      return runtime.embedDocuments(documents);
    },
  };
}

export function createHashEmbeddingRuntime(dimensions: number = DEFAULT_HASH_VECTOR_DIMENSION): EmbeddingRuntime {
  const vectorDimension = normalizeVectorDimension(dimensions);
  const provider = createHashEmbeddingProvider(vectorDimension);
  return createEmbeddingRuntimeFromProvider(provider, provider.id, vectorDimension);
}

export function clearConfiguredEmbeddingRuntimeCacheForTests(): void {
  configuredRuntimeCache.clear();
  customConfiguredRuntimeCache = new WeakMap<TransformersLoader, Map<string, EmbeddingRuntime>>();
}

export function describeEmbeddingRuntimeSelection(useVectorBackend: boolean): EmbeddingRuntimeSelection {
  if (!useVectorBackend) {
    return createRuntimeSelection(
      `hash-${DEFAULT_HASH_VECTOR_DIMENSION}`,
      `hash-${DEFAULT_HASH_VECTOR_DIMENSION}`,
      DEFAULT_HASH_VECTOR_DIMENSION
    );
  }

  if (featureEnabled('retrieval_transformer_embeddings_v1')) {
    return createRuntimeSelection(
      `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${DEFAULT_TRANSFORMER_MODEL_ID}`,
      DEFAULT_TRANSFORMER_MODEL_ID,
      DEFAULT_TRANSFORMER_VECTOR_DIMENSION
    );
  }

  return createRuntimeSelection('hash-32', 'hash-32', 32);
}

export function createConfiguredEmbeddingRuntime(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): EmbeddingRuntime {
  const preferTransformers = options.preferTransformers ?? featureEnabled('retrieval_transformer_embeddings_v1');
  const fallbackRuntime = options.fallbackRuntime ?? createHashEmbeddingRuntime();
  const transformerModelId = normalizeModelId(options.transformerModelId);
  const transformerVectorDimension = normalizeVectorDimension(
    options.transformerVectorDimension ?? DEFAULT_TRANSFORMER_VECTOR_DIMENSION
  );

  if (!preferTransformers) {
    return createTransformerFallbackRuntime(fallbackRuntime);
  }

  return createLazyTransformerRuntime(fallbackRuntime, {
    transformerModelId,
    transformerVectorDimension,
    localModelPath: options.localModelPath,
    loadTransformersModule: options.loadTransformersModule,
  });
}

export function getConfiguredEmbeddingRuntime(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): EmbeddingRuntime {
  const preferTransformers = options.preferTransformers ?? featureEnabled('retrieval_transformer_embeddings_v1');
  const transformerModelId = normalizeModelId(options.transformerModelId);
  const transformerVectorDimension = normalizeVectorDimension(
    options.transformerVectorDimension ?? DEFAULT_TRANSFORMER_VECTOR_DIMENSION
  );
  const cache = getRuntimeCache(options.loadTransformersModule as TransformersLoader | undefined);
  const cacheKey = buildConfiguredRuntimeCacheKey({
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
    localModelPath: options.localModelPath,
    fallbackRuntime: options.fallbackRuntime,
  });

  const cachedRuntime = cache.get(cacheKey);
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const runtime = createConfiguredEmbeddingRuntime({
    ...options,
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
  });
  cache.set(cacheKey, runtime);
  return runtime;
}
