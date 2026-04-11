import * as fs from 'fs';
import * as path from 'path';
import type { SearchResult } from '../../mcp/serviceClient.js';
import { envInt } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import {
  getPreferredWorkspacePath,
  getReadableWorkspacePath,
} from '../../runtime/compatPaths.js';
import {
  createEmbeddingReuseLookup,
  getInternalEmbeddingReuse,
  getReusableEmbeddingVector,
  hashEmbeddingReuseContent,
  normalizeEmbeddingVector,
  setReusableEmbeddingVector,
  type InternalEmbeddingReuse,
} from '../handlers/performance.js';
import type { DenseRetriever } from './embeddingProvider.js';
import type { EmbeddingRuntime } from './embeddingRuntime.js';

const DENSE_INDEX_FILE_NAME = '.context-engine-dense-index.json';
const LEGACY_DENSE_INDEX_FILE_NAME = '.augment-dense-index.json';
const INDEX_STATE_FILE_NAME = '.context-engine-index-state.json';
const LEGACY_INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const INDEX_VERSION = 1;
const DEFAULT_DENSE_REFRESH_MAX_DOCS = 500;
const DEFAULT_DENSE_EMBED_BATCH_SIZE = 64;
const DEFAULT_DENSE_INDEX_MAX_LOAD_BYTES = 32 * 1024 * 1024;

interface DenseIndexEntry {
  path: string;
  hash: string;
  content: string;
  lines?: string;
  embedding: number[];
  indexed_at: string;
}

interface DenseIndexFile {
  version: number;
  embedding_provider: string;
  embedding_model_id: string;
  vector_dimension: number;
  updated_at: string;
  docs: Record<string, DenseIndexEntry>;
}

interface IndexStateFileEntry {
  hash: string;
  indexed_at: string;
}

interface IndexStateFile {
  files: Record<string, IndexStateFileEntry>;
}

export interface WorkspaceDenseRetrieverOptions {
  workspacePath: string;
  embeddingRuntime: EmbeddingRuntime;
  denseIndexPath?: string;
  indexStatePath?: string;
}

function clampTopK(topK: number): number {
  return Math.max(1, Math.min(50, Math.floor(topK)));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function safeReadJson<T>(filePath: string, fallback: T, maxLoadBytes?: number): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return fallback;
    if (typeof maxLoadBytes === 'number' && maxLoadBytes > 0 && stat.size > maxLoadBytes) {
      return fallback;
    }
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
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failures
    }
  }
}

function readIndexState(filePath: string): IndexStateFile {
  const parsed = safeReadJson<Partial<IndexStateFile>>(filePath, {});
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
    return { files: {} };
  }
  return { files: parsed.files as Record<string, IndexStateFileEntry> };
}

function getDenseIndexMaxLoadBytes(): number {
  return envInt(
    'CE_DENSE_INDEX_MAX_LOAD_BYTES',
    DEFAULT_DENSE_INDEX_MAX_LOAD_BYTES,
    { min: 1_024, max: 256 * 1024 * 1024 }
  );
}

