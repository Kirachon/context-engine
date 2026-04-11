import {
  InternalSearchResult,
  RankingGateDecision,
  RetrievalRankingMode,
} from './types.js';
import {
  RANKING_V3_WEIGHT_SNAPSHOT,
} from './rankingCalibration.js';
import { buildIdentifierPathSignals } from './searchHeuristics.js';
import {
  clearSharedTransformersPipelineCacheForTests,
  defaultLoadTransformersModule,
  getSharedFeatureExtractionPipeline,
  normalizeEmbeddingRows,
  normalizeTransformerModelId,
  type TransformersLoader,
} from './transformersShared.js';
import { featureEnabled } from '../../config/features.js';

export interface RerankOptions {
  originalQuery?: string;
  mode?: RetrievalRankingMode;
}

export interface TransformerRerankOptions extends RerankOptions {
  loadTransformersModule?: TransformersLoader;
  modelId?: string;
  gateDecision?: RankingGateDecision;
  onTrace?: (trace: TransformerRerankTrace) => void;
}

export interface TransformerRerankTrace {
  candidateCount: number;
  selectedPath: 'heuristic' | 'transformer';
  appliedPath: 'heuristic' | 'transformer';
  state: 'skipped' | 'invoked' | 'fail_open';
  fallbackReason: 'none' | 'rerank_skipped' | 'reranker_unavailable' | 'rerank_error';
  reasonCode:
    | 'single_candidate'
    | 'empty_query'
    | 'gate_skipped'
    | 'transformer_applied'
    | 'runtime_unavailable'
    | 'embedding_mismatch'
    | 'transformer_error';
  gateDecision?: RankingGateDecision;
  runtimeId?: string;
  modelId?: string;
}

interface TransformerRuntime {
  id: string;
  modelId: string;
  runtimeKind: 'embedding' | 'cross_encoder';
  scoreTexts: (texts: string[]) => Promise<number[][]>;
  scorePairs?: (query: string, texts: string[]) => Promise<number[]>;
}

const MAX_CANDIDATE_TEXT_CHARS = 1600;
const DEFAULT_CROSS_ENCODER_MODEL_ID = 'Xenova/ms-marco-MiniLM-L6-v2';

const defaultTransformerRuntimeCache = new Map<string, Promise<TransformerRuntime | null>>();
let customTransformerRuntimeCache = new WeakMap<TransformersLoader, Map<string, Promise<TransformerRuntime | null>>>();

type TextClassificationResult = { label?: string; score?: number };
type TextClassificationPipeline = (input: string | string[]) => Promise<unknown>;

function resultSignature(result: InternalSearchResult): string {
  const lines = result.lines ?? '';
  const contentSnippet = result.content.slice(0, 120).replace(/\s+/g, ' ').trim();
  return `${result.path}::${lines}::${contentSnippet}`;
}

function parseStartLine(lines?: string): number {
  if (!lines) {
    return Number.MAX_SAFE_INTEGER;
  }
  const match = lines.match(/(\d+)/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const value = Number(match[1]);
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .filter(Boolean);
}

function buildPathTokenSet(path: string): Set<string> {
  return new Set(
    path
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map(token => token.trim())
      .filter(Boolean)
  );
}

function normalizeCrossEncoderModelId(modelId: string | undefined): string {
  const trimmed = modelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CROSS_ENCODER_MODEL_ID;
}

function overlapScore(queryTokens: string[], pathTokens: Set<string>): number {
  if (queryTokens.length === 0 || pathTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of queryTokens) {
    if (pathTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.length;
}

function hasExactSymbolMatch(result: InternalSearchResult, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) {
    return false;
  }
  const haystack = `${result.path} ${result.content}`.toLowerCase();
  return queryTokens.some(token => token.length >= 3 && haystack.includes(token));
}

function pathDepth(path: string): number {
  const segments = path.split(/[\\/]+/g).filter(Boolean);
  return segments.length;
}

function exactPathTailMatch(path: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false;
  const normalizedPath = path.toLowerCase();
  return queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.ts`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.js`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.endsWith(`${token}.py`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.includes(`/${token}/`))
    || queryTokens.some((token) => token.length >= 3 && normalizedPath.includes(`\\${token}\\`));
}

function isFloat32TensorTypeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /float32 tensor/i.test(error.message) && /float32array/i.test(error.message);
}

function normalizeClassificationResults(output: unknown): TextClassificationResult[][] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output.map((entry) => {
    if (Array.isArray(entry)) {
      return entry
        .filter((item): item is TextClassificationResult => !!item && typeof item === 'object')
        .map((item) => ({
          label: typeof item.label === 'string' ? item.label : undefined,
          score: typeof item.score === 'number' ? item.score : undefined,
        }));
    }

    if (entry && typeof entry === 'object') {
      const item = entry as TextClassificationResult;
      return [{
        label: typeof item.label === 'string' ? item.label : undefined,
        score: typeof item.score === 'number' ? item.score : undefined,
      }];
    }

    return [];
  });
}

