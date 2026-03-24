import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { featureEnabled } from '../../config/features.js';
import type { SearchResult } from '../../mcp/serviceClient.js';
import {
  getPreferredWorkspacePath,
  getReadableWorkspacePath,
} from '../../runtime/compatPaths.js';
import {
  createHeuristicChunkParser,
  type ChunkParser,
  type ChunkRecord,
} from './chunking.js';
import { createTreeSitterChunkParser } from './treeSitterChunkParser.js';

const CHUNK_INDEX_FILE_NAME = '.context-engine-chunk-index.json';
const LEGACY_CHUNK_INDEX_FILE_NAME = '.augment-chunk-index.json';
const INDEX_STATE_FILE_NAME = '.context-engine-index-state.json';
const LEGACY_INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const CHUNK_INDEX_VERSION = 1;
const DEFAULT_MAX_CHUNK_LINES = 80;
const DEFAULT_MAX_CHUNK_CHARS = 4_000;
const DEFAULT_SNIPPET_WINDOW_LINES = 5;
const DEFAULT_SNIPPET_MAX_CHARS = 1_200;
const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'from',
  'that',
  'this',
  'where',
  'what',
  'when',
  'why',
  'how',
  'is',
  'are',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
]);

interface IndexStateEntry {
  hash: string;
  indexed_at?: string;
  indexedAt?: string;
}

interface IndexStateFile {
  files: Record<string, IndexStateEntry>;
}

interface ChunkIndexDocument {
  hash: string;
  indexedAt: string;
  chunks: ChunkRecord[];
}

interface ChunkIndexParserSnapshot {
  id: string;
  version: number;
}

interface ChunkIndexFile {
  version: number;
  updatedAt: string;
  workspaceFingerprint: string;
  parser: ChunkIndexParserSnapshot;
  chunking: {
    version: number;
    maxChunkLines: number;
    maxChunkChars: number;
  };
  docs: Record<string, ChunkIndexDocument>;
}

export interface WorkspaceChunkSearchIndexOptions {
  workspacePath: string;
  indexStatePath?: string;
  chunkIndexPath?: string;
  maxChunkLines?: number;
  maxChunkChars?: number;
  chunkParserFactory?: () => ChunkParser | null;
}

export interface ChunkSearchOptions {
  bypassCache?: boolean;
  includeArtifacts?: boolean;
  includeDocs?: boolean;
  includeJson?: boolean;
  queryTokens?: string[];
  symbolTokens?: string[];
  codeIntent?: boolean;
  opsEvidenceIntent?: boolean;
  normalizedQuery?: string;
}

export interface ChunkSearchRefreshStats {
  refreshedFiles: number;
  reusedFiles: number;
  removedFiles: number;
  totalFiles: number;
  totalChunks: number;
  wroteIndex: boolean;
}

export interface WorkspaceChunkSearchIndex {
  id: string;
  refresh: () => Promise<ChunkSearchRefreshStats>;
  search: (query: string, topK: number, options?: ChunkSearchOptions) => Promise<SearchResult[]>;
  getSnapshot: () => {
    version: number;
    updatedAt: string | null;
    fileCount: number;
    chunkCount: number;
    workspaceFingerprint: string;
    parser: ChunkIndexParserSnapshot;
  };
}

function clampTopK(topK: number): number {
  return Math.max(1, Math.min(50, Math.floor(topK)));
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim();
}

function buildWorkspaceFingerprint(workspacePath: string): string {
  const normalizedWorkspacePath = normalizePath(path.resolve(workspacePath));
  return crypto.createHash('sha256').update(normalizedWorkspacePath).digest('hex').slice(0, 16);
}

function resolveChunkParser(options: WorkspaceChunkSearchIndexOptions): ChunkParser {
  try {
    if (typeof options.chunkParserFactory === 'function') {
      const customParser = options.chunkParserFactory();
      if (customParser) {
        return customParser;
      }
    }
  } catch {
    // Ignore custom parser factory failures and fall back to runtime resolution.
  }

  if (featureEnabled('retrieval_tree_sitter_v1')) {
    const treeSitterParser = createTreeSitterChunkParser();
    if (treeSitterParser) {
      return treeSitterParser;
    }
  }

  return createHeuristicChunkParser();
}

function sanitizePath(relativePath: string): string | null {
  const normalized = normalizePath(relativePath);
  if (!normalized) return null;
  if (normalized.startsWith('..') || normalized.includes('/../')) return null;
  if (path.isAbsolute(normalized)) return null;
  return normalized;
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath: string, payload: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function readIndexState(filePath: string): IndexStateFile {
  const parsed = safeReadJson<Partial<IndexStateFile>>(filePath, {});
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
    return { files: {} };
  }
  return { files: parsed.files as Record<string, IndexStateEntry> };
}

