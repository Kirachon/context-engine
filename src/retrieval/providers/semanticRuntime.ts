import * as path from 'node:path';
import type { SearchResult } from '../../mcp/serviceClient.js';
import { isOperationalDocsQuery } from './queryHeuristics.js';

export interface SemanticSearchOptions {
  maxOutputLength?: number;
  timeoutMs?: number;
  parallelFallback?: boolean;
}

export interface SemanticSearchRuntimeDependencies {
  searchAndAsk: (
    searchQuery: string,
    prompt: string,
    options?: { timeoutMs?: number }
  ) => Promise<string>;
  keywordFallbackSearch: (query: string, topK: number) => Promise<SearchResult[]>;
}

export async function searchWithSemanticRuntime(
  query: string,
  topK: number,
  options: SemanticSearchOptions | undefined,
  dependencies: SemanticSearchRuntimeDependencies
): Promise<SearchResult[]> {
  const compatEmptyArrayFallbackEnabled = process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK === 'true';
  const normalizedQuery = query.trim();
  const queryTokens = normalizedQuery
    .split(/[^a-z0-9_./-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
  const hasStrongIdentifierToken = queryTokens.some((token) => token.length >= 12);
  const isSingleTokenQuery = queryTokens.length === 1;
  const useParallelFallback = options?.parallelFallback === true;
  let fallbackPromise: Promise<SearchResult[]> | null = useParallelFallback
    ? dependencies.keywordFallbackSearch(query, topK).catch(() => [])
    : null;
  const resolveFallback = () =>
    fallbackPromise ?? dependencies.keywordFallbackSearch(query, topK);

  // Fast path: operational and setup-style questions usually do not need the
  // expensive provider round-trip when a local keyword search already finds
  // good docs or setup instructions.
  if (isOperationalDocsQuery(normalizedQuery)) {
    const keywordResults = await resolveFallback();
    if (keywordResults.length > 0) {
      return keywordResults;
    }
    fallbackPromise = null;
  }

  const prompt = buildSemanticSearchPrompt(query, topK, options);
  let rawResponse: string;
  try {
    rawResponse = await dependencies.searchAndAsk(query, prompt, {
      timeoutMs: options?.timeoutMs,
    });
  } catch (error) {
    if (fallbackPromise) {
      const fallback = await fallbackPromise;
      if (fallback.length > 0) {
        return fallback;
      }
    }
    throw error;
  }
  const parseResult = parseAIProviderSearchResults(rawResponse, topK);
  if (parseResult !== null) {
    if (parseResult.length > 0) {
      return parseResult;
    }
    if (compatEmptyArrayFallbackEnabled) {
      return resolveFallback();
    }
    return [];
  }

  const formattedResults = parseFormattedResults(rawResponse, topK);
  if (formattedResults.length > 0) {
    return formattedResults;
  }

  if ((rawResponse && rawResponse.trim() !== '') || isSingleTokenQuery || hasStrongIdentifierToken) {
    return resolveFallback();
  }

  return [];
}

export function parseAIProviderSearchResults(raw: string, topK: number): SearchResult[] | null {
  const timestamp = new Date().toISOString();
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.trim() === '') {
    return null;
  }

  const normalized = raw
    .trim()
    .replace(/\\`/g, '`');
  const candidates: string[] = [];
  const fenceMatches = normalized.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of fenceMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }

  let sawExplicitEmptyArray = false;
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith('[') || !candidate.endsWith(']')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    if (parsed.length === 0) {
      sawExplicitEmptyArray = true;
      continue;
    }

    const results: SearchResult[] = [];
    for (let i = 0; i < parsed.length && results.length < topK; i += 1) {
      const item = parsed[i] as Record<string, unknown>;
      if (!item || typeof item !== 'object') continue;

      let rawPath = '';
      if (typeof item.path === 'string') {
        rawPath = item.path;
      } else if (typeof item.file === 'string') {
        rawPath = item.file;
      } else if (typeof item.file_path === 'string') {
        rawPath = item.file_path;
      }

      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!rawPath || !content) continue;

      const sanitizedPath = sanitizeResultPath(rawPath);
      if (!sanitizedPath) continue;

      const rawScore = typeof item.relevanceScore === 'number'
        ? item.relevanceScore
        : typeof item.score === 'number'
          ? item.score
          : 0;

      const result: SearchResult = {
        path: sanitizedPath,
        content,
        lines: typeof item.lines === 'string' && item.lines.trim() ? item.lines.trim() : undefined,
        relevanceScore: Number.isFinite(rawScore)
          ? Math.max(0, Math.min(1, rawScore))
          : undefined,
        matchType: typeof item.matchType === 'string' && (item.matchType === 'keyword' || item.matchType === 'hybrid' || item.matchType === 'semantic')
          ? item.matchType
          : 'semantic',
        retrievedAt: typeof item.retrievedAt === 'string' && item.retrievedAt.trim() ? item.retrievedAt.trim() : timestamp,
      };

      results.push(result);
    }

    if (results.length > 0) {
      return results;
    }
  }

  if (sawExplicitEmptyArray) {
    return [];
  }

  return null;
}

