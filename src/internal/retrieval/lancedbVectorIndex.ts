import * as fs from 'fs';
import * as path from 'path';
import * as lancedb from '@lancedb/lancedb';
import type { SearchResult } from '../../mcp/serviceClient.js';
import { envInt } from '../../config/env.js';
import { incCounter, observeDurationMs } from '../../metrics/metrics.js';
import {
  getPreferredWorkspaceDirectory,
  getPreferredWorkspacePath,
  getReadableWorkspaceDirectory,
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
import { splitIntoChunks } from './chunking.js';
import type { DenseRetriever } from './embeddingProvider.js';
import type { EmbeddingRuntime } from './embeddingRuntime.js';

const VECTOR_DB_DIR_NAME = '.context-engine-lancedb';
const LEGACY_VECTOR_DB_DIR_NAME = '.augment-lancedb';
const VECTOR_INDEX_STATE_FILE_NAME = '.context-engine-lancedb-index.json';
const LEGACY_VECTOR_INDEX_STATE_FILE_NAME = '.augment-lancedb-index.json';
const INDEX_STATE_FILE_NAME = '.context-engine-index-state.json';
const LEGACY_INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const TABLE_NAME = 'retrieval_vectors';
const INDEX_VERSION = 1;
const DEFAULT_REFRESH_MAX_DOCS = 500;
const DEFAULT_EMBED_BATCH_SIZE = 64;
const MAX_INDEXED_DOCUMENT_CHARS = 4_000;
const EMBEDDING_CHUNK_MAX_LINES = 24;
const EMBEDDING_CHUNK_MAX_CHARS = 750;
const EMBEDDING_CHUNK_OVERLAP_LINES = 4;

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
  doc_count: number;
  vector_index_ready: boolean;
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

interface IncrementalRefreshResult {
  vectorIndex: VectorIndexFile;
  tableChanged: boolean;
}

type SearchFailureStage = 'refresh' | 'table_load' | 'query_embed' | 'query_search';

class VectorSearchFailure extends Error {
  readonly stage: SearchFailureStage;
  readonly rootCause: unknown;

  constructor(stage: SearchFailureStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : `LanceDB ${stage} failed.`);
    this.name = 'VectorSearchFailure';
    this.stage = stage;
    this.rootCause = cause;
  }
}

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

function normalizeIndexStateEntries(indexState: IndexStateFile): Map<string, IndexStateFileEntry> {
  const normalizedIndexEntries = new Map<string, IndexStateFileEntry>();
  for (const [relativePath, entry] of Object.entries(indexState.files)) {
    const safePath = sanitizePath(relativePath);
    if (safePath && entry && typeof entry.hash === 'string') {
      normalizedIndexEntries.set(safePath, entry);
    }
  }
  return normalizedIndexEntries;
}

