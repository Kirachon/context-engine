import type { ContextBundle, ContextOptions, ContextServiceClient, SearchResult } from '../../mcp/serviceClient.js';
import { getInternalCache } from './performance.js';

export async function internalContextBundle(
  query: string,
  serviceClient: ContextServiceClient,
  options: ContextOptions
): Promise<ContextBundle> {
  const cache = getInternalCache();
  const cacheKey = `context:${query}:${JSON.stringify(options ?? {})}`;
  const cached = cache.get<ContextBundle>(cacheKey);
  if (cached) {
    return cached;
  }

  const bundle = await serviceClient.getContextForPrompt(query, options);
  cache.set(cacheKey, bundle);
  return bundle;
}

export function internalContextSnippet(
  results: SearchResult[],
  maxFiles: number,
  maxChars: number
): string | null {
  if (!results.length || maxFiles < 1 || maxChars < 1) {
    return null;
  }

  const fileMap = new Map<string, SearchResult>();
  for (const result of results) {
    if (!fileMap.has(result.path)) {
      fileMap.set(result.path, result);
      continue;
    }

    const existing = fileMap.get(result.path)!;
    const existingScore = existing.relevanceScore ?? 0;
    const currentScore = result.relevanceScore ?? 0;
    if (currentScore > existingScore) {
      fileMap.set(result.path, result);
    }
  }

  const entries = Array.from(fileMap.entries()).slice(0, maxFiles);
  const lines: string[] = [];
  let remaining = maxChars;

  for (const [filePath, result] of entries) {
    const header = `File: ${filePath}\n`;
    const snippet = result.content.length > 300
      ? `${result.content.slice(0, 300)}...`
      : result.content;
    const entry = `${header}${snippet}\n`;

    if (entry.length > remaining) {
      break;
    }
    lines.push(entry);
    remaining -= entry.length;
  }

  if (!lines.length) {
    return null;
  }

  return lines.join('\n');
}