function selectClassificationScore(results: TextClassificationResult[]): number {
  if (results.length === 0) {
    return 0;
  }

  const positive = results.find((result) => /label_1|relevant|positive|true/i.test(result.label ?? ''));
  if (positive?.score !== undefined) {
    return positive.score;
  }

  return results.reduce((best, result) => {
    const score = typeof result.score === 'number' ? result.score : 0;
    return Math.max(best, score);
  }, 0);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return dot / denominator;
}

function buildCandidateText(result: InternalSearchResult): string {
  const content = result.content.slice(0, MAX_CANDIDATE_TEXT_CHARS);
  return [result.path, result.lines ?? '', content].filter(Boolean).join('\n');
}

function getTransformerRuntimeCache(loader?: TransformersLoader): Map<string, Promise<TransformerRuntime | null>> {
  if (!loader) {
    return defaultTransformerRuntimeCache;
  }

  const existing = customTransformerRuntimeCache.get(loader);
  if (existing) {
    return existing;
  }

  const created = new Map<string, Promise<TransformerRuntime | null>>();
  customTransformerRuntimeCache.set(loader, created);
  return created;
}

async function buildTransformerRuntime(
  modelId: string,
  loadTransformersModule: TransformersLoader
): Promise<TransformerRuntime> {
  const extractor = await getSharedFeatureExtractionPipeline({
    modelId,
    loadTransformersModule,
  });
  let batchExtractionSupported: boolean | null = null;
  let runtimeUsable = true;

  return {
    id: `transformers:${modelId}`,
    modelId,
    runtimeKind: 'embedding',
    async scoreTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      if (!runtimeUsable) {
        return [];
      }

      const extractEmbeddings = async (input: string[] | string): Promise<number[][]> => {
        const output = await extractor(input, {
          pooling: 'mean',
          normalize: true,
        });
        return normalizeEmbeddingRows(output);
      };

      if (texts.length === 1) {
        return extractEmbeddings(texts[0]);
      }

      if (batchExtractionSupported !== false) {
        try {
          const batchEmbeddings = await extractEmbeddings(texts);
          if (batchEmbeddings.length === texts.length && batchEmbeddings.every((row) => row.length > 0)) {
            batchExtractionSupported = true;
            return batchEmbeddings;
          }
          batchExtractionSupported = false;
        } catch (error) {
          batchExtractionSupported = false;
          if (isFloat32TensorTypeError(error)) {
            runtimeUsable = false;
            return [];
          }
          // Fall through to per-text extraction for runtimes that fail on batch tensor paths.
        }
      }

      const perTextEmbeddings: number[][] = [];
      for (const text of texts) {
        let singleEmbeddings: number[][] = [];
        try {
          singleEmbeddings = await extractEmbeddings(text);
        } catch {
          runtimeUsable = false;
          return [];
        }
        if (singleEmbeddings.length === 0) {
          return [];
        }
        perTextEmbeddings.push(singleEmbeddings[0] ?? []);
      }
      return perTextEmbeddings;
    },
  };
}

