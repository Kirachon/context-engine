import * as path from 'node:path';

export type TransformersModule = typeof import('@huggingface/transformers');
export type TransformersLoader = () => Promise<TransformersModule>;
export type FeatureExtractionPipeline = (
  input: string | string[],
  options?: {
    pooling?: 'mean' | 'none' | 'cls' | 'first_token' | 'eos' | 'last_token';
    normalize?: boolean;
  }
) => Promise<unknown>;

export const DEFAULT_TRANSFORMER_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_TRANSFORMER_VECTOR_DIMENSION = 384;

const defaultFeatureExtractionPipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();
let customFeatureExtractionPipelineCache = new WeakMap<
  TransformersLoader,
  Map<string, Promise<FeatureExtractionPipeline>>
>();

export const defaultLoadTransformersModule: TransformersLoader = () => import('@huggingface/transformers');

export function normalizeTransformerModelId(modelId: string | undefined): string {
  const trimmed = modelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TRANSFORMER_MODEL_ID;
}

function normalizeLocalModelPath(localModelPath: string | undefined): string {
  const trimmed = localModelPath?.trim();
  return trimmed ? path.resolve(trimmed) : '';
}

function getFeatureExtractionPipelineCache(loader: TransformersLoader): Map<string, Promise<FeatureExtractionPipeline>> {
  if (loader === defaultLoadTransformersModule) {
    return defaultFeatureExtractionPipelineCache;
  }

  const existing = customFeatureExtractionPipelineCache.get(loader);
  if (existing) {
    return existing;
  }

  const created = new Map<string, Promise<FeatureExtractionPipeline>>();
  customFeatureExtractionPipelineCache.set(loader, created);
  return created;
}

export async function getSharedFeatureExtractionPipeline(options: {
  modelId: string;
  localModelPath?: string;
  loadTransformersModule?: TransformersLoader;
}): Promise<FeatureExtractionPipeline> {
  const modelId = normalizeTransformerModelId(options.modelId);
  const loader = options.loadTransformersModule ?? defaultLoadTransformersModule;
  const cache = getFeatureExtractionPipelineCache(loader);
  const localModelPath = normalizeLocalModelPath(options.localModelPath);
  const cacheKey = `${modelId}|${localModelPath}`;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pipelinePromise = (async () => {
    const transformers = await loader();
    if (localModelPath) {
      const env = (transformers as { env?: { localModelPath?: string } }).env;
      if (env) {
        env.localModelPath = localModelPath;
      }
    }

    return transformers.pipeline('feature-extraction', modelId, {
      dtype: 'fp32',
    });
  })().catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });

  cache.set(cacheKey, pipelinePromise);
  return pipelinePromise;
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

export function normalizeEmbeddingRows(output: unknown): number[][] {
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

export function clearSharedTransformersPipelineCacheForTests(): void {
  defaultFeatureExtractionPipelineCache.clear();
  customFeatureExtractionPipelineCache = new WeakMap<
    TransformersLoader,
    Map<string, Promise<FeatureExtractionPipeline>>
  >();
}
