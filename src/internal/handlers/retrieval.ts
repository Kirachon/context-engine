import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { featureEnabled } from '../../config/features.js';
import { retrieve } from '../retrieval/retrieve.js';
import type { InternalRetrieveOptions, InternalRetrieveResult } from './types.js';
import { getInternalCache } from './performance.js';

const RETRIEVE_CACHE_KEY_VERSION = 'v2';

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => stableValue(item));
  }
  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const output: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      output[key] = stableValue(value);
    }
    return output;
  }
  return input;
}

function buildRetrieveCacheKey(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): string {
  const stableOptions = stableValue(options ?? {});
  const workspaceScope =
    typeof (serviceClient as { getWorkspacePath?: unknown }).getWorkspacePath === 'function'
      ? (serviceClient as { getWorkspacePath: () => string }).getWorkspacePath()
      : 'unknown-workspace';
  return `retrieve:${RETRIEVE_CACHE_KEY_VERSION}:${workspaceScope}:${query}:${JSON.stringify(stableOptions)}`;
}

type RetrievalSignals = {
  queryMode: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents: Array<'semantic' | 'keyword' | 'dense'>;
};

function summarizeSignals(results: Array<{ matchType?: string; retrievalSource?: string }>): RetrievalSignals {
  const components = new Set<'semantic' | 'keyword' | 'dense'>();
  for (const result of results) {
    const source = (result.retrievalSource ?? result.matchType ?? '').toLowerCase();
    if (source === 'hybrid') {
      components.add('semantic');
      components.add('keyword');
      continue;
    }
    if (source === 'semantic') components.add('semantic');
    if (source === 'keyword' || source === 'lexical') components.add('keyword');
    if (source === 'dense') components.add('dense');
  }
  if (components.size === 0) {
    components.add('semantic');
  }
  const queryMode: RetrievalSignals['queryMode'] =
    components.has('semantic') && (components.has('keyword') || components.has('dense'))
      ? 'hybrid'
      : components.has('keyword')
        ? 'keyword'
        : 'semantic';
  return { queryMode, hybridComponents: Array.from(components.values()) };
}

function shouldTriggerQualityGuardFallback(
  results: Array<{ relevanceScore?: number; score?: number }>
): boolean {
  if (results.length === 0) {
    return true;
  }
  const top = results.slice(0, Math.min(3, results.length));
  const avgTopScore = top.reduce((sum, item) => sum + (item.relevanceScore ?? item.score ?? 0), 0) / top.length;
  return avgTopScore < 0.2;
}

function mergeUniqueResults<
  T extends { path: string; lines?: string; relevanceScore?: number; score?: number }
>(primary: T[], fallback: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of [...primary, ...fallback]) {
    const key = `${item.path}:${item.lines ?? ''}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    const currentScore = current.relevanceScore ?? current.score ?? 0;
    const nextScore = item.relevanceScore ?? item.score ?? 0;
    if (nextScore > currentScore) {
      merged.set(key, item);
    }
  }
  return Array.from(merged.values());
}

function sortByScoreDesc<T extends { relevanceScore?: number; score?: number }>(results: T[]): T[] {
  return [...results].sort(
    (a, b) => (b.relevanceScore ?? b.score ?? 0) - (a.relevanceScore ?? a.score ?? 0)
  );
}

export async function internalRetrieveCode(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): Promise<InternalRetrieveResult> {
  const qualityGuardEnabled = featureEnabled('retrieval_quality_guard_v1');

  const resolveResultWithOptionalFallback = async (): Promise<InternalRetrieveResult> => {
    const start = Date.now();
    let results = await retrieve(query, serviceClient, options);
    let fallbackState: InternalRetrieveResult['fallbackState'] = 'inactive';

    if (qualityGuardEnabled && shouldTriggerQualityGuardFallback(results)) {
      try {
        const fallbackResults = options?.bypassCache
          ? await serviceClient.semanticSearch(query, options?.topK ?? 10, { bypassCache: true })
          : await serviceClient.semanticSearch(query, options?.topK ?? 10);
        results = sortByScoreDesc(mergeUniqueResults(results, fallbackResults)).slice(
          0,
          options?.topK ?? 10
        );
        fallbackState = 'active';
      } catch {
        // Fail open: keep original retrieval output.
      }
    }

    const signals = summarizeSignals(results as Array<{ matchType?: string; retrievalSource?: string }>);
    return {
      query,
      elapsedMs: Date.now() - start,
      results,
      queryMode: signals.queryMode,
      hybridComponents: signals.hybridComponents,
      qualityGuardState: qualityGuardEnabled ? 'enabled' : 'disabled',
      fallbackState,
    };
  };

  if (options?.bypassCache) {
    return resolveResultWithOptionalFallback();
  }

  const cache = getInternalCache();
  const cacheKey = buildRetrieveCacheKey(query, serviceClient, options);
  const cached = cache.get<InternalRetrieveResult>(cacheKey);
  if (cached) {
    return cached;
  }

  const output = await resolveResultWithOptionalFallback();
  cache.set(cacheKey, output);
  return output;
}