export function buildSemanticSearchPrompt(
  query: string,
  topK: number,
  options?: SemanticSearchOptions
): string {
  const maxOutputLength = options?.maxOutputLength ?? topK * 2000;

  return [
    'You are a strict JSON-only retriever for the Context Engine.',
    `Query: ${query}`,
    `Return up to ${topK} results as a JSON array only. Do not include markdown, prose, or code fences.`,
    'Use this exact schema for every entry:',
    '{ "path": "relative/path.ts", "content": "snippet", "lines": "12-20", "relevanceScore": 0.83, "matchType": "semantic", "retrievedAt": "2026-..." }',
    `Limit content output so total response stays around ${Math.max(500, Math.min(4000, maxOutputLength))} characters.`,
    'Only include files that are likely relevant to the query.',
    'Prefer short snippets that include context around the match.',
    'If no matches are found, return [] exactly.',
  ].join('\n');
}

export function sanitizeResultPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return null;
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('..' + path.posix.sep)) return null;

  return normalized;
}

export function parseFormattedResults(formattedResults: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];

  if (!formattedResults || formattedResults.trim() === '') {
    return results;
  }

  const retrievedAt = new Date().toISOString();

  const hasPathPrefix = /^Path:\s*/m.test(formattedResults);
  const blockSplitter = hasPathPrefix ? /(?=^Path:\s*)/m : /(?=^##\s+)/m;
  const pathBlocks = formattedResults.split(blockSplitter).filter(block => block.trim());

  for (const block of pathBlocks) {
    if (results.length >= topK) break;

    let filePath: string | null = null;
    let content = '';
    let lineRange: string | undefined;

    if (hasPathPrefix) {
      const pathMatch = block.match(/^Path:\s*(.+?)(?:\s*\n|$)/m);
      if (!pathMatch) continue;

      filePath = pathMatch[1].trim();

      const contentStart = block.indexOf('\n');
      if (contentStart === -1) continue;

      content = block.substring(contentStart + 1).trim();
    } else {
      const headingMatch = block.match(/^##\s+(.+?)(?:\s*$|\n)/m);
      if (!headingMatch) continue;
      filePath = headingMatch[1].trim();

      const linesMatch = block.match(/^Lines?\s+([0-9]+(?:-[0-9]+)?)/mi);
      if (linesMatch) {
        lineRange = linesMatch[1];
      }

      const fenceMatch = block.match(/```[a-zA-Z]*\n?([\s\S]*?)```/m);
      if (fenceMatch && fenceMatch[1]) {
        content = fenceMatch[1].trim();
      } else {
        const blankIndex = block.indexOf('\n\n');
        content = blankIndex !== -1
          ? block.substring(blankIndex).trim()
          : block.substring(block.indexOf('\n') + 1).trim();
      }
    }

    content = content.replace(/^\.\.\.\s*$/gm, '').trim();

    const lines: number[] = [];
    const cleanedLines = content.split('\n').map(line => {
      const lineNumMatch = line.match(/^\s*(\d+)\s{2}(.*)$/);
      if (lineNumMatch) {
        lines.push(parseInt(lineNumMatch[1], 10));
        return lineNumMatch[2];
      }
      return line;
    });

    content = cleanedLines.join('\n').trim();
    if (!content || !filePath) continue;

    const sanitizedPath = sanitizeResultPath(filePath);
    if (!sanitizedPath) continue;

    if (!lineRange) {
      lineRange = lines.length > 0
        ? `${Math.min(...lines)}-${Math.max(...lines)}`
        : undefined;
    }

    results.push({
      path: sanitizedPath,
      content,
      lines: lineRange,
      relevanceScore: 1 - (results.length / topK),
      matchType: 'semantic',
      retrievedAt,
    });
  }

  return results;
}
