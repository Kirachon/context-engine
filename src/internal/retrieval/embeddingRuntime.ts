import { featureEnabled } from '../../config/features.js';
import { envInt, envString } from '../../config/env.js';
import { incCounter } from '../../metrics/metrics.js';
import { createHashEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';
import {
  clearSharedTransformersPipelineCacheForTests,
  DEFAULT_TRANSFORMER_VECTOR_DIMENSION,
  defaultLoadTransformersModule,
  getSharedFeatureExtractionPipeline,
  normalizeEmbeddingRows,
  normalizeTransformerModelId,
  type TransformersLoader,
  type TransformersModule,
} from './transformersShared.js';

export interface EmbeddingRuntime extends EmbeddingProvider {
  modelId: string;
  vectorDimension: number;
  prepareForSearch?: () => Promise<void>;
}

export interface EmbeddingRuntimeSelection {
  id: string;
  modelId: string;
  vectorDimension: number;
}

export interface EmbeddingRuntimeStatus {
  state: 'uninitialized' | 'healthy' | 'degraded';
  configured: EmbeddingRuntimeSelection;
  active: EmbeddingRuntimeSelection;
  fallback: EmbeddingRuntimeSelection;
  loadFailures: number;
  lastFailure?: string;
  lastFailureAt?: string;
  nextRetryAt?: string;
}

export interface ConfiguredEmbeddingRuntimeOptions {
  preferTransformers?: boolean;
  transformerModelId?: string;
  transformerVectorDimension?: number;
  localModelPath?: string;
  loadTransformersModule?: () => Promise<TransformersModule>;
  fallbackRuntime?: EmbeddingRuntime;
}

const DEFAULT_HASH_VECTOR_DIMENSION = 128;
const DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX = 'transformers';
const TRANSFORMER_LOAD_RETRY_DELAY_MS = 60_000;
const TRANSFORMER_MODEL_ID_ENV_VAR = 'CE_RETRIEVAL_TRANSFORMER_MODEL_ID';
const TRANSFORMER_VECTOR_DIMENSION_ENV_VAR = 'CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION';
const TRANSFORMER_LOCAL_MODEL_PATH_ENV_VAR = 'CE_RETRIEVAL_TRANSFORMER_LOCAL_MODEL_PATH';
const TRANSFORMER_RUNTIME_PROBE_INPUT = 'context-engine embedding probe';

const configuredRuntimeCache = new Map<string, EmbeddingRuntime>();
let customConfiguredRuntimeCache = new WeakMap<TransformersLoader, Map<string, EmbeddingRuntime>>();
const configuredRuntimeStatus = new Map<string, EmbeddingRuntimeStatus>();
let customConfiguredRuntimeStatus = new WeakMap<TransformersLoader, Map<string, EmbeddingRuntimeStatus>>();
let lastObservedRuntimeStatus:
  | {
      cacheKey: string;
      loadTransformersModule?: TransformersLoader;
    }
  | null = null;

function normalizeVectorDimension(dimensions: number): number {
  return Math.max(16, Math.min(1024, Math.floor(dimensions)));
}

function createEmbeddingRuntimeFromProvider(provider: EmbeddingProvider, modelId: string, vectorDimension: number): EmbeddingRuntime {
  return {
    ...provider,
    modelId,
    vectorDimension,
  };
}

function resolveTransformerEmbeddingSettingsFromEnv(): Required<
  Pick<ConfiguredEmbeddingRuntimeOptions, 'transformerModelId' | 'transformerVectorDimension'>
> & {
  localModelPath?: string;
} {
  const transformerModelId = normalizeTransformerModelId(envString(TRANSFORMER_MODEL_ID_ENV_VAR));
  const transformerVectorDimension = normalizeVectorDimension(
    envInt(
      TRANSFORMER_VECTOR_DIMENSION_ENV_VAR,
      DEFAULT_TRANSFORMER_VECTOR_DIMENSION,
      { min: 16, max: 1024 }
    )
  );
  const localModelPath = envString(TRANSFORMER_LOCAL_MODEL_PATH_ENV_VAR);
  return {
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
  };
}

function resolveConfiguredEmbeddingRuntimeOptions(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): Required<Pick<ConfiguredEmbeddingRuntimeOptions, 'preferTransformers'>> &
  Required<Pick<ConfiguredEmbeddingRuntimeOptions, 'transformerModelId' | 'transformerVectorDimension'>> & {
    fallbackRuntime: EmbeddingRuntime;
    localModelPath?: string;
    loadTransformersModule?: TransformersLoader;
  } {
  const envSettings = resolveTransformerEmbeddingSettingsFromEnv();
  return {
    preferTransformers: options.preferTransformers ?? featureEnabled('retrieval_transformer_embeddings_v1'),
    transformerModelId: normalizeTransformerModelId(options.transformerModelId ?? envSettings.transformerModelId),
    transformerVectorDimension: normalizeVectorDimension(
      options.transformerVectorDimension ?? envSettings.transformerVectorDimension
    ),
    localModelPath: options.localModelPath ?? envSettings.localModelPath,
    loadTransformersModule: options.loadTransformersModule,
    fallbackRuntime: options.fallbackRuntime ?? createHashEmbeddingRuntime(),
  };
}

function createRuntimeSelection(id: string, modelId: string, vectorDimension: number): EmbeddingRuntimeSelection {
  return { id, modelId, vectorDimension };
}

function cloneRuntimeSelection(selection: EmbeddingRuntimeSelection): EmbeddingRuntimeSelection {
  return createRuntimeSelection(selection.id, selection.modelId, selection.vectorDimension);
}

function validateNormalizedEmbeddingRows(
  rows: number[][],
  expectedDimension: number,
  modelId: string
): number[][] {
  if (rows.length === 0) {
    throw new Error(`Transformer model "${modelId}" returned no embedding rows.`);
  }

  for (const row of rows) {
    if (row.length !== expectedDimension) {
      throw new Error(
        `Transformer model "${modelId}" returned embedding dimension ${row.length}, but runtime is configured for ${expectedDimension}. `
        + `Set ${TRANSFORMER_VECTOR_DIMENSION_ENV_VAR} or transformerVectorDimension to match the selected model.`
      );
    }
    if (row.some((value) => !Number.isFinite(value))) {
      throw new Error(`Transformer model "${modelId}" returned a non-finite embedding value.`);
    }
  }

  return rows;
}

function selectionFromRuntime(runtime: Pick<EmbeddingRuntime, 'id' | 'modelId' | 'vectorDimension'>): EmbeddingRuntimeSelection {
  return createRuntimeSelection(runtime.id, runtime.modelId, runtime.vectorDimension);
}

function cloneRuntimeStatus(status: EmbeddingRuntimeStatus): EmbeddingRuntimeStatus {
  return {
    state: status.state,
    configured: cloneRuntimeSelection(status.configured),
    active: cloneRuntimeSelection(status.active),
    fallback: cloneRuntimeSelection(status.fallback),
    loadFailures: status.loadFailures,
    lastFailure: status.lastFailure,
    lastFailureAt: status.lastFailureAt,
    nextRetryAt: status.nextRetryAt,
  };
}

function ensureRuntimeStatus(
  cacheKey: string,
  configured: EmbeddingRuntimeSelection,
  fallback: EmbeddingRuntimeSelection,
  loadTransformersModule?: TransformersLoader
): EmbeddingRuntimeStatus {
  const store = getRuntimeStatusStore(loadTransformersModule);
  const existing = store.get(cacheKey);
  if (existing) {
    return existing;
  }

  const created: EmbeddingRuntimeStatus = {
    state: 'uninitialized',
    configured: cloneRuntimeSelection(configured),
    active: cloneRuntimeSelection(configured),
    fallback: cloneRuntimeSelection(fallback),
    loadFailures: 0,
  };
  store.set(cacheKey, created);
  return created;
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

function getRuntimeStatusStore(loadTransformersModule?: TransformersLoader): Map<string, EmbeddingRuntimeStatus> {
  if (!loadTransformersModule) {
    return configuredRuntimeStatus;
  }

  const existing = customConfiguredRuntimeStatus.get(loadTransformersModule);
  if (existing) {
    return existing;
  }

  const created = new Map<string, EmbeddingRuntimeStatus>();
  customConfiguredRuntimeStatus.set(loadTransformersModule, created);
  return created;
}

function markRuntimeStatusObserved(cacheKey: string, loadTransformersModule?: TransformersLoader): void {
  lastObservedRuntimeStatus = {
    cacheKey,
    loadTransformersModule,
  };
}

async function buildTransformersEmbeddingRuntime(
  modelId: string,
  vectorDimension: number,
  localModelPath: string | undefined,
  loadTransformersModule: TransformersLoader
): Promise<EmbeddingRuntime> {
  const extractor = await getSharedFeatureExtractionPipeline({
    modelId,
    localModelPath,
    loadTransformersModule,
  });
  const extractNormalizedVectors = async (input: string | string[]): Promise<number[][]> =>
    validateNormalizedEmbeddingRows(
      normalizeEmbeddingRows(await extractor(input, {
        pooling: 'mean',
        normalize: true,
      })),
      vectorDimension,
      modelId
    );
  await extractNormalizedVectors(TRANSFORMER_RUNTIME_PROBE_INPUT);

  return createEmbeddingRuntimeFromProvider(
    {
      id: `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${modelId}`,
      async embedQuery(query: string): Promise<number[]> {
        const vectors = await extractNormalizedVectors(query);
        return vectors[0] ?? [];
      },
      async embedDocuments(documents: string[]): Promise<number[][]> {
        if (documents.length === 0) {
          return [];
        }
        return extractNormalizedVectors(documents);
      },
    },
    modelId,
    vectorDimension
  );
}

function createLazyTransformerRuntime(
  fallbackRuntime: EmbeddingRuntime,
  options: Required<Pick<ConfiguredEmbeddingRuntimeOptions, 'transformerModelId' | 'transformerVectorDimension'>> & {
    cacheKey: string;
    localModelPath?: string;
    loadTransformersModule?: () => Promise<TransformersModule>;
  }
): EmbeddingRuntime {
  const configuredSelection = createRuntimeSelection(
    `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${options.transformerModelId}`,
    options.transformerModelId,
    options.transformerVectorDimension
  );
  const fallbackSelection = selectionFromRuntime(fallbackRuntime);
  const runtimeStatus = ensureRuntimeStatus(
    options.cacheKey,
    configuredSelection,
    fallbackSelection,
    options.loadTransformersModule
  );
  let resolvedRuntime: EmbeddingRuntime | null = null;
  let resolutionPromise: Promise<EmbeddingRuntime> | null = null;
  let nextRetryAtMs = runtimeStatus.nextRetryAt ? Math.max(0, Date.parse(runtimeStatus.nextRetryAt)) : 0;

  const getVisibleSelection = (): EmbeddingRuntimeSelection => {
    if (resolvedRuntime) {
      return selectionFromRuntime(resolvedRuntime);
    }
    if (runtimeStatus.state === 'degraded') {
      return fallbackSelection;
    }
    return configuredSelection;
  };

  const resolveRuntime = async (): Promise<EmbeddingRuntime> => {
    if (resolvedRuntime) {
      markRuntimeStatusObserved(options.cacheKey, options.loadTransformersModule);
      return resolvedRuntime;
    }

    if (runtimeStatus.state === 'degraded' && nextRetryAtMs > Date.now()) {
      markRuntimeStatusObserved(options.cacheKey, options.loadTransformersModule);
      return fallbackRuntime;
    }

    if (!resolutionPromise) {
      resolutionPromise = (async () => {
        try {
          const runtime = await buildTransformersEmbeddingRuntime(
            options.transformerModelId,
            options.transformerVectorDimension,
            options.localModelPath,
            options.loadTransformersModule ?? defaultLoadTransformersModule
          );
          resolvedRuntime = runtime;
          nextRetryAtMs = 0;
          runtimeStatus.state = 'healthy';
          runtimeStatus.active = selectionFromRuntime(runtime);
          delete runtimeStatus.lastFailure;
          delete runtimeStatus.lastFailureAt;
          delete runtimeStatus.nextRetryAt;
          markRuntimeStatusObserved(options.cacheKey, options.loadTransformersModule);
          return runtime;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureAt = new Date().toISOString();
          nextRetryAtMs = Date.now() + TRANSFORMER_LOAD_RETRY_DELAY_MS;
          runtimeStatus.state = 'degraded';
          runtimeStatus.active = cloneRuntimeSelection(fallbackSelection);
          runtimeStatus.loadFailures += 1;
          runtimeStatus.lastFailure = message;
          runtimeStatus.lastFailureAt = failureAt;
          runtimeStatus.nextRetryAt = new Date(nextRetryAtMs).toISOString();
          incCounter(
            'context_engine_embedding_transformer_load_failures_total',
            {
              fallback_runtime: fallbackSelection.id,
              model_id: options.transformerModelId,
            },
            1,
            'Total transformer embedding runtime load failures.'
          );
          console.warn(
            `[embeddingRuntime] Falling back to "${fallbackSelection.id}" after transformer load failure for "${options.transformerModelId}": ${message}. Retrying after ${runtimeStatus.nextRetryAt}.`
          );
          markRuntimeStatusObserved(options.cacheKey, options.loadTransformersModule);
          return fallbackRuntime;
        } finally {
          resolutionPromise = null;
        }
      })();
    }

    return resolutionPromise;
  };

  return {
    get id(): string {
      return getVisibleSelection().id;
    },
    get modelId(): string {
      return getVisibleSelection().modelId;
    },
    get vectorDimension(): number {
      return getVisibleSelection().vectorDimension;
    },
    async prepareForSearch(): Promise<void> {
      await resolveRuntime();
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
  configuredRuntimeStatus.clear();
  customConfiguredRuntimeStatus = new WeakMap<TransformersLoader, Map<string, EmbeddingRuntimeStatus>>();
  lastObservedRuntimeStatus = null;
  clearSharedTransformersPipelineCacheForTests();
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
    const transformerSettings = resolveTransformerEmbeddingSettingsFromEnv();
    return createRuntimeSelection(
      `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${transformerSettings.transformerModelId}`,
      transformerSettings.transformerModelId,
      transformerSettings.transformerVectorDimension
    );
  }

  return createRuntimeSelection('hash-32', 'hash-32', 32);
}

export function describeEmbeddingRuntimeStatus(
  useVectorBackend: boolean,
  options: Pick<ConfiguredEmbeddingRuntimeOptions, 'preferTransformers'> = {}
): EmbeddingRuntimeStatus | undefined {
  return describeConfiguredEmbeddingRuntimeStatus({
    preferTransformers: options.preferTransformers,
    fallbackRuntime: useVectorBackend ? createHashEmbeddingRuntime(32) : createHashEmbeddingRuntime(),
  });
}

export function describeConfiguredEmbeddingRuntimeStatus(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): EmbeddingRuntimeStatus | undefined {
  const resolvedOptions = resolveConfiguredEmbeddingRuntimeOptions(options);
  const {
    preferTransformers,
    fallbackRuntime,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    loadTransformersModule,
  } = resolvedOptions;
  if (!preferTransformers) {
    return undefined;
  }
  const cacheKey = buildConfiguredRuntimeCacheKey({
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    fallbackRuntime,
  });

  const existing = getRuntimeStatusStore(loadTransformersModule).get(cacheKey);
  if (existing) {
    return cloneRuntimeStatus(existing);
  }

  const configuredSelection = createRuntimeSelection(
    `${DEFAULT_TRANSFORMER_RUNTIME_ID_PREFIX}:${transformerModelId}`,
    transformerModelId,
    transformerVectorDimension
  );
  return {
    state: 'uninitialized',
    configured: cloneRuntimeSelection(configuredSelection),
    active: cloneRuntimeSelection(configuredSelection),
    fallback: selectionFromRuntime(fallbackRuntime),
    loadFailures: 0,
  };
}

export function describeLastEmbeddingRuntimeStatus(): EmbeddingRuntimeStatus | undefined {
  if (!lastObservedRuntimeStatus) {
    return undefined;
  }

  const status = getRuntimeStatusStore(lastObservedRuntimeStatus.loadTransformersModule).get(
    lastObservedRuntimeStatus.cacheKey
  );
  if (!status || status.state === 'uninitialized') {
    return undefined;
  }
  return cloneRuntimeStatus(status);
}

export function createConfiguredEmbeddingRuntime(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): EmbeddingRuntime {
  const resolvedOptions = resolveConfiguredEmbeddingRuntimeOptions(options);
  const {
    preferTransformers,
    fallbackRuntime,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    loadTransformersModule,
  } = resolvedOptions;

  if (!preferTransformers) {
    return createTransformerFallbackRuntime(fallbackRuntime);
  }

  const cacheKey = buildConfiguredRuntimeCacheKey({
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    fallbackRuntime,
  });
  return createLazyTransformerRuntime(fallbackRuntime, {
    cacheKey,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    loadTransformersModule,
  });
}

export function getConfiguredEmbeddingRuntime(
  options: ConfiguredEmbeddingRuntimeOptions = {}
): EmbeddingRuntime {
  const resolvedOptions = resolveConfiguredEmbeddingRuntimeOptions(options);
  const {
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    loadTransformersModule,
    fallbackRuntime,
  } = resolvedOptions;
  const cache = getRuntimeCache(loadTransformersModule);
  const cacheKey = buildConfiguredRuntimeCacheKey({
    preferTransformers,
    transformerModelId,
    transformerVectorDimension,
    localModelPath,
    fallbackRuntime,
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
    localModelPath,
    loadTransformersModule,
    fallbackRuntime,
  });
  cache.set(cacheKey, runtime);
  return runtime;
}
