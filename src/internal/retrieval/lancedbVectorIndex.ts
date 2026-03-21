import * as fs from 'fs';
import * as path from 'path';
import * as lancedb from '@lancedb/lancedb';
import type { SearchResult } from '../../mcp/serviceClient.js';
import { envInt } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import type { DenseRetriever } from './embeddingProvider.js';
import type { EmbeddingRuntime } from './embeddingRuntime.js';

const VECTOR_DB_DIR_NAME = '.augment-lancedb';
const VECTOR_INDEX_STATE_FILE_NAME = '.augment-lancedb-index.json';
const INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const TABLE_NAME = 'retrieval_vectors';
const INDEX_VERSION = 1;
const DEFAULT_REFRESH_MAX_DOCS = 500;
const DEFAULT_EMBED_BATCH_SIZE = 64;

interface VectorIndexEntry {
  hash: string;
  indexed_at: string;
}

interface VectorIndexFile {
  version: number;
  embedding_provider: string;
  embedding_model_id: string;
  vector_dimension: number;
  updated_at: string;
  docs: Record<string, VectorIndexEntry>;
}

interface IndexStateFileEntry {
  hash: string;
  indexed_at: string;
}

interface IndexStateFile {
  files: Record<string, IndexStateFileEntry>;
}

type VectorTableRow = Record<string, unknown> & {
  path: string;
  hash: string;
  content: string;
  lines: string;
  vector: number[];
  indexed_at: string;
};

export interface WorkspaceLanceDbVectorRetrieverOptions {
  workspacePath: string;
  embeddingRuntime: EmbeddingRuntime;
  vectorDbPath?: string;
  indexStatePath?: string;
}

const connectionCache = new Map<string, Promise<lancedb.Connection>>();