async function buildCrossEncoderRuntime(
  modelId: string,
  loadTransformersModule: TransformersLoader
): Promise<TransformerRuntime> {
  const transformers = await loadTransformersModule();
  const classifier = await transformers.pipeline('text-classification', modelId, {
    dtype: 'fp32',
  }) as TextClassificationPipeline;

  return {
    id: `cross-encoder:${modelId}`,
    modelId,
    runtimeKind: 'cross_encoder',
    async scoreTexts(): Promise<number[][]> {
      return [];
    },
    async scorePairs(query: string, texts: string[]): Promise<number[]> {
      if (texts.length === 0) {
        return [];
      }

      const outputs = await classifier(texts.map((text) => `${query} [SEP] ${text}`));
      const normalized = normalizeClassificationResults(outputs);
      return normalized.map((entry) => selectClassificationScore(entry));
    },
  };
}

async function resolveTransformerRuntime(options: TransformerRerankOptions): Promise<TransformerRuntime | null> {
  const useCrossEncoder = featureEnabled('retrieval_cross_encoder_rerank_v1');
  const modelId = useCrossEncoder
    ? normalizeCrossEncoderModelId(options.modelId)
    : normalizeTransformerModelId(options.modelId);
  const cache = getTransformerRuntimeCache(options.loadTransformersModule);
  const cacheKey = `${useCrossEncoder ? 'cross-encoder' : 'embedding'}:${modelId}`;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const loadTransformersModule = options.loadTransformersModule ?? defaultLoadTransformersModule;
  const runtimePromise = (
    useCrossEncoder
      ? buildCrossEncoderRuntime(modelId, loadTransformersModule)
      : buildTransformerRuntime(modelId, loadTransformersModule)
  ).catch(() => null);
  cache.set(cacheKey, runtimePromise);
  return runtimePromise;
}

function emitTransformerTrace(
  results: InternalSearchResult[],
  options: TransformerRerankOptions,
  trace: Omit<TransformerRerankTrace, 'candidateCount' | 'gateDecision'>
): void {
  options.onTrace?.({
    candidateCount: results.length,
    gateDecision: options.gateDecision,
    ...trace,
  });
}