function readChunkIndex(
  filePath: string,
  workspaceFingerprint: string,
  parserSnapshot: ChunkIndexParserSnapshot,
  maxChunkLines: number,
  maxChunkChars: number
): ChunkIndexFile {
  const fallback: ChunkIndexFile = {
    version: CHUNK_INDEX_VERSION,
    updatedAt: new Date(0).toISOString(),
    workspaceFingerprint,
    parser: parserSnapshot,
    chunking: {
      version: CHUNK_INDEX_VERSION,
      maxChunkLines,
      maxChunkChars,
    },
    docs: {},
  };

  const parsed = safeReadJson<Partial<ChunkIndexFile>>(filePath, fallback);
  if (!parsed || typeof parsed !== 'object') {
    return fallback;
  }

  const parsedChunking = parsed.chunking;
  if (
    !parsedChunking
    || typeof parsedChunking !== 'object'
    || parsedChunking.version !== CHUNK_INDEX_VERSION
    || parsedChunking.maxChunkLines !== maxChunkLines
    || parsedChunking.maxChunkChars !== maxChunkChars
  ) {
    return fallback;
  }

  const parsedWorkspaceFingerprint = typeof parsed.workspaceFingerprint === 'string'
    ? parsed.workspaceFingerprint
    : null;
  if (parsedWorkspaceFingerprint !== workspaceFingerprint) {
    return fallback;
  }

  const parsedParser = parsed.parser;
  if (
    !parsedParser
    || typeof parsedParser !== 'object'
    || typeof parsedParser.id !== 'string'
    || typeof parsedParser.version !== 'number'
    || parsedParser.id !== parserSnapshot.id
    || parsedParser.version !== parserSnapshot.version
  ) {
    return fallback;
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : CHUNK_INDEX_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fallback.updatedAt,
    workspaceFingerprint,
    parser: parserSnapshot,
    chunking: {
      version: CHUNK_INDEX_VERSION,
      maxChunkLines,
      maxChunkChars,
    },
    docs: parsed.docs && typeof parsed.docs === 'object'
      ? (parsed.docs as Record<string, ChunkIndexDocument>)
      : {},
  };
}

function readDocumentContent(workspacePath: string, relativePath: string): string | null {
  const sanitized = sanitizePath(relativePath);
  if (!sanitized) return null;
  const absolute = path.join(workspacePath, sanitized);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    if (stat.size > 1_000_000) return null;
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.trim()) return null;
    return content;
  } catch {
    return null;
  }
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function normalizeSearchText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let index = 0;
  while (index !== -1) {
    index = haystack.indexOf(needle, index);
    if (index !== -1) {
      count += 1;
      index += needle.length;
    }
  }
  return count;
}

function scoreSnippetLine(line: string, context: ChunkSearchContext): number {
  const normalizedLine = normalizeSearchText(line);
  if (!normalizedLine) {
    return 0;
  }

  let score = 0;
  if (context.normalizedQuery && normalizedLine.includes(context.normalizedQuery)) {
    score += 10;
  }

  for (const token of context.queryTokens) {
    if (token && normalizedLine.includes(token)) {
      score += 1.2;
    }
  }

  for (const symbol of context.symbolTokens) {
    if (symbol && normalizedLine.includes(symbol)) {
      score += 4;
    }
  }

  if (context.codeIntent) {
    if (/^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum|struct|trait|impl|def)\b/.test(line)) {
      score += 0.35;
    }
    if (/^\s*#[#\s]+\S/.test(line)) {
      score += 0.15;
    }
  }

  return score;
}