function clampTopK(topK: number): number {
  return Math.max(1, Math.min(50, Math.floor(topK)));
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sanitizePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').trim();
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

function readVectorIndex(filePath: string, runtime: EmbeddingRuntime): VectorIndexFile {
  const fallback: VectorIndexFile = {
    version: INDEX_VERSION,
    embedding_provider: runtime.id,
    embedding_model_id: runtime.modelId,
    vector_dimension: runtime.vectorDimension,
    updated_at: new Date(0).toISOString(),
    docs: {},
  };

  const parsed = safeReadJson<Partial<VectorIndexFile>>(filePath, fallback);
  if (!parsed || typeof parsed !== 'object') {
    return fallback;
  }
  if (parsed.embedding_provider !== runtime.id) {
    return fallback;
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : INDEX_VERSION,
    embedding_provider: runtime.id,
    embedding_model_id: typeof parsed.embedding_model_id === 'string'
      ? parsed.embedding_model_id
      : runtime.modelId,
    vector_dimension: typeof parsed.vector_dimension === 'number'
      ? parsed.vector_dimension
      : runtime.vectorDimension,
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : fallback.updated_at,
    docs: parsed.docs && typeof parsed.docs === 'object'
      ? (parsed.docs as Record<string, VectorIndexEntry>)
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
    return content.slice(0, 4000);
  } catch {
    return null;
  }
}

function getLinesPreview(content: string): string {
  return content.split(/\r?\n/).slice(0, 8).join('\n');
}

async function getConnection(vectorDbPath: string): Promise<lancedb.Connection> {
  const cached = connectionCache.get(vectorDbPath);
  if (cached) return cached;
  const promise = lancedb.connect(vectorDbPath).catch((error) => {
    connectionCache.delete(vectorDbPath);
    throw error;
  });
  connectionCache.set(vectorDbPath, promise);
  return promise;
}

function resetVectorConnection(vectorDbPath: string): void {
  connectionCache.delete(vectorDbPath);
}

function removeVectorArtifacts(vectorDbPath: string): void {
  resetVectorConnection(vectorDbPath);
  try {
    fs.rmSync(vectorDbPath, { recursive: true, force: true });
  } catch {
    // ignore delete failures; callers will retry with a fresh path if possible
  }
}

async function hasTable(connection: lancedb.Connection, tableName: string): Promise<boolean> {
  const tableNames = await connection.tableNames();
  return tableNames.includes(tableName);
}

async function loadTable(connection: lancedb.Connection, tableName: string): Promise<lancedb.Table | null> {
  if (!(await hasTable(connection, tableName))) {
    return null;
  }
  return connection.openTable(tableName);
}

async function ensureVectorIndex(table: lancedb.Table): Promise<void> {
  const indices = await table.listIndices();
  const hasVectorIndex = indices.some((index) => index.name === 'vector_idx');
  if (!hasVectorIndex) {
    await table.createIndex('vector', {
      config: lancedb.Index.ivfFlat({
        numPartitions: 1,
        distanceType: 'l2',
      }),
    });
    await table.waitForIndex(['vector_idx'], 60);
  }
}

async function buildRows(
  workspacePath: string,
  indexState: IndexStateFile,
  embeddingRuntime: EmbeddingRuntime
): Promise<VectorTableRow[]> {
  const refreshMaxDocs = envInt(
    'CE_DENSE_REFRESH_MAX_DOCS',
    DEFAULT_REFRESH_MAX_DOCS,
    { min: 1, max: 10_000 }
  );
  const embedBatchSize = envInt(
    'CE_DENSE_EMBED_BATCH_SIZE',
    DEFAULT_EMBED_BATCH_SIZE,
    { min: 1, max: 512 }
  );
  const refreshStart = Date.now();
  const rows: VectorTableRow[] = [];
  const normalizedIndexEntries = new Map<string, IndexStateFileEntry>();
  for (const [relativePath, entry] of Object.entries(indexState.files)) {
    const safePath = sanitizePath(relativePath);
    if (safePath && entry && typeof entry.hash === 'string') {
      normalizedIndexEntries.set(safePath, entry);
    }
  }
  const nextPaths = [...normalizedIndexEntries.keys()].sort();
  let refreshedDocs = 0;

  for (const relativePath of nextPaths) {
    const stateEntry = normalizedIndexEntries.get(relativePath);
    if (!stateEntry) {
      continue;
    }
    const content = readDocumentContent(workspacePath, relativePath);
    if (!content) {
      continue;
    }
    if (refreshedDocs >= refreshMaxDocs) {
      incCounter(
        'context_engine_lancedb_refresh_skipped_docs_total',
        { reason: 'refresh_limit' },
        1,
        'LanceDB refresh skipped docs due to refresh max-docs cap.'
      );
      continue;
    }
    rows.push({
      path: relativePath,
      hash: stateEntry.hash,
      content,
      lines: getLinesPreview(content),
      vector: [],
      indexed_at: new Date().toISOString(),
    });
    refreshedDocs += 1;
  }

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += embedBatchSize) {
      const batchRows = rows.slice(i, i + embedBatchSize);
      const batchDocs = batchRows.map((row) => row.content);
      const batchStart = Date.now();
      const embeddings = await embeddingRuntime.embedDocuments(batchDocs);
      observeDurationMs(
        'context_engine_lancedb_embed_batch_duration_seconds',
        { provider: embeddingRuntime.id },
        Date.now() - batchStart,
        { help: 'LanceDB embedding batch duration in seconds.' }
      );
      incCounter(
        'context_engine_lancedb_embed_batches_total',
        { provider: embeddingRuntime.id },
        1,
        'Total LanceDB embedding batches.'
      );
      incCounter(
        'context_engine_lancedb_embed_docs_total',
        { provider: embeddingRuntime.id },
        batchDocs.length,
        'Total LanceDB embedding documents processed.'
      );
      for (let j = 0; j < batchRows.length; j += 1) {
        batchRows[j].vector = embeddings[j] ?? [];
      }
    }
  }

  observeDurationMs(
    'context_engine_lancedb_refresh_duration_seconds',
    { provider: embeddingRuntime.id },
    Date.now() - refreshStart,
    { help: 'LanceDB refresh duration in seconds.' }
  );
  incCounter(
    'context_engine_lancedb_refresh_docs_total',
    { provider: embeddingRuntime.id },
    refreshedDocs,
    'Total LanceDB-refresh docs recomputed.'
  );

  return rows;
}

