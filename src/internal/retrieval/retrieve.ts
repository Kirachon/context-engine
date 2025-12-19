import { ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { expandQuery } from './expandQuery.js';
import { dedupeResults } from './dedupe.js';
import { rerankResults } from './rerank.js';
import { ExpandedQuery, InternalSearchResult, RetrievalOptions } from './types.js';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disable', 'disabled']);

export function isRetrievalPipelineEnabled(): boolean {
  const raw = process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE;
  if (!raw) {
    return true;
  }
  return !DISABLED_VALUES.has(raw.toLowerCase());
}

function normalizeOptions(options: RetrievalOptions | undefined): Required<RetrievalOptions> {
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
    enableRerank: options?.enableRerank ?? true,
    log: options?.log ?? false,
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

function buildExpandedQueries(query: string, options: Required<RetrievalOptions>): ExpandedQuery[] {
  if (!options.enableExpansion) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  const expanded = expandQuery(query, options.maxVariants);
  if (expanded.length === 0) {
    return [{ query, source: 'original', weight: 1, index: 0 }];
  }

  return expanded;
}

export async function retrieve(
  query: string,
  serviceClient: ContextServiceClient,
  options?: RetrievalOptions
): Promise<SearchResult[]> {
  const settings = normalizeOptions(options);

  if (!isRetrievalPipelineEnabled()) {
    return serviceClient.semanticSearch(query, settings.topK);
  }

  const expandedQueries = buildExpandedQueries(query, settings);
  const allResults: InternalSearchResult[] = [];

  for (const variant of expandedQueries) {
    try {
      const results = await withTimeout(
        serviceClient.semanticSearch(variant.query, settings.perQueryTopK),
        settings.timeoutMs,
        []
      );

      for (const result of results) {
        allResults.push({
          ...result,
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
  }

  if (allResults.length === 0) {
    return [];
  }

  let processed: InternalSearchResult[] = allResults;

  if (settings.enableDedupe) {
    processed = dedupeResults(processed);
  }

  if (settings.enableRerank) {
    processed = rerankResults(processed, { originalQuery: query });
  }

  return processed.slice(0, settings.topK);
}