function buildChunkSnippet(chunk: ChunkRecord, context: ChunkSearchContext): {
  content: string;
  startLine: number;
  endLine: number;
} {
  const contentLines = chunk.content.split(/\r?\n/);
  if (contentLines.length === 0) {
    return {
      content: chunk.content.trimEnd(),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    };
  }

  const scoredLines = contentLines.map((line, index) => ({
    index,
    score: scoreSnippetLine(line, context),
  }));
  const bestLine = scoredLines.reduce((best, candidate) => (
    candidate.score > best.score ? candidate : best
  ), scoredLines[0]);

  const windowSize = Math.max(
    3,
    Math.min(
      DEFAULT_SNIPPET_WINDOW_LINES,
      contentLines.length
    )
  );

  let startIndex = 0;
  if (bestLine.score > 0) {
    const halfWindow = Math.floor(windowSize / 2);
    startIndex = Math.max(0, bestLine.index - halfWindow);
  }

  let endIndex = Math.min(contentLines.length - 1, startIndex + windowSize - 1);
  if (endIndex - startIndex + 1 < windowSize) {
    startIndex = Math.max(0, endIndex - windowSize + 1);
  }

  let snippetLines = contentLines.slice(startIndex, endIndex + 1);
  let snippetContent = snippetLines.join('\n').trimEnd();

  if (bestLine.score <= 0 && snippetContent.length > DEFAULT_SNIPPET_MAX_CHARS && contentLines.length > windowSize) {
    const headLines = contentLines.slice(0, windowSize);
    snippetLines = headLines;
    snippetContent = headLines.join('\n').trimEnd();
    startIndex = 0;
    endIndex = Math.min(contentLines.length - 1, windowSize - 1);
  }

  while (snippetContent.length > DEFAULT_SNIPPET_MAX_CHARS && snippetLines.length > 1) {
    if (bestLine.score > 0) {
      const bestRelative = Math.max(0, Math.min(snippetLines.length - 1, bestLine.index - startIndex));
      const canTrimStart = bestRelative > 0;
      const canTrimEnd = bestRelative < snippetLines.length - 1;
      if (canTrimEnd && (!canTrimStart || snippetLines[snippetLines.length - 1].length >= snippetLines[0].length)) {
        snippetLines = snippetLines.slice(0, -1);
        endIndex -= 1;
      } else if (canTrimStart) {
        snippetLines = snippetLines.slice(1);
        startIndex += 1;
      } else {
        break;
      }
    } else {
      snippetLines = snippetLines.slice(0, -1);
      endIndex -= 1;
    }
    snippetContent = snippetLines.join('\n').trimEnd();
  }

  if (snippetContent.trim() === '') {
    return {
      content: chunk.content.trimEnd(),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    };
  }

  return {
    content: snippetContent,
    startLine: chunk.startLine + startIndex,
    endLine: chunk.startLine + endIndex,
  };
}

type ChunkSearchContext = {
  normalizedQuery: string;
  queryTokens: string[];
  symbolTokens: string[];
  includeArtifacts: boolean;
  includeDocs: boolean;
  includeJson: boolean;
  codeIntent: boolean;
  opsEvidenceIntent: boolean;
};

