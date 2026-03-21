import * as fs from 'fs';
import * as path from 'path';
import type { SearchResult } from '../../mcp/serviceClient.js';
import { envInt } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import type { DenseRetriever } from './embeddingProvider.js';
import type { EmbeddingRuntime } from './embeddingRuntime.js';

const DENSE_INDEX_FILE_NAME = '.augment-dense-index.json';
const INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const INDEX_VERSION = 1;
const DEFAULT_DENSE_REFRESH_MAX_DOCS = 500;
const DEFAULT_DENSE_EMBED_BATCH_SIZE = 64;

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

function readDenseIndex(filePath: string, embeddingRuntime: EmbeddingRuntime): DenseIndexFile {
  const fallback: DenseIndexFile = {
    version: INDEX_VERSION,
    embedding_provider: embeddingRuntime.id,
    embedding_model_id: embeddingRuntime.modelId,
    vector_dimension: embeddingRuntime.vectorDimension,
    updated_at: new Date(0).toISOString(),
    docs: {},
  };

  const parsed = safeReadJson<Partial<DenseIndexFile>>(filePath, fallback);
  if (!parsed || typeof parsed !== 'object') {
    return fallback;
  }
  if (parsed.embedding_provider !== embeddingRuntime.id) {
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
    docs: parsed.docs && typeof parsed.docs === 'object' ? (parsed.docs as Record<string, DenseIndexEntry>) : {},
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
  embeddingRuntime: EmbeddingRuntime
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
  const toEmbedPaths: string[] = [];
  const toEmbedDocs: string[] = [];
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
    if (refreshedDocs >= refreshMaxDocs) {
      incCounter(
        'context_engine_dense_refresh_skipped_docs_total',
        { reason: 'refresh_limit' },
        1,
        'Dense refresh skipped docs due to refresh max-docs cap.'
      );
      continue;
    }
    toEmbedPaths.push(safePath);
    toEmbedDocs.push(content);
    nextDocs[safePath] = {
      path: safePath,
      hash: stateEntry.hash,
      content,
      indexed_at: nowIso,
      embedding: [],
    };
    refreshedDocs += 1;
  }

  if (toEmbedDocs.length > 0) {
    for (let i = 0; i < toEmbedDocs.length; i += embedBatchSize) {
      const batchDocs = toEmbedDocs.slice(i, i + embedBatchSize);
      const batchPaths = toEmbedPaths.slice(i, i + embedBatchSize);
      const batchStart = Date.now();
      const embeddings = await embeddingRuntime.embedDocuments(batchDocs);
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
        batchDocs.length,
        'Total dense embedding documents processed.'
      );
      for (let j = 0; j < batchPaths.length; j += 1) {
        const docPath = batchPaths[j];
        const embedding = embeddings[j] ?? [];
        nextDocs[docPath].embedding = embedding;
      }
    }
  }

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
    docs: nextDocs,
  };
}

export function createWorkspaceDenseRetriever(options: WorkspaceDenseRetrieverOptions): DenseRetriever {
  const denseIndexPath = options.denseIndexPath ?? path.join(options.workspacePath, DENSE_INDEX_FILE_NAME);
  const indexStatePath = options.indexStatePath ?? path.join(options.workspacePath, INDEX_STATE_FILE_NAME);

  return {
    id: `dense:${options.embeddingRuntime.id}`,
    async search(query: string, topK: number): Promise<SearchResult[]> {
      const safeTopK = clampTopK(topK);
      const indexState = readIndexState(indexStatePath);
      const existingDense = readDenseIndex(denseIndexPath, options.embeddingRuntime);
      const refreshedDense = await refreshDenseIndex(
        options.workspacePath,
        existingDense,
        indexState,
        options.embeddingRuntime
      );
      safeWriteJson(denseIndexPath, refreshedDense);

      const queryEmbedding = await options.embeddingRuntime.embedQuery(query);
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
    },
  };
}