export function rerankResults(
  results: InternalSearchResult[],
  options: RerankOptions = {}
): InternalSearchResult[] {
  const mode: RetrievalRankingMode = options.mode ?? 'v1';
  const stats = new Map<string, { count: number; hasOriginal: boolean }>();
  const sourceStats = new Map<string, Set<InternalSearchResult['retrievalSource']>>();
  const queryTokens = tokenize(options.originalQuery ?? '');

  for (const result of results) {
    const key = resultSignature(result);
    const entry = stats.get(key) ?? { count: 0, hasOriginal: false };
    entry.count += 1;
    if (result.variantIndex === 0) {
      entry.hasOriginal = true;
    }
    stats.set(key, entry);
    const sourceSet = sourceStats.get(key) ?? new Set<InternalSearchResult['retrievalSource']>();
    sourceSet.add(result.retrievalSource);
    sourceStats.set(key, sourceSet);
  }

  const ranked = results.map((result, index) => {
    const baseScore = result.relevanceScore ?? result.score ?? 0;
    const signature = resultSignature(result);
    const entry = stats.get(signature) ?? { count: 1, hasOriginal: false };
    const frequencyBonus = Math.log2(1 + entry.count) * RANKING_V3_WEIGHT_SNAPSHOT.frequencyBonusScale;
    const originalBonus = entry.hasOriginal ? RANKING_V3_WEIGHT_SNAPSHOT.originalBonus : 0;
    const variantWeightBonus = (result.variantWeight - 0.5) * RANKING_V3_WEIGHT_SNAPSHOT.variantWeightBonusScale;
    let combinedScore = baseScore + frequencyBonus + originalBonus + variantWeightBonus;

    if (mode === 'v2' || mode === 'v3') {
      const pathOverlap = overlapScore(queryTokens, buildPathTokenSet(result.path));
      const sourceConsensus = Math.max(0, (sourceStats.get(signature)?.size ?? 1) - 1);
      const exactSymbolBonus = hasExactSymbolMatch(result, queryTokens) ? 0.04 : 0;
      const identifierSignals = buildIdentifierPathSignals(options.originalQuery ?? '', result.path);
      const exactIdentifierBonus = identifierSignals.exactBasenameMatch
        ? RANKING_V3_WEIGHT_SNAPSHOT.v2ExactSymbolBonus
        : identifierSignals.pathTokenCoverage * (RANKING_V3_WEIGHT_SNAPSHOT.v2ExactSymbolBonus * 0.8);
      const identifierTestPenalty = (
        identifierSignals.isIdentifierQuery
        && identifierSignals.isTestPath
        && !identifierSignals.queryMentionsTest
      )
        ? RANKING_V3_WEIGHT_SNAPSHOT.v2ExactSymbolBonus * (identifierSignals.exactBasenameMatch ? 1.25 : 0.75)
        : 0;
      combinedScore +=
        (pathOverlap * RANKING_V3_WEIGHT_SNAPSHOT.v2PathOverlapScale) +
        (sourceConsensus * RANKING_V3_WEIGHT_SNAPSHOT.v2SourceConsensusScale) +
        (exactSymbolBonus ? RANKING_V3_WEIGHT_SNAPSHOT.v2ExactSymbolBonus : 0) +
        exactIdentifierBonus -
        identifierTestPenalty;
    }

    if (mode === 'v3') {
      const sourceConsensus = Math.max(0, (sourceStats.get(signature)?.size ?? 1) - 1);
      const lineStart = parseStartLine(result.lines);
      const lineProximityBonus = Number.isFinite(lineStart) && lineStart < 120
        ? RANKING_V3_WEIGHT_SNAPSHOT.v3LineProximityBonus
        : 0;
      const identifierSignals = buildIdentifierPathSignals(options.originalQuery ?? '', result.path);
      const pathSpecificityBonus = (
        exactPathTailMatch(result.path, queryTokens)
        || identifierSignals.exactBasenameMatch
      )
        ? RANKING_V3_WEIGHT_SNAPSHOT.v3PathSpecificityBonus
        : 0;
      const identifierCoverageBonus = identifierSignals.pathTokenCoverage * (RANKING_V3_WEIGHT_SNAPSHOT.v3PathSpecificityBonus * 0.5);
      const testPathPenalty = (
        identifierSignals.isIdentifierQuery
        && identifierSignals.isTestPath
        && !identifierSignals.queryMentionsTest
      )
        ? RANKING_V3_WEIGHT_SNAPSHOT.v3PathSpecificityBonus * (identifierSignals.exactBasenameMatch ? 1.5 : 0.9)
        : 0;
      const depthPenalty = Math.max(0, pathDepth(result.path) - 8) * RANKING_V3_WEIGHT_SNAPSHOT.v3DepthPenaltyPerLevel;
      combinedScore +=
        (sourceConsensus * RANKING_V3_WEIGHT_SNAPSHOT.v3SourceConsensusScale) +
        lineProximityBonus +
        identifierCoverageBonus +
        pathSpecificityBonus -
        testPathPenalty -
        depthPenalty;
    }

    return {
      result: {
        ...result,
        combinedScore,
      },
      combinedScore,
      baseScore,
      index,
    };
  });

  ranked.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) {
      return b.combinedScore - a.combinedScore;
    }
    if (b.baseScore !== a.baseScore) {
      return b.baseScore - a.baseScore;
    }
    if (a.result.path !== b.result.path) {
      return a.result.path.localeCompare(b.result.path);
    }
    const lineA = parseStartLine(a.result.lines);
    const lineB = parseStartLine(b.result.lines);
    if (lineA !== lineB) {
      return lineA - lineB;
    }
    return a.index - b.index;
  });

  return ranked.map(entry => entry.result);
}