function buildSearchContext(query: string, options?: ChunkSearchOptions): ChunkSearchContext {
  const normalizedQuery = normalizeSearchText(options?.normalizedQuery ?? query);
  const queryTokens = Array.from(new Set((options?.queryTokens ?? tokenize(query)).map((token) => token.trim().toLowerCase()).filter(Boolean)));
  const symbolTokens = Array.from(new Set((options?.symbolTokens ?? []).map((token) => token.trim().toLowerCase()).filter(Boolean)));

  const cleanedQuery = query.trim();
  const identifierLikeToken = cleanedQuery
    .split(/[^A-Za-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => /[A-Z_]/.test(token) || token.length >= 12);
  const inferredCodeIntent = /\b(function|class|interface|test|factory|provider|handler|module|api|implementation|code|file)\b/i.test(cleanedQuery)
    || identifierLikeToken;
  const inferredOpsEvidenceIntent = /\b(benchmark|report|receipt|metrics?|snapshot|artifact|baseline|json)\b/i.test(cleanedQuery);

  return {
    normalizedQuery,
    queryTokens,
    symbolTokens,
    includeArtifacts: options?.includeArtifacts ?? false,
    includeDocs: options?.includeDocs ?? false,
    includeJson: options?.includeJson ?? false,
    codeIntent: options?.codeIntent ?? inferredCodeIntent,
    opsEvidenceIntent: options?.opsEvidenceIntent ?? inferredOpsEvidenceIntent,
  };
}

function scoreChunk(chunk: ChunkRecord, context: ChunkSearchContext): number {
  const haystack = normalizeSearchText(`${chunk.path}\n${chunk.content}`);
  const pathHaystack = chunk.path.toLowerCase();
  const lowerPath = pathHaystack;
  const isArtifactPath = lowerPath.startsWith('artifacts/');
  const isDocsPath = /^(docs|benchmark|bench|tmp|coverage|dist|build)\//.test(lowerPath);

  if (context.codeIntent && !context.opsEvidenceIntent && !context.includeArtifacts && isArtifactPath) {
    return 0;
  }

  let score = 0;

  if (context.normalizedQuery && haystack.includes(context.normalizedQuery)) {
    score += 6;
  }

  let matchedTokens = 0;
  for (const token of context.queryTokens) {
    if (lowerPath.includes(token)) {
      score += 1.1;
      matchedTokens += 1;
    }

    const tokenHits = countOccurrences(haystack, token);
    if (tokenHits > 0) {
      score += Math.min(tokenHits, 8) * 1.2;
      matchedTokens += 1;
    }
  }

  for (const symbol of context.symbolTokens) {
    if (symbol && haystack.includes(symbol)) {
      score += 4.2;
      matchedTokens += 1;
    }
    if (symbol && lowerPath.includes(symbol)) {
      score += 2.4;
    }
  }

  if (context.queryTokens.length > 0 && matchedTokens >= context.queryTokens.length) {
    score += 1.5;
  }

  if (context.codeIntent) {
    if (!context.includeDocs && isDocsPath) {
      score -= 2.2;
    }
    if (!context.includeJson && lowerPath.endsWith('.json')) {
      score -= 1.8;
    }
    if (/\/__tests__\//.test(lowerPath)) {
      score += 0.4;
    }
    if (lowerPath.startsWith('src/') || lowerPath.startsWith('test/') || lowerPath.startsWith('tests/')) {
      score += 0.9;
    }
  }

  if (chunk.kind === 'declaration') {
    score += 0.35;
  } else if (chunk.kind === 'heading') {
    score += 0.2;
  }

  const lineLengthPenalty = Math.max(0, (chunk.endLine - chunk.startLine + 1) - 12) * 0.03;
  return Math.max(0, score - lineLengthPenalty);
}

function toSearchResult(chunk: ChunkRecord, score: number, retrievedAt: string): SearchResult {
  const normalizedScore = Math.max(0, Math.min(1, score));
  return {
    path: chunk.path,
    content: chunk.content,
    score: normalizedScore,
    relevanceScore: normalizedScore,
    lines: chunk.lines,
    matchType: 'keyword',
    retrievedAt,
    chunkId: chunk.chunkId,
  };
}

export function createWorkspaceChunkSearchIndex(
  options: WorkspaceChunkSearchIndexOptions
): WorkspaceChunkSearchIndex {
  const workspacePath = options.workspacePath;
  const indexStatePath = options.indexStatePath ?? getReadableWorkspacePath(workspacePath, {
    preferred: INDEX_STATE_FILE_NAME,
    legacy: LEGACY_INDEX_STATE_FILE_NAME,
  });
  const chunkIndexReadPath = options.chunkIndexPath ?? getReadableWorkspacePath(workspacePath, {
    preferred: CHUNK_INDEX_FILE_NAME,
    legacy: LEGACY_CHUNK_INDEX_FILE_NAME,
  });
  const chunkIndexWritePath = options.chunkIndexPath ?? getPreferredWorkspacePath(workspacePath, {
    preferred: CHUNK_INDEX_FILE_NAME,
    legacy: LEGACY_CHUNK_INDEX_FILE_NAME,
  });
  const maxChunkLines = Math.max(1, Math.min(400, options.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES));
  const maxChunkChars = Math.max(64, Math.min(50_000, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS));
  const parser = resolveChunkParser(options);
  const workspaceFingerprint = buildWorkspaceFingerprint(workspacePath);

  let currentIndex = readChunkIndex(
    chunkIndexReadPath,
    workspaceFingerprint,
    { id: parser.id, version: parser.version },
    maxChunkLines,
    maxChunkChars
  );

  const refresh = async (): Promise<ChunkSearchRefreshStats> => {
    const indexState = readIndexState(indexStatePath);
    const existingIndex = currentIndex;
    const nextDocs: Record<string, ChunkIndexDocument> = {};
    const reusedPaths = new Set<string>();
    let refreshedFiles = 0;
    let reusedFiles = 0;
    let removedFiles = 0;
    let totalChunks = 0;
    const nowIso = new Date().toISOString();
    let changed = false;

    const paths = Object.keys(indexState.files).sort((a, b) => a.localeCompare(b));

    for (const relativePath of paths) {
      const safePath = sanitizePath(relativePath);
      const stateEntry = indexState.files[relativePath];
      if (!safePath || !stateEntry || typeof stateEntry.hash !== 'string') {
        continue;
      }

      const existingDoc = existingIndex.docs[safePath];
      if (existingDoc && existingDoc.hash === stateEntry.hash) {
        nextDocs[safePath] = existingDoc;
        reusedPaths.add(safePath);
        reusedFiles += 1;
        totalChunks += existingDoc.chunks.length;
        continue;
      }

      const content = readDocumentContent(workspacePath, safePath);
      if (!content) {
        continue;
      }

      const chunks = parser.parse(content, {
        path: safePath,
        maxChunkLines,
        maxChunkChars,
      });

      nextDocs[safePath] = {
        hash: stateEntry.hash,
        indexedAt: nowIso,
        chunks,
      };
      refreshedFiles += 1;
      totalChunks += chunks.length;
      changed = true;
    }

    for (const existingPath of Object.keys(existingIndex.docs)) {
      if (reusedPaths.has(existingPath) || Object.prototype.hasOwnProperty.call(nextDocs, existingPath)) {
        continue;
      }
      removedFiles += 1;
      changed = true;
    }

    if (
      changed
      || existingIndex.version !== CHUNK_INDEX_VERSION
      || existingIndex.chunking.maxChunkLines !== maxChunkLines
      || existingIndex.chunking.maxChunkChars !== maxChunkChars
      || !fs.existsSync(chunkIndexWritePath)
    ) {
      currentIndex = {
        version: CHUNK_INDEX_VERSION,
        updatedAt: nowIso,
        workspaceFingerprint,
        parser: { id: parser.id, version: parser.version },
        chunking: {
          version: CHUNK_INDEX_VERSION,
          maxChunkLines,
          maxChunkChars,
        },
        docs: nextDocs,
      };
      safeWriteJson(chunkIndexWritePath, currentIndex);
      return {
        refreshedFiles,
        reusedFiles,
        removedFiles,
        totalFiles: paths.length,
        totalChunks,
        wroteIndex: true,
      };
    }

    currentIndex = {
      ...existingIndex,
      docs: nextDocs,
      updatedAt: existingIndex.updatedAt,
      workspaceFingerprint,
      parser: existingIndex.parser ?? { id: parser.id, version: parser.version },
    };

    return {
      refreshedFiles,
      reusedFiles,
      removedFiles,
      totalFiles: paths.length,
      totalChunks,
      wroteIndex: false,
    };
  };

  const search = async (
    query: string,
    topK: number,
    options?: ChunkSearchOptions
  ): Promise<SearchResult[]> => {
    const safeTopK = clampTopK(topK);
    if (options?.bypassCache) {
      await refresh();
    }

    if (Object.keys(currentIndex.docs).length === 0) {
      await refresh();
    }

    const searchContext = buildSearchContext(query, options);
    if (!searchContext.normalizedQuery && searchContext.queryTokens.length === 0 && searchContext.symbolTokens.length === 0) {
      return [];
    }

    const retrievedAt = currentIndex.updatedAt || new Date().toISOString();
    const scored = Object.values(currentIndex.docs)
      .flatMap((doc) => doc.chunks)
      .map((chunk) => ({
        chunk,
        rawScore: scoreChunk(chunk, searchContext),
      }))
      .filter(({ rawScore }) => rawScore > 0)
      .sort((a, b) => {
        if (b.rawScore !== a.rawScore) {
          return b.rawScore - a.rawScore;
        }
        if (a.chunk.path !== b.chunk.path) {
          return a.chunk.path.localeCompare(b.chunk.path);
        }
        return a.chunk.startLine - b.chunk.startLine;
      });

    if (scored.length === 0) {
      return [];
    }

    const maxScore = scored.reduce((max, item) => Math.max(max, item.rawScore), 0);
    return scored.slice(0, safeTopK).map(({ chunk, rawScore }) => {
      const normalizedScore = maxScore > 0 ? Math.max(0, Math.min(1, rawScore / maxScore)) : 0;
      const snippet = buildChunkSnippet(chunk, searchContext);
      return {
        ...toSearchResult(chunk, normalizedScore, retrievedAt),
        content: snippet.content,
        lines: `${snippet.startLine}-${snippet.endLine}`,
      };
    });
  };

  return {
    id: `chunk:${workspacePath}`,
    refresh,
    search,
    getSnapshot: () => ({
      version: currentIndex.version,
      updatedAt: currentIndex.updatedAt,
      fileCount: Object.keys(currentIndex.docs).length,
      chunkCount: Object.values(currentIndex.docs).reduce((sum, doc) => sum + doc.chunks.length, 0),
      workspaceFingerprint: currentIndex.workspaceFingerprint,
      parser: currentIndex.parser,
    }),
  };
}
