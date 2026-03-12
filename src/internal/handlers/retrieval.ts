import type { ContextServiceClient } from '../../mcp/serviceClient.js';
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

export async function internalRetrieveCode(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): Promise<InternalRetrieveResult> {
  if (options?.bypassCache) {
    const start = Date.now();
    const results = await retrieve(query, serviceClient, options);
    return {
      query,
      elapsedMs: Date.now() - start,
      results,
    };
  }

  const cache = getInternalCache();
  const cacheKey = buildRetrieveCacheKey(query, serviceClient, options);
  const cached = cache.get<InternalRetrieveResult>(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const results = await retrieve(query, serviceClient, options);
  const output = {
    query,
    elapsedMs: Date.now() - start,
    results,
  };
  cache.set(cacheKey, output);
  return output;
}
