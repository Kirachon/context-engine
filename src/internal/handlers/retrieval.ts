import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import { retrieve } from '../retrieval/retrieve.js';
import type { InternalRetrieveOptions, InternalRetrieveResult } from './types.js';
import { getInternalCache } from './performance.js';

export async function internalRetrieveCode(
  query: string,
  serviceClient: ContextServiceClient,
  options?: InternalRetrieveOptions
): Promise<InternalRetrieveResult> {
  const cache = getInternalCache();
  const cacheKey = `retrieve:${query}:${JSON.stringify(options ?? {})}`;
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
