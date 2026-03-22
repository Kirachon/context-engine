import {
  InternalSearchResult,
  RankingGateDecision,
  RetrievalRankingMode,
} from './types.js';
import {
  RANKING_V3_WEIGHT_SNAPSHOT,
} from './rankingCalibration.js';

type TransformersModule = typeof import('@huggingface/transformers');
type TransformersLoader = () => Promise<TransformersModule>;

export interface RerankOptions {
  originalQuery?: string;
  mode?: RetrievalRankingMode;
}

export interface TransformerRerankOptions extends RerankOptions {
  loadTransformersModule?: TransformersLoader;
  modelId?: string;
  gateDecision?: RankingGateDecision;
}

interface TransformerRuntime {
  id: string;
  modelId: string;
  scoreTexts: (texts: string[]) => Promise<number[][]>;
}

const DEFAULT_TRANSFORMER_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MAX_CANDIDATE_TEXT_CHARS = 1600;

const defaultTransformerRuntimeCache = new Map<string, Promise<TransformerRuntime | null>>();
let customTransformerRuntimeCache = new WeakMap<TransformersLoader, Map<string, Promise<TransformerRuntime | null>>>();

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

function normalizeModelId(modelId: string | undefined): string {
  const trimmed = modelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TRANSFORMER_MODEL_ID;
}

function isFloat32TensorTypeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /float32 tensor/i.test(error.message) && /float32array/i.test(error.message);
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
  const transformers = await loadTransformersModule();
  const extractor = await transformers.pipeline('feature-extraction', modelId, {
    dtype: 'fp32',
  });
  let batchExtractionSupported: boolean | null = null;
  let runtimeUsable = true;

  return {
    id: `transformers:${modelId}`,
    modelId,
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

async function resolveTransformerRuntime(options: TransformerRerankOptions): Promise<TransformerRuntime | null> {
  const modelId = normalizeModelId(options.modelId);
  const cache = getTransformerRuntimeCache(options.loadTransformersModule);
  const cacheKey = modelId;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const loadTransformersModule = options.loadTransformersModule ?? (async () => import('@huggingface/transformers'));
  const runtimePromise = buildTransformerRuntime(modelId, loadTransformersModule).catch(() => null);
  cache.set(cacheKey, runtimePromise);
  return runtimePromise;
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
      combinedScore +=
        (pathOverlap * RANKING_V3_WEIGHT_SNAPSHOT.v2PathOverlapScale) +
        (sourceConsensus * RANKING_V3_WEIGHT_SNAPSHOT.v2SourceConsensusScale) +
        (exactSymbolBonus ? RANKING_V3_WEIGHT_SNAPSHOT.v2ExactSymbolBonus : 0);
    }

    if (mode === 'v3') {
      const sourceConsensus = Math.max(0, (sourceStats.get(signature)?.size ?? 1) - 1);
      const lineStart = parseStartLine(result.lines);
      const lineProximityBonus = Number.isFinite(lineStart) && lineStart < 120
        ? RANKING_V3_WEIGHT_SNAPSHOT.v3LineProximityBonus
        : 0;
      const pathSpecificityBonus = exactPathTailMatch(result.path, queryTokens)
        ? RANKING_V3_WEIGHT_SNAPSHOT.v3PathSpecificityBonus
        : 0;
      const depthPenalty = Math.max(0, pathDepth(result.path) - 8) * RANKING_V3_WEIGHT_SNAPSHOT.v3DepthPenaltyPerLevel;
      combinedScore +=
        (sourceConsensus * RANKING_V3_WEIGHT_SNAPSHOT.v3SourceConsensusScale) +
        lineProximityBonus +
        pathSpecificityBonus -
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
    return results;
  }

  const heuristicRanked = rerankResults(results, options);
  const query = options.originalQuery?.trim() ?? '';
  if (!query) {
    return heuristicRanked;
  }

  if (options.gateDecision && !options.gateDecision.shouldUseTransformerRerank) {
    return heuristicRanked;
  }

  const runtime = await resolveTransformerRuntime(options);
  if (!runtime) {
    return heuristicRanked;
  }

  try {
    const heuristicScores = getHeuristicScoreMap(results, options);
    const candidateTexts = results.map((result) => buildCandidateText(result));
    const embeddings = await runtime.scoreTexts([query, ...candidateTexts]);
    const queryVector = embeddings[0] ?? [];
    const candidateVectors = embeddings.slice(1);
    if (queryVector.length === 0 || candidateVectors.length !== results.length) {
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

    return scored.map(({ result, transformerScore }) => ({
      ...result,
      combinedScore: transformerScore,
    }));
  } catch {
    return heuristicRanked;
  }
}

export function clearRerankerRuntimeCacheForTests(): void {
  defaultTransformerRuntimeCache.clear();
  customTransformerRuntimeCache = new WeakMap<TransformersLoader, Map<string, Promise<TransformerRuntime | null>>>();
}