function getHeuristicScoreMap(
  results: InternalSearchResult[],
  options: RerankOptions
): Map<string, { combinedScore: number; baseScore: number }> {
  const ranked = rerankResults(results, options);
  const scoreMap = new Map<string, { combinedScore: number; baseScore: number }>();

  for (const result of ranked) {
    const signature = resultSignature(result);
    if (!scoreMap.has(signature)) {
      scoreMap.set(signature, {
        combinedScore: result.combinedScore ?? result.relevanceScore ?? result.score ?? 0,
        baseScore: result.relevanceScore ?? result.score ?? 0,
      });
    }
  }

  return scoreMap;
}

export async function rerankCandidates(
  results: InternalSearchResult[],
  options: TransformerRerankOptions = {}
): Promise<InternalSearchResult[]> {
  if (results.length <= 1) {
    emitTransformerTrace(results, options, {
      selectedPath: 'heuristic',
      appliedPath: 'heuristic',
      state: 'skipped',
      fallbackReason: 'none',
      reasonCode: 'single_candidate',
      modelId: normalizeTransformerModelId(options.modelId),
    });
    return results;
  }

  const heuristicRanked = rerankResults(results, options);
  const query = options.originalQuery?.trim() ?? '';
  if (!query) {
    emitTransformerTrace(results, options, {
      selectedPath: 'heuristic',
      appliedPath: 'heuristic',
      state: 'skipped',
      fallbackReason: 'none',
      reasonCode: 'empty_query',
      modelId: normalizeTransformerModelId(options.modelId),
    });
    return heuristicRanked;
  }

  if (options.gateDecision && !options.gateDecision.shouldUseTransformerRerank) {
    emitTransformerTrace(results, options, {
      selectedPath: 'heuristic',
      appliedPath: 'heuristic',
      state: 'skipped',
      fallbackReason: 'rerank_skipped',
      reasonCode: 'gate_skipped',
      modelId: normalizeTransformerModelId(options.modelId),
    });
    return heuristicRanked;
  }

  const runtime = await resolveTransformerRuntime(options);
  if (!runtime) {
    emitTransformerTrace(results, options, {
      selectedPath: 'transformer',
      appliedPath: 'heuristic',
      state: 'fail_open',
      fallbackReason: 'reranker_unavailable',
      reasonCode: 'runtime_unavailable',
      modelId: normalizeTransformerModelId(options.modelId),
    });
    return heuristicRanked;
  }

  try {
    const heuristicScores = getHeuristicScoreMap(results, options);
    const candidateTexts = results.map((result) => buildCandidateText(result));
    if (runtime.runtimeKind === 'cross_encoder' && runtime.scorePairs) {
      const candidateScores = await runtime.scorePairs(query, candidateTexts);
      if (candidateScores.length !== results.length) {
        emitTransformerTrace(results, options, {
          selectedPath: 'transformer',
          appliedPath: 'heuristic',
          state: 'fail_open',
          fallbackReason: 'rerank_error',
          reasonCode: 'embedding_mismatch',
          runtimeId: runtime.id,
          modelId: runtime.modelId,
        });
        return heuristicRanked;
      }

      const scored = results.map((result, index) => {
        const crossEncoderScore = candidateScores[index] ?? 0;
        const signature = resultSignature(result);
        const heuristicScore = heuristicScores.get(signature)?.combinedScore ?? result.combinedScore ?? result.relevanceScore ?? result.score ?? 0;
        const baseScore = heuristicScores.get(signature)?.baseScore ?? result.relevanceScore ?? result.score ?? 0;

        return {
          result,
          transformerScore: crossEncoderScore,
          heuristicScore,
          baseScore,
          index,
        };
      });

      scored.sort((a, b) => {
        if (b.transformerScore !== a.transformerScore) {
          return b.transformerScore - a.transformerScore;
        }
        if (b.heuristicScore !== a.heuristicScore) {
          return b.heuristicScore - a.heuristicScore;
        }
        if (b.baseScore !== a.baseScore) {
          return b.baseScore - a.baseScore;
        }
        if (a.result.path !== b.result.path) {
          return a.result.path.localeCompare(b.result.path);
        }
        const lineA = parseStartLine(a.result.lines);
        const lineB = parseStartLine(b.result.lines);
        if (lineA !== lineB) {
          return lineA - lineB;
        }
        return a.index - b.index;
      });

      const reranked = scored.map(({ result, transformerScore }) => ({
        ...result,
        combinedScore: transformerScore,
      }));
      emitTransformerTrace(results, options, {
        selectedPath: 'transformer',
        appliedPath: 'transformer',
        state: 'invoked',
        fallbackReason: 'none',
        reasonCode: 'transformer_applied',
        runtimeId: runtime.id,
        modelId: runtime.modelId,
      });
      return reranked;
    }

    const embeddings = await runtime.scoreTexts([query, ...candidateTexts]);
    const queryVector = embeddings[0] ?? [];
    const candidateVectors = embeddings.slice(1);
    if (queryVector.length === 0 || candidateVectors.length !== results.length) {
      emitTransformerTrace(results, options, {
        selectedPath: 'transformer',
        appliedPath: 'heuristic',
        state: 'fail_open',
        fallbackReason: 'rerank_error',
        reasonCode: 'embedding_mismatch',
        runtimeId: runtime.id,
        modelId: runtime.modelId,
      });
      return heuristicRanked;
    }

    const scored = results.map((result, index) => {
      const transformerScore = cosineSimilarity(queryVector, candidateVectors[index] ?? []);
      const signature = resultSignature(result);
      const heuristicScore = heuristicScores.get(signature)?.combinedScore ?? result.combinedScore ?? result.relevanceScore ?? result.score ?? 0;
      const baseScore = heuristicScores.get(signature)?.baseScore ?? result.relevanceScore ?? result.score ?? 0;

      return {
        result,
        transformerScore,
        heuristicScore,
        baseScore,
        index,
      };
    });

    scored.sort((a, b) => {
      if (b.transformerScore !== a.transformerScore) {
        return b.transformerScore - a.transformerScore;
      }
      if (b.heuristicScore !== a.heuristicScore) {
        return b.heuristicScore - a.heuristicScore;
      }
      if (b.baseScore !== a.baseScore) {
        return b.baseScore - a.baseScore;
      }
      if (a.result.path !== b.result.path) {
        return a.result.path.localeCompare(b.result.path);
      }
      const lineA = parseStartLine(a.result.lines);
      const lineB = parseStartLine(b.result.lines);
      if (lineA !== lineB) {
        return lineA - lineB;
      }
      return a.index - b.index;
    });

    const reranked = scored.map(({ result, transformerScore }) => ({
      ...result,
      combinedScore: transformerScore,
    }));
    emitTransformerTrace(results, options, {
      selectedPath: 'transformer',
      appliedPath: 'transformer',
      state: 'invoked',
      fallbackReason: 'none',
      reasonCode: 'transformer_applied',
      runtimeId: runtime.id,
      modelId: runtime.modelId,
    });
    return reranked;
  } catch {
    emitTransformerTrace(results, options, {
      selectedPath: 'transformer',
      appliedPath: 'heuristic',
      state: 'fail_open',
      fallbackReason: 'rerank_error',
      reasonCode: 'transformer_error',
      runtimeId: runtime.id,
      modelId: runtime.modelId,
    });
    return heuristicRanked;
  }
}

export function clearRerankerRuntimeCacheForTests(): void {
  defaultTransformerRuntimeCache.clear();
  customTransformerRuntimeCache = new WeakMap<TransformersLoader, Map<string, Promise<TransformerRuntime | null>>>();
  clearSharedTransformersPipelineCacheForTests();
}