async function applyIncrementalChanges(
  table: lancedb.Table,
  workspacePath: string,
  indexState: IndexStateFile,
  vectorIndex: VectorIndexFile,
  embeddingRuntime: EmbeddingRuntime
): Promise<VectorIndexFile> {
  const normalizedIndexEntries = new Map<string, IndexStateFileEntry>();
  for (const [relativePath, entry] of Object.entries(indexState.files)) {
    const safePath = sanitizePath(relativePath);
    if (safePath && entry && typeof entry.hash === 'string') {
      normalizedIndexEntries.set(safePath, entry);
    }
  }
  const currentPaths = new Set(normalizedIndexEntries.keys());
  const previousPaths = new Set(Object.keys(vectorIndex.docs));
  const changed = [...currentPaths].filter((relativePath) => {
    const stateEntry = normalizedIndexEntries.get(relativePath);
    if (!stateEntry) return false;
    return vectorIndex.docs[relativePath]?.hash !== stateEntry.hash;
  });
  const added = [...currentPaths].filter((relativePath) => {
    const stateEntry = normalizedIndexEntries.get(relativePath);
    return Boolean(stateEntry) && !vectorIndex.docs[relativePath];
  });
  const removed = [...previousPaths].filter((relativePath) => !currentPaths.has(relativePath));

  const pathsToDelete = [...new Set([...removed, ...changed])];
  if (pathsToDelete.length > 0) {
    const predicate = pathsToDelete.length === 1
      ? `path = ${sqlStringLiteral(pathsToDelete[0])}`
      : `path IN (${pathsToDelete.map(sqlStringLiteral).join(', ')})`;
    await table.delete(predicate);
    for (const removedPath of pathsToDelete) {
      delete vectorIndex.docs[removedPath];
    }
  }

  const pathsToUpsert = [...new Set([...added, ...changed])];

  if (pathsToUpsert.length > 0) {
    const rows: VectorTableRow[] = [];
    for (const relativePath of pathsToUpsert) {
      const stateEntry = normalizedIndexEntries.get(relativePath);
      const content = readDocumentContent(workspacePath, relativePath);
      if (!stateEntry || !content) {
        continue;
      }
      rows.push({
        path: relativePath,
        hash: stateEntry.hash,
        content,
        lines: getLinesPreview(content),
        vector: [],
        indexed_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      const batchSize = envInt('CE_DENSE_EMBED_BATCH_SIZE', DEFAULT_EMBED_BATCH_SIZE, { min: 1, max: 512 });
      for (let i = 0; i < rows.length; i += batchSize) {
        const batchRows = rows.slice(i, i + batchSize);
        const batchStart = Date.now();
        const embeddings = await embeddingRuntime.embedDocuments(batchRows.map((row) => row.content));
        observeDurationMs(
          'context_engine_lancedb_embed_batch_duration_seconds',
          { provider: embeddingRuntime.id },
          Date.now() - batchStart,
          { help: 'LanceDB embedding batch duration in seconds.' }
        );
        for (let j = 0; j < batchRows.length; j += 1) {
          batchRows[j].vector = embeddings[j] ?? [];
        }
      }
      await table.add(rows);
      for (const row of rows) {
        vectorIndex.docs[row.path] = {
          hash: row.hash,
          indexed_at: row.indexed_at,
        };
      }
    }
  }

  return {
    ...vectorIndex,
    updated_at: new Date().toISOString(),
    docs: { ...vectorIndex.docs },
    embedding_provider: embeddingRuntime.id,
    embedding_model_id: embeddingRuntime.modelId,
    vector_dimension: embeddingRuntime.vectorDimension,
  };
}

async function refreshVectorIndex(
  workspacePath: string,
  vectorDbPath: string,
  vectorIndex: VectorIndexFile,
  indexState: IndexStateFile,
  embeddingRuntime: EmbeddingRuntime
): Promise<VectorIndexFile> {
  const connection = await getConnection(vectorDbPath);
  const tableExists = await hasTable(connection, TABLE_NAME);
  const currentPaths = Object.keys(indexState.files).sort();

  if (currentPaths.length === 0) {
    if (tableExists) {
      await connection.dropTable(TABLE_NAME);
    }
    return {
      version: INDEX_VERSION,
      embedding_provider: embeddingRuntime.id,
      embedding_model_id: embeddingRuntime.modelId,
      vector_dimension: embeddingRuntime.vectorDimension,
      updated_at: new Date().toISOString(),
      docs: {},
    };
  }

  if (!tableExists || vectorIndex.embedding_provider !== embeddingRuntime.id || vectorIndex.vector_dimension !== embeddingRuntime.vectorDimension) {
    const rows = await buildRows(workspacePath, indexState, embeddingRuntime);
    if (tableExists) {
      await connection.dropTable(TABLE_NAME);
    }
    if (rows.length === 0) {
      return {
        version: INDEX_VERSION,
        embedding_provider: embeddingRuntime.id,
        embedding_model_id: embeddingRuntime.modelId,
        vector_dimension: embeddingRuntime.vectorDimension,
        updated_at: new Date().toISOString(),
        docs: {},
      };
    }
    const table = await connection.createTable(TABLE_NAME, rows, { mode: 'create', existOk: true });
    await ensureVectorIndex(table);
    const nextDocs: Record<string, VectorIndexEntry> = {};
    for (const row of rows) {
      nextDocs[row.path] = { hash: row.hash, indexed_at: row.indexed_at };
    }
    return {
      version: INDEX_VERSION,
      embedding_provider: embeddingRuntime.id,
      embedding_model_id: embeddingRuntime.modelId,
      vector_dimension: embeddingRuntime.vectorDimension,
      updated_at: new Date().toISOString(),
      docs: nextDocs,
    };
  }

  if (Object.keys(vectorIndex.docs).length === 0 && tableExists) {
    await connection.dropTable(TABLE_NAME);
    const rows = await buildRows(workspacePath, indexState, embeddingRuntime);
    if (rows.length === 0) {
      return {
        version: INDEX_VERSION,
        embedding_provider: embeddingRuntime.id,
        embedding_model_id: embeddingRuntime.modelId,
        vector_dimension: embeddingRuntime.vectorDimension,
        updated_at: new Date().toISOString(),
        docs: {},
      };
    }
    const table = await connection.createTable(TABLE_NAME, rows, { mode: 'create', existOk: true });
    await ensureVectorIndex(table);
    const nextDocs: Record<string, VectorIndexEntry> = {};
    for (const row of rows) {
      nextDocs[row.path] = { hash: row.hash, indexed_at: row.indexed_at };
    }
    return {
      version: INDEX_VERSION,
      embedding_provider: embeddingRuntime.id,
      embedding_model_id: embeddingRuntime.modelId,
      vector_dimension: embeddingRuntime.vectorDimension,
      updated_at: new Date().toISOString(),
      docs: nextDocs,
    };
  }

  const table = await connection.openTable(TABLE_NAME);
  const refreshed = await applyIncrementalChanges(table, workspacePath, indexState, vectorIndex, embeddingRuntime);
  await ensureVectorIndex(table);
  return refreshed;
}

export function createWorkspaceLanceDbVectorRetriever(options: WorkspaceLanceDbVectorRetrieverOptions): DenseRetriever {
  const vectorDbPath = options.vectorDbPath ?? path.join(options.workspacePath, VECTOR_DB_DIR_NAME);
  const indexStatePath = options.indexStatePath ?? path.join(options.workspacePath, INDEX_STATE_FILE_NAME);
  const vectorIndexPath = path.join(options.workspacePath, VECTOR_INDEX_STATE_FILE_NAME);

  return {
    id: `lancedb:${options.embeddingRuntime.id}`,
    async search(query: string, topK: number): Promise<SearchResult[]> {
      const safeTopK = clampTopK(topK);
      const runSearch = async (): Promise<SearchResult[]> => {
        const indexState = readIndexState(indexStatePath);
        const existingVectorIndex = readVectorIndex(vectorIndexPath, options.embeddingRuntime);
        const refreshedVectorIndex = await refreshVectorIndex(
          options.workspacePath,
          vectorDbPath,
          existingVectorIndex,
          indexState,
          options.embeddingRuntime
        );
        safeWriteJson(vectorIndexPath, refreshedVectorIndex);

        const connection = await getConnection(vectorDbPath);
        if (!(await hasTable(connection, TABLE_NAME))) {
          return [];
        }
        const table = await loadTable(connection, TABLE_NAME);
        if (!table) {
          return [];
        }

        const queryEmbedding = await options.embeddingRuntime.embedQuery(query);
        const rows = await table.vectorSearch(queryEmbedding).limit(safeTopK).toArray();
        const ranked = rows
          .map((row) => {
            const distance = typeof row._distance === 'number' ? row._distance : Number.POSITIVE_INFINITY;
            const relevanceScore = Number.isFinite(distance)
              ? Math.max(0, Math.min(1, 1 - (distance / 2)))
              : 0;
            const content = typeof row.content === 'string' ? row.content : '';
            return {
              path: typeof row.path === 'string' ? row.path : '',
              content,
              lines: typeof row.lines === 'string' ? row.lines : content,
              relevanceScore,
              score: relevanceScore,
              matchType: 'semantic' as const,
              retrievedAt: refreshedVectorIndex.updated_at,
              chunkId: typeof row.path === 'string' ? row.path : undefined,
            };
          })
          .filter((row) => row.path.length > 0)
          .sort((a, b) => {
            if ((b.relevanceScore ?? 0) !== (a.relevanceScore ?? 0)) {
              return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
            }
            return a.path.localeCompare(b.path);
          });

        return ranked.slice(0, safeTopK);
      };

      try {
        return await runSearch();
      } catch {
        removeVectorArtifacts(vectorDbPath);
        try {
          return await runSearch();
        } catch {
          return [];
        }
      }
    },
  };
}