function normalizeVectorDocs(docs: Record<string, VectorIndexEntry>): Record<string, VectorIndexEntry> {
  const normalizedDocs = new Map<string, VectorIndexEntry>();
  for (const [relativePath, entry] of Object.entries(docs)) {
    const safePath = sanitizePath(relativePath);
    if (!safePath || !entry || typeof entry.hash !== 'string') {
      continue;
    }
    normalizedDocs.set(safePath, {
      hash: entry.hash,
      indexed_at: typeof entry.indexed_at === 'string' ? entry.indexed_at : new Date(0).toISOString(),
    });
  }
  return Object.fromEntries([...normalizedDocs.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function createVectorIndexFile(
  runtime: EmbeddingRuntime,
  docs: Record<string, VectorIndexEntry>,
  updatedAt: string = new Date().toISOString(),
  vectorIndexReady = false
): VectorIndexFile {
  const normalizedDocs = normalizeVectorDocs(docs);
  const docCount = Object.keys(normalizedDocs).length;
  return {
    version: INDEX_VERSION,
    embedding_provider: runtime.id,
    embedding_model_id: runtime.modelId,
    vector_dimension: runtime.vectorDimension,
    updated_at: updatedAt,
    doc_count: docCount,
    vector_index_ready: vectorIndexReady && docCount > 0,
    docs: normalizedDocs,
  };
}

function hasConsistentVectorIndexDocCount(vectorIndex: VectorIndexFile): boolean {
  return vectorIndex.doc_count === Object.keys(vectorIndex.docs).length;
}

function shouldPersistVectorIndex(previous: VectorIndexFile, next: VectorIndexFile): boolean {
  return JSON.stringify({ ...previous, updated_at: '' }) !== JSON.stringify({ ...next, updated_at: '' });
}

function getEmbedBatchSize(): number {
  return envInt(
    'CE_DENSE_EMBED_BATCH_SIZE',
    DEFAULT_EMBED_BATCH_SIZE,
    { min: 1, max: 512 }
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown LanceDB error';
}

function toVectorSearchFailure(stage: SearchFailureStage, error: unknown): VectorSearchFailure {
  return error instanceof VectorSearchFailure ? error : new VectorSearchFailure(stage, error);
}

function shouldAttemptNonDestructiveRetry(error: unknown): boolean {
  return !(error instanceof VectorSearchFailure) || error.stage !== 'query_embed';
}

function shouldAttemptDestructiveRecovery(error: unknown): boolean {
  if (!(error instanceof VectorSearchFailure)) {
    return true;
  }
  if (error.stage === 'query_embed') {
    return false;
  }
  if (error.stage === 'refresh' || error.stage === 'table_load' || error.stage === 'query_search') {
    return /corrupt|manifest|schema|index|table|dataset|not a directory|failed to open|lance|arrow/i
      .test(getErrorMessage(error.rootCause));
  }
  return true;
}

function docsFromRows(rows: VectorTableRow[]): Record<string, VectorIndexEntry> {
  const docs: Record<string, VectorIndexEntry> = {};
  for (const row of rows) {
    docs[row.path] = {
      hash: row.hash,
      indexed_at: row.indexed_at,
    };
  }
  return docs;
}

function readVectorIndex(filePath: string, runtime: EmbeddingRuntime): VectorIndexFile {
  const fallback = createVectorIndexFile(runtime, {}, new Date(0).toISOString(), false);

  const parsed = safeReadJson<Partial<VectorIndexFile>>(filePath, fallback);
  if (!parsed || typeof parsed !== 'object') {
    return fallback;
  }
  if (parsed.embedding_provider !== runtime.id) {
    return fallback;
  }
  const docs = parsed.docs && typeof parsed.docs === 'object'
    ? normalizeVectorDocs(parsed.docs as Record<string, VectorIndexEntry>)
    : {};
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
    doc_count: typeof parsed.doc_count === 'number' && Number.isFinite(parsed.doc_count) && parsed.doc_count >= 0
      ? Math.floor(parsed.doc_count)
      : Object.keys(docs).length,
    vector_index_ready: parsed.vector_index_ready === true,
    docs,
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
    return content.slice(0, MAX_INDEXED_DOCUMENT_CHARS);
  } catch {
    return null;
  }
}

function getLinesPreview(content: string): string {
  return content.split(/\r?\n/).slice(0, 8).join('\n');
}

function buildEmbeddingInputs(relativePath: string, content: string): string[] {
  const chunks = splitIntoChunks(content, {
    path: relativePath,
    maxChunkLines: EMBEDDING_CHUNK_MAX_LINES,
    maxChunkChars: EMBEDDING_CHUNK_MAX_CHARS,
    overlapLines: EMBEDDING_CHUNK_OVERLAP_LINES,
  });

  if (chunks.length === 0) {
    return content.trim() ? [content] : [];
  }

  return chunks.map((chunk) => chunk.content);
}

function averageEmbeddings(vectors: number[][]): number[] {
  const nonEmptyVectors = vectors.filter((vector) => vector.length > 0);
  if (nonEmptyVectors.length === 0) {
    return [];
  }

  const dimension = nonEmptyVectors.reduce((max, vector) => Math.max(max, vector.length), 0);
  const sums = new Array<number>(dimension).fill(0);
  for (const vector of nonEmptyVectors) {
    for (let index = 0; index < dimension; index += 1) {
      sums[index] += Number(vector[index] ?? 0);
    }
  }

  return sums.map((sum) => sum / nonEmptyVectors.length);
}

async function embedRows(
  rows: VectorTableRow[],
  embeddingRuntime: EmbeddingRuntime,
  batchSize: number,
  embeddingReuse: InternalEmbeddingReuse
): Promise<void> {
  const pendingVectors = rows.map(() => [] as number[][]);
  const embeddingInputs = rows.flatMap((row, rowIndex) =>
    buildEmbeddingInputs(row.path, row.content).map((content) => ({
      rowIndex,
      content,
      lookup: createEmbeddingReuseLookup(
        embeddingRuntime,
        'document',
        hashEmbeddingReuseContent(content)
      ),
    }))
  );
  const cacheMisses: typeof embeddingInputs = [];

  for (const input of embeddingInputs) {
    const reused = getReusableEmbeddingVector(embeddingReuse, input.lookup);
    if (reused) {
      pendingVectors[input.rowIndex].push(reused);
      continue;
    }
    cacheMisses.push(input);
  }

  for (let index = 0; index < cacheMisses.length; index += batchSize) {
    const batch = cacheMisses.slice(index, index + batchSize);
    const batchStart = Date.now();
    const embeddings = await embeddingRuntime.embedDocuments(batch.map((entry) => entry.content));
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
      batch.length,
      'Total LanceDB embedding documents processed.'
    );

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const embedding = normalizeEmbeddingVector(embeddings[batchIndex], embeddingRuntime.vectorDimension);
      if (!embedding) {
        continue;
      }
      setReusableEmbeddingVector(embeddingReuse, batch[batchIndex].lookup, embedding);
      pendingVectors[batch[batchIndex].rowIndex].push(embedding);
    }
  }

  for (let index = 0; index < rows.length; index += 1) {
    rows[index].vector = averageEmbeddings(pendingVectors[index]);
  }
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

function migrateLegacyVectorDbPath(preferredPath: string, legacyPath: string): string {
  if (fs.existsSync(preferredPath) || !fs.existsSync(legacyPath)) {
    return preferredPath;
  }

  try {
    fs.mkdirSync(path.dirname(preferredPath), { recursive: true });
    fs.cpSync(legacyPath, preferredPath, { recursive: true, force: false });
  } catch {
    // Best-effort migration only; fall back to the legacy path if copying fails.
  }

  return fs.existsSync(preferredPath) ? preferredPath : legacyPath;
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
  embeddingRuntime: EmbeddingRuntime,
  embeddingReuse: InternalEmbeddingReuse
): Promise<VectorTableRow[]> {
  const refreshMaxDocs = envInt(
    'CE_DENSE_REFRESH_MAX_DOCS',
    DEFAULT_REFRESH_MAX_DOCS,
    { min: 1, max: 10_000 }
  );
  const embedBatchSize = getEmbedBatchSize();
  const refreshStart = Date.now();
  const rows: VectorTableRow[] = [];
  const normalizedIndexEntries = normalizeIndexStateEntries(indexState);
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
    await embedRows(rows, embeddingRuntime, embedBatchSize, embeddingReuse);
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

  return rows.filter((row) => row.vector.length === embeddingRuntime.vectorDimension);
}

async function applyIncrementalChanges(
  table: lancedb.Table,
  workspacePath: string,
  indexState: IndexStateFile,
  vectorIndex: VectorIndexFile,
  embeddingRuntime: EmbeddingRuntime,
  embeddingReuse: InternalEmbeddingReuse
): Promise<IncrementalRefreshResult> {
  const normalizedIndexEntries = normalizeIndexStateEntries(indexState);
  const currentPaths = new Set(normalizedIndexEntries.keys());
  const nextDocs: Record<string, VectorIndexEntry> = { ...vectorIndex.docs };
  const previousPaths = new Set(Object.keys(nextDocs));
  const changed = [...currentPaths].filter((relativePath) => {
    const stateEntry = normalizedIndexEntries.get(relativePath);
    if (!stateEntry) return false;
    return nextDocs[relativePath]?.hash !== stateEntry.hash;
  });
  const added = [...currentPaths].filter((relativePath) => {
    const stateEntry = normalizedIndexEntries.get(relativePath);
    return Boolean(stateEntry) && !nextDocs[relativePath];
  });
  const removed = [...previousPaths].filter((relativePath) => !currentPaths.has(relativePath));
  let tableChanged = false;

  const pathsToDelete = [...new Set([...removed, ...changed])];
  if (pathsToDelete.length > 0) {
    const predicate = pathsToDelete.length === 1
      ? `path = ${sqlStringLiteral(pathsToDelete[0])}`
      : `path IN (${pathsToDelete.map(sqlStringLiteral).join(', ')})`;
    await table.delete(predicate);
    tableChanged = true;
    for (const removedPath of pathsToDelete) {
      delete nextDocs[removedPath];
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
      const batchSize = getEmbedBatchSize();
      await embedRows(rows, embeddingRuntime, batchSize, embeddingReuse);
      const validRows = rows.filter((row) => row.vector.length === embeddingRuntime.vectorDimension);
      for (let i = 0; i < validRows.length; i += batchSize) {
        await table.add(validRows.slice(i, i + batchSize));
      }
      if (validRows.length > 0) {
        tableChanged = true;
        for (const row of validRows) {
          nextDocs[row.path] = {
            hash: row.hash,
            indexed_at: row.indexed_at,
          };
        }
      }
    }
  }

  return {
    vectorIndex: createVectorIndexFile(
      embeddingRuntime,
      nextDocs,
      new Date().toISOString(),
      tableChanged ? false : vectorIndex.vector_index_ready
    ),
    tableChanged,
  };
}

async function rebuildVectorIndex(
  connection: lancedb.Connection,
  tableExists: boolean,
  workspacePath: string,
  indexState: IndexStateFile,
  embeddingRuntime: EmbeddingRuntime,
  embeddingReuse: InternalEmbeddingReuse
): Promise<VectorIndexFile> {
  const rows = await buildRows(workspacePath, indexState, embeddingRuntime, embeddingReuse);
  if (tableExists) {
    await connection.dropTable(TABLE_NAME);
  }
  if (rows.length === 0) {
    return createVectorIndexFile(embeddingRuntime, {}, new Date().toISOString(), false);
  }
  const table = await connection.createTable(TABLE_NAME, rows, { mode: 'create', existOk: true });
  await ensureVectorIndex(table);
  return createVectorIndexFile(embeddingRuntime, docsFromRows(rows), new Date().toISOString(), true);
}

async function refreshVectorIndex(
  workspacePath: string,
  vectorDbPath: string,
  vectorIndex: VectorIndexFile,
  indexState: IndexStateFile,
  embeddingRuntime: EmbeddingRuntime,
  embeddingReuse: InternalEmbeddingReuse
): Promise<VectorIndexFile> {
  const connection = await getConnection(vectorDbPath);
  const tableExists = await hasTable(connection, TABLE_NAME);
  const currentPaths = [...normalizeIndexStateEntries(indexState).keys()].sort();

  if (currentPaths.length === 0) {
    if (tableExists) {
      await connection.dropTable(TABLE_NAME);
    }
    return createVectorIndexFile(embeddingRuntime, {}, new Date().toISOString(), false);
  }

  if (
    !tableExists
    || vectorIndex.embedding_provider !== embeddingRuntime.id
    || vectorIndex.embedding_model_id !== embeddingRuntime.modelId
    || vectorIndex.vector_dimension !== embeddingRuntime.vectorDimension
  ) {
    return rebuildVectorIndex(connection, tableExists, workspacePath, indexState, embeddingRuntime, embeddingReuse);
  }

  const table = await connection.openTable(TABLE_NAME);
  const persistedDocCount = Object.keys(vectorIndex.docs).length;
  if (persistedDocCount === 0) {
    return rebuildVectorIndex(connection, true, workspacePath, indexState, embeddingRuntime, embeddingReuse);
  }
  let repairedVectorIndex = hasConsistentVectorIndexDocCount(vectorIndex)
    ? vectorIndex
    : createVectorIndexFile(
        embeddingRuntime,
        vectorIndex.docs,
        new Date().toISOString(),
        vectorIndex.vector_index_ready
      );
  if (!hasConsistentVectorIndexDocCount(vectorIndex)) {
    const actualDocCount = await table.countRows();
    if (actualDocCount !== persistedDocCount) {
      return rebuildVectorIndex(connection, true, workspacePath, indexState, embeddingRuntime, embeddingReuse);
    }
    repairedVectorIndex = createVectorIndexFile(
      embeddingRuntime,
      vectorIndex.docs,
      new Date().toISOString(),
      vectorIndex.vector_index_ready
    );
  }
  const refreshed = await applyIncrementalChanges(
    table,
    workspacePath,
    indexState,
    repairedVectorIndex,
    embeddingRuntime,
    embeddingReuse
  );
  if (!refreshed.vectorIndex.doc_count) {
    await connection.dropTable(TABLE_NAME);
    return createVectorIndexFile(embeddingRuntime, {}, refreshed.vectorIndex.updated_at, false);
  }
  if (!refreshed.tableChanged && refreshed.vectorIndex.vector_index_ready) {
    return refreshed.vectorIndex;
  }
  await ensureVectorIndex(table);
  return createVectorIndexFile(
    embeddingRuntime,
    refreshed.vectorIndex.docs,
    refreshed.vectorIndex.updated_at,
    true
  );
}

export function createWorkspaceLanceDbVectorRetriever(options: WorkspaceLanceDbVectorRetrieverOptions): DenseRetriever {
  const vectorDbReadPath = options.vectorDbPath ?? getReadableWorkspaceDirectory(options.workspacePath, {
    preferred: VECTOR_DB_DIR_NAME,
    legacy: LEGACY_VECTOR_DB_DIR_NAME,
  });
  const vectorDbWritePath = options.vectorDbPath ?? getPreferredWorkspaceDirectory(options.workspacePath, {
    preferred: VECTOR_DB_DIR_NAME,
    legacy: LEGACY_VECTOR_DB_DIR_NAME,
  });
  const vectorDbPath = options.vectorDbPath ? options.vectorDbPath : migrateLegacyVectorDbPath(vectorDbWritePath, vectorDbReadPath);
  const indexStatePath = options.indexStatePath ?? getReadableWorkspacePath(options.workspacePath, {
    preferred: INDEX_STATE_FILE_NAME,
    legacy: LEGACY_INDEX_STATE_FILE_NAME,
  });
  const vectorIndexReadPath = getReadableWorkspacePath(options.workspacePath, {
    preferred: VECTOR_INDEX_STATE_FILE_NAME,
    legacy: LEGACY_VECTOR_INDEX_STATE_FILE_NAME,
  });
  const vectorIndexWritePath = getPreferredWorkspacePath(options.workspacePath, {
    preferred: VECTOR_INDEX_STATE_FILE_NAME,
    legacy: LEGACY_VECTOR_INDEX_STATE_FILE_NAME,
  });

  return {
    id: `lancedb:${options.embeddingRuntime.id}`,
    async search(query: string, topK: number): Promise<SearchResult[]> {
      const safeTopK = clampTopK(topK);
      const embeddingReuse = getInternalEmbeddingReuse();
      const runSearch = async (): Promise<SearchResult[]> => {
        try {
          await options.embeddingRuntime.prepareForSearch?.();
          const indexState = readIndexState(indexStatePath);
          const existingVectorIndex = readVectorIndex(vectorIndexReadPath, options.embeddingRuntime);
          let refreshedVectorIndex: VectorIndexFile;
          try {
            refreshedVectorIndex = await refreshVectorIndex(
              options.workspacePath,
              vectorDbPath,
              existingVectorIndex,
              indexState,
              options.embeddingRuntime,
              embeddingReuse
            );
          } catch (error) {
            throw toVectorSearchFailure('refresh', error);
          }
          if (shouldPersistVectorIndex(existingVectorIndex, refreshedVectorIndex)) {
            safeWriteJson(vectorIndexWritePath, refreshedVectorIndex);
          }
  
          let connection!: lancedb.Connection;
          try {
            connection = await getConnection(vectorDbPath);
            if (!(await hasTable(connection, TABLE_NAME))) {
              return [];
            }
          } catch (error) {
            throw toVectorSearchFailure('table_load', error);
          }
          let table: lancedb.Table | null;
          try {
            table = await loadTable(connection, TABLE_NAME);
          } catch (error) {
            throw toVectorSearchFailure('table_load', error);
          }
          if (!table) {
            return [];
          }

          const queryLookup = createEmbeddingReuseLookup(
            options.embeddingRuntime,
            'query',
            hashEmbeddingReuseContent(query)
          );
          let queryEmbedding = getReusableEmbeddingVector(embeddingReuse, queryLookup);
          if (!queryEmbedding) {
            try {
              const runtimeVector = await options.embeddingRuntime.embedQuery(query);
              const normalizedQueryEmbedding = normalizeEmbeddingVector(
                runtimeVector,
                options.embeddingRuntime.vectorDimension
              );
              if (!normalizedQueryEmbedding) {
                throw new Error(`Invalid query embedding returned by "${options.embeddingRuntime.id}".`);
              }
              queryEmbedding = normalizedQueryEmbedding;
              setReusableEmbeddingVector(embeddingReuse, queryLookup, queryEmbedding);
            } catch (error) {
              throw toVectorSearchFailure('query_embed', error);
            }
          }

          let rows!: Array<Record<string, unknown>>;
          try {
            rows = await table.vectorSearch(queryEmbedding).limit(safeTopK).toArray();
          } catch (error) {
            throw toVectorSearchFailure('query_search', error);
          }
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
        } finally {
          await embeddingReuse.flush?.();
        }
      };

      try {
        return await runSearch();
      } catch (firstError) {
        if (shouldAttemptNonDestructiveRetry(firstError)) {
          resetVectorConnection(vectorDbPath);
          try {
            return await runSearch();
          } catch (retryError) {
            if (shouldAttemptDestructiveRecovery(firstError) || shouldAttemptDestructiveRecovery(retryError)) {
              removeVectorArtifacts(vectorDbPath);
              try {
                return await runSearch();
              } catch {
                return [];
              }
            }
            return [];
          }
        }
        if (shouldAttemptDestructiveRecovery(firstError)) {
          removeVectorArtifacts(vectorDbPath);
          try {
            return await runSearch();
          } catch {
            return [];
          }
        }
        return [];
      }
    },
  };
}