function normalizeDenseIndexDocs(
  docs: Record<string, DenseIndexEntry>,
  embeddingRuntime: EmbeddingRuntime
): Record<string, DenseIndexEntry> {
  const normalizedDocs = new Map<string, DenseIndexEntry>();
  for (const [relativePath, entry] of Object.entries(docs)) {
    const safePath = sanitizePath(relativePath);
    if (!safePath || !entry || typeof entry.hash !== 'string' || typeof entry.content !== 'string') {
      continue;
    }

    const embedding = normalizeEmbeddingVector(entry.embedding, embeddingRuntime.vectorDimension);
    if (!embedding) {
      continue;
    }

    normalizedDocs.set(safePath, {
      path: safePath,
      hash: entry.hash,
      content: entry.content,
      lines: typeof entry.lines === 'string' ? entry.lines : undefined,
      embedding,
      indexed_at: typeof entry.indexed_at === 'string' ? entry.indexed_at : new Date(0).toISOString(),
    });
  }

  return Object.fromEntries([...normalizedDocs.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function readDenseIndex(filePath: string, embeddingRuntime: EmbeddingRuntime): DenseIndexFile {
  const fallback: DenseIndexFile = {
    version: INDEX_VERSION,
    embedding_provider: embeddingRuntime.id,
    embedding_model_id: embeddingRuntime.modelId,
    vector_dimension: embeddingRuntime.vectorDimension,
    updated_at: new Date(0).toISOString(),
    docs: {},
  };

  const parsed = safeReadJson<Partial<DenseIndexFile>>(filePath, fallback, getDenseIndexMaxLoadBytes());
  if (!parsed || typeof parsed !== 'object') {
    return fallback;
  }
  if (
    parsed.embedding_provider !== embeddingRuntime.id
    || parsed.embedding_model_id !== embeddingRuntime.modelId
    || parsed.vector_dimension !== embeddingRuntime.vectorDimension
  ) {
    return fallback;
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : INDEX_VERSION,
    embedding_provider: embeddingRuntime.id,
    embedding_model_id: typeof parsed.embedding_model_id === 'string'
      ? parsed.embedding_model_id
      : embeddingRuntime.modelId,
    vector_dimension: typeof parsed.vector_dimension === 'number'
      ? parsed.vector_dimension
      : embeddingRuntime.vectorDimension,
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : fallback.updated_at,
    docs: parsed.docs && typeof parsed.docs === 'object'
      ? normalizeDenseIndexDocs(parsed.docs as Record<string, DenseIndexEntry>, embeddingRuntime)
      : {},
  };
}

function sanitizePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (!normalized) return null;
  if (normalized.startsWith('..') || normalized.includes('/../')) return null;
  if (path.isAbsolute(normalized)) return null;
  return normalized;
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
    return content.slice(0, 4000);
  } catch {
    return null;
  }
}

async function refreshDenseIndex(
  workspacePath: string,
  denseIndex: DenseIndexFile,
  indexState: IndexStateFile,
  embeddingRuntime: EmbeddingRuntime,
  embeddingReuse: InternalEmbeddingReuse
): Promise<DenseIndexFile> {
  const refreshMaxDocs = envInt(
    'CE_DENSE_REFRESH_MAX_DOCS',
    DEFAULT_DENSE_REFRESH_MAX_DOCS,
    { min: 1, max: 10_000 }
  );
  const embedBatchSize = envInt(
    'CE_DENSE_EMBED_BATCH_SIZE',
    DEFAULT_DENSE_EMBED_BATCH_SIZE,
    { min: 1, max: 512 }
  );
  const refreshStart = Date.now();
  const nextDocs: Record<string, DenseIndexEntry> = {};
  const toEmbedEntries: Array<{
    path: string;
    content: string;
    lookup: ReturnType<typeof createEmbeddingReuseLookup>;
  }> = [];
  const nowIso = new Date().toISOString();
  let refreshedDocs = 0;

  for (const [relativePath, stateEntry] of Object.entries(indexState.files)) {
    const safePath = sanitizePath(relativePath);
    if (!safePath || !stateEntry || typeof stateEntry.hash !== 'string') {
      continue;
    }

    const existing = denseIndex.docs[safePath];
    if (existing && existing.hash === stateEntry.hash) {
      nextDocs[safePath] = existing;
      continue;
    }

    const content = readDocumentContent(workspacePath, safePath);
    if (!content) {
      continue;
    }
    const lookup = createEmbeddingReuseLookup(
      embeddingRuntime,
      'document',
      hashEmbeddingReuseContent(content)
    );
    const reused = getReusableEmbeddingVector(embeddingReuse, lookup);
    if (reused) {
      nextDocs[safePath] = {
        path: safePath,
        hash: stateEntry.hash,
        content,
        indexed_at: nowIso,
        embedding: reused,
      };
      continue;
    }
    if (refreshedDocs >= refreshMaxDocs) {
      incCounter(
        'context_engine_dense_refresh_skipped_docs_total',
        { reason: 'refresh_limit' },
        1,
        'Dense refresh skipped docs due to refresh max-docs cap.'
      );
      continue;
    }
    toEmbedEntries.push({
      path: safePath,
      content,
      lookup,
    });
    nextDocs[safePath] = {
      path: safePath,
      hash: stateEntry.hash,
      content,
      indexed_at: nowIso,
      embedding: [],
    };
    refreshedDocs += 1;
  }

  if (toEmbedEntries.length > 0) {
    for (let i = 0; i < toEmbedEntries.length; i += embedBatchSize) {
      const batchEntries = toEmbedEntries.slice(i, i + embedBatchSize);
      const batchStart = Date.now();
      const embeddings = await embeddingRuntime.embedDocuments(batchEntries.map((entry) => entry.content));
      observeDurationMs(
        'context_engine_dense_embed_batch_duration_seconds',
        { provider: embeddingRuntime.id },
        Date.now() - batchStart,
        { help: 'Dense embedding batch duration in seconds.' }
      );
      incCounter(
        'context_engine_dense_embed_batches_total',
        { provider: embeddingRuntime.id },
        1,
        'Total dense embedding batches.'
      );
      incCounter(
        'context_engine_dense_embed_docs_total',
        { provider: embeddingRuntime.id },
        batchEntries.length,
        'Total dense embedding documents processed.'
      );
      for (let j = 0; j < batchEntries.length; j += 1) {
        const batchEntry = batchEntries[j];
        const embedding = normalizeEmbeddingVector(embeddings[j], embeddingRuntime.vectorDimension);
        if (!embedding) {
          delete nextDocs[batchEntry.path];
          continue;
        }
        setReusableEmbeddingVector(embeddingReuse, batchEntry.lookup, embedding);
        nextDocs[batchEntry.path].embedding = embedding;
      }
    }
  }

  const validDocs = Object.fromEntries(
    Object.entries(nextDocs)
      .filter(([, entry]) => entry.embedding.length === embeddingRuntime.vectorDimension)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  observeDurationMs(
    'context_engine_dense_refresh_duration_seconds',
    { provider: embeddingRuntime.id },
    Date.now() - refreshStart,
    { help: 'Dense refresh duration in seconds.' }
  );
  incCounter(
    'context_engine_dense_refresh_docs_total',
    { provider: embeddingRuntime.id },
    refreshedDocs,
    'Total dense-refresh docs recomputed.'
  );

  return {
    version: INDEX_VERSION,
    embedding_provider: embeddingRuntime.id,
    embedding_model_id: embeddingRuntime.modelId,
    vector_dimension: embeddingRuntime.vectorDimension,
    updated_at: nowIso,
    docs: validDocs,
  };
}

export function createWorkspaceDenseRetriever(options: WorkspaceDenseRetrieverOptions): DenseRetriever {
  const denseIndexReadPath = options.denseIndexPath ?? getReadableWorkspacePath(options.workspacePath, {
    preferred: DENSE_INDEX_FILE_NAME,
    legacy: LEGACY_DENSE_INDEX_FILE_NAME,
  });
  const denseIndexWritePath = options.denseIndexPath ?? getPreferredWorkspacePath(options.workspacePath, {
    preferred: DENSE_INDEX_FILE_NAME,
    legacy: LEGACY_DENSE_INDEX_FILE_NAME,
  });
  const indexStatePath = options.indexStatePath ?? getReadableWorkspacePath(options.workspacePath, {
    preferred: INDEX_STATE_FILE_NAME,
    legacy: LEGACY_INDEX_STATE_FILE_NAME,
  });

  return {
    id: `dense:${options.embeddingRuntime.id}`,
    async search(query: string, topK: number): Promise<SearchResult[]> {
      const embeddingReuse = getInternalEmbeddingReuse();
      const safeTopK = clampTopK(topK);
      try {
        const indexState = readIndexState(indexStatePath);
        const existingDense = readDenseIndex(denseIndexReadPath, options.embeddingRuntime);
        const refreshedDense = await refreshDenseIndex(
          options.workspacePath,
          existingDense,
          indexState,
          options.embeddingRuntime,
          embeddingReuse
        );
        safeWriteJson(denseIndexWritePath, refreshedDense);

        const queryLookup = createEmbeddingReuseLookup(
          options.embeddingRuntime,
          'query',
          hashEmbeddingReuseContent(query)
        );
        let queryEmbedding = getReusableEmbeddingVector(embeddingReuse, queryLookup);
        if (!queryEmbedding) {
          const runtimeVector = normalizeEmbeddingVector(
            await options.embeddingRuntime.embedQuery(query),
            options.embeddingRuntime.vectorDimension
          );
          if (!runtimeVector) {
            throw new Error(`Invalid query embedding returned by "${options.embeddingRuntime.id}".`);
          }
          queryEmbedding = runtimeVector;
          setReusableEmbeddingVector(embeddingReuse, queryLookup, queryEmbedding);
        }

        const ranked = Object.values(refreshedDense.docs)
          .map((doc) => {
            const score = cosineSimilarity(queryEmbedding, doc.embedding);
            return {
              path: doc.path,
              content: doc.content,
              relevanceScore: Math.max(0, Math.min(1, score)),
              matchType: 'semantic' as const,
              retrievedAt: refreshedDense.updated_at,
            };
          })
          .sort((a, b) => {
            if (b.relevanceScore !== a.relevanceScore) {
              return b.relevanceScore - a.relevanceScore;
            }
            return a.path.localeCompare(b.path);
          })
          .slice(0, safeTopK);

        return ranked;
      } finally {
        await embeddingReuse.flush?.();
      }
    },
  };
}
