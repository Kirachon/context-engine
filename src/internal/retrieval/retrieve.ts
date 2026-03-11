import { ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { expandQuery } from './expandQuery.js';
import { dedupeResults } from './dedupe.js';
import { scoreDenseCandidates } from './dense.js';
import { createWorkspaceDenseRetriever } from './denseIndex.js';
import { createHashEmbeddingProvider } from './embeddingProvider.js';
import { fuseCandidates } from './fusion.js';
import { scoreLexicalCandidates } from './lexical.js';
import { rerankResults } from './rerank.js';
import { ExpandedQuery, InternalSearchResult, RetrievalOptions } from './types.js';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disable', 'disabled']);

type NormalizedRetrievalOptions =
  Omit<Required<RetrievalOptions>, 'bypassCache' | 'maxOutputLength' | 'denseProvider'> & {
    bypassCache: boolean;
    maxOutputLength?: number;
    denseProvider?: RetrievalOptions['denseProvider'];
  };

export function isRetrievalPipelineEnabled(): boolean {
  if (featureEnabled('rollout_kill_switch')) {
    return false;
  }

  const raw = process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE;
  if (!raw) {
    return true;
  }
  return !DISABLED_VALUES.has(raw.toLowerCase());
}

function normalizeOptions(options: RetrievalOptions | undefined): NormalizedRetrievalOptions {
  const topK = Math.max(1, Math.min(50, options?.topK ?? 10));
  const perQueryTopK = Math.max(1, Math.min(50, options?.perQueryTopK ?? topK));
  const maxVariants = Math.max(1, Math.min(6, options?.maxVariants ?? 4));
  const envTimeoutRaw = process.env.CONTEXT_ENGINE_RETRIEVAL_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw ? Number(envTimeoutRaw) : undefined;
  const timeoutMs = Math.max(
    0,
    Math.min(10000, options?.timeoutMs ?? envTimeout ?? 0)
  );

  return {
    topK,
    perQueryTopK,
    maxVariants,
    timeoutMs,
    enableExpansion: options?.enableExpansion ?? true,
    enableDedupe: options?.enableDedupe ?? true,
    enableLexical: options?.enableLexical ?? true,
    enableDense: options?.enableDense ?? false,
    enableFusion: options?.enableFusion ?? true,
    enableRerank: options?.enableRerank ?? true,
    semanticWeight: Math.max(0, Math.min(1, options?.semanticWeight ?? 0.7)),
    lexicalWeight: Math.max(0, Math.min(1, options?.lexicalWeight ?? 0.3)),
    denseWeight: Math.max(0, Math.min(1, options?.denseWeight ?? 0)),
    denseProvider: options?.denseProvider,
    log: options?.log ?? false,
    bypassCache: options?.bypassCache ?? false,
    maxOutputLength: options?.maxOutputLength,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (!timeoutMs) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise<T>(resolve => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
}

function buildExpandedQueries(query: string, options: NormalizedRetrievalOptions): ExpandedQuery[] {
  if (!options.enableExpansion) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  const expanded = expandQuery(query, options.maxVariants);
  if (expanded.length === 0) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  return expanded;
}

function resolveDenseProvider(
  settings: NormalizedRetrievalOptions,
  serviceClient: ContextServiceClient
): RetrievalOptions['denseProvider'] | undefined {
  if (!settings.enableDense) return undefined;
  if (settings.denseProvider) return settings.denseProvider;

  const workspacePath = typeof (serviceClient as unknown as { workspacePath?: unknown }).workspacePath === 'string'
    ? ((serviceClient as unknown as { workspacePath: string }).workspacePath)
    : process.cwd();

  return createWorkspaceDenseRetriever({
    workspacePath,
    embeddingProvider: createHashEmbeddingProvider(),
  });
}

export async function retrieve(
  query: string,
  serviceClient: ContextServiceClient,
  options?: RetrievalOptions
): Promise<SearchResult[]> {
  const settings = normalizeOptions(options);
  const semanticSearchOptions =
    settings.bypassCache || settings.maxOutputLength !== undefined
      ? { bypassCache: settings.bypassCache, maxOutputLength: settings.maxOutputLength }
      : undefined;
  const semanticSearch = (q: string, k: number) =>
    semanticSearchOptions
      ? serviceClient.semanticSearch(q, k, semanticSearchOptions)
      : serviceClient.semanticSearch(q, k);

  if (!isRetrievalPipelineEnabled()) {
    return semanticSearch(query, settings.topK);
  }

  const expandedQueries = buildExpandedQueries(query, settings);
  const semanticCandidates: InternalSearchResult[] = [];
  const lexicalCandidates: InternalSearchResult[] = [];
  const denseCandidates: InternalSearchResult[] = [];
  const denseProvider = resolveDenseProvider(settings, serviceClient);
  const localKeywordSearch = (serviceClient as ContextServiceClient & {
    localKeywordSearch?: (input: string, topK: number) => Promise<SearchResult[]>;
  }).localKeywordSearch;

  for (const variant of expandedQueries) {
    try {
      const results = await withTimeout(
        semanticSearch(variant.query, settings.perQueryTopK),
        settings.timeoutMs,
        []
      );

      for (const result of results) {
        const semanticScore = result.relevanceScore ?? result.score ?? 0;
        semanticCandidates.push({
          ...result,
          retrievalSource: 'semantic',
          semanticScore,
          combinedScore: semanticScore,
          queryVariant: variant.query,
          variantIndex: variant.index,
          variantWeight: variant.weight,
        });
      }
    } catch (error) {
      if (settings.log) {
        console.error(`[retrieve] Failed variant \"${variant.query}\":`, error);
      }
    }

    if (settings.enableLexical && typeof localKeywordSearch === 'function') {
      try {
        const lexicalResults = await withTimeout(
          localKeywordSearch(variant.query, settings.perQueryTopK),
          settings.timeoutMs,
          []
        );
        lexicalCandidates.push(...scoreLexicalCandidates(lexicalResults, {
          query,
          queryVariant: variant.query,
          variantIndex: variant.index,
          variantWeight: variant.weight,
        }));
      } catch (error) {
        if (settings.log) {
          console.error(`[retrieve] Lexical retrieval failed for variant \"${variant.query}\":`, error);
        }
      }
    }

    if (settings.enableDense && denseProvider) {
      try {
        const denseResults = await withTimeout(
          denseProvider.search(variant.query, settings.perQueryTopK),
          settings.timeoutMs,
          []
        );
        denseCandidates.push(...scoreDenseCandidates(denseResults, {
          queryVariant: variant.query,
          variantIndex: variant.index,
          variantWeight: variant.weight,
        }));
      } catch (error) {
        if (settings.log) {
          console.error(`[retrieve] Dense retrieval failed for variant \"${variant.query}\":`, error);
        }
      }
    }
  }

  if (semanticCandidates.length === 0 && lexicalCandidates.length === 0 && denseCandidates.length === 0) {
    return [];
  }

  let processed: InternalSearchResult[] = [...semanticCandidates, ...lexicalCandidates, ...denseCandidates];

  if (settings.enableDedupe) {
    // Keep cross-source signals for fusion by deduping inside each source first.
    const dedupedSemantic = dedupeResults(
      processed.filter((candidate) => candidate.retrievalSource === 'semantic' || candidate.retrievalSource === 'hybrid')
    );
    const dedupedLexical = dedupeResults(
      processed.filter((candidate) => candidate.retrievalSource === 'lexical')
    );
    const dedupedDense = dedupeResults(
      processed.filter((candidate) => candidate.retrievalSource === 'dense')
    );
    processed = [...dedupedSemantic, ...dedupedLexical, ...dedupedDense];
  }

  if (settings.enableFusion) {
    processed = fuseCandidates(processed, {
      semanticWeight: settings.semanticWeight,
      lexicalWeight: settings.lexicalWeight,
      denseWeight: settings.denseWeight,
    });
  }

  if (settings.enableRerank) {
    processed = rerankResults(processed, { originalQuery: query });
  }

  return processed.slice(0, settings.topK);
}
