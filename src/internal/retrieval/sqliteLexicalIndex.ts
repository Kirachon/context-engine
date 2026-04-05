import * as crypto from 'crypto';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
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
import {
  computeExactMatchBoost,
  normalizeSearchText,
  tokenizeSearchInput,
} from './searchHeuristics.js';

const SQLITE_INDEX_FILE_NAME = '.context-engine-lexical-index.sqlite';
const LEGACY_SQLITE_INDEX_FILE_NAME = '.augment-lexical-index.sqlite';
const INDEX_STATE_FILE_NAME = '.context-engine-index-state.json';
const LEGACY_INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_MAX_CHUNK_LINES = 80;
const DEFAULT_MAX_CHUNK_CHARS = 4_000;
const DEFAULT_SNIPPET_MAX_CHARS = 1_200;
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.cache',
  '.turbo',
  '.angular',
  '.parcel-cache',
  '.webpack',
  '.rollup.cache',
  '.idea',
  '.vscode',
  '.vs',
  '.context-engine',
  '.augment',
  'tmp',
  'temp',
  '.tmp',
  '.temp',
  'logs',
]);

const INDEXABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.m',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.graphql',
  '.proto',
  '.sql',
  '.sh',
  '.ps1',
  '.tf',
]);

const INDEXABLE_FILES_BY_NAME = new Set([
  'Dockerfile',
  'Makefile',
  'README',
  'README.md',
  'README.txt',
]);

interface IndexStateEntry {
  hash: string;
  indexed_at?: string;
  indexedAt?: string;
}

interface IndexStateFile {
  files: Record<string, IndexStateEntry>;
}

interface SqliteLexicalIndexFileRecord {
  path: string;
  hash: string;
  indexed_at: string;
}

export interface WorkspaceSqliteLexicalIndexOptions {
  workspacePath: string;
  indexStatePath?: string;
  sqlitePath?: string;
  sqliteIndexPath?: string;
  maxChunkLines?: number;
  maxChunkChars?: number;
  chunkParserFactory?: () => ChunkParser | null;
}

export interface WorkspaceSqliteLexicalIndexChange {
  type: 'add' | 'change' | 'unlink';
  path: string;
}

export interface SqliteLexicalSearchOptions {
  bypassCache?: boolean;
}

export interface SqliteLexicalIndexRefreshStats {
  refreshedFiles: number;
  reusedFiles: number;
  removedFiles: number;
  totalFiles: number;
  totalChunks: number;
  wroteIndex: boolean;
}

export interface WorkspaceSqliteLexicalIndex {
  id: string;
  refresh: () => Promise<SqliteLexicalIndexRefreshStats>;
  applyWorkspaceChanges?: (changes: WorkspaceSqliteLexicalIndexChange[]) => Promise<SqliteLexicalIndexRefreshStats>;
  search: (query: string, topK: number, options?: SqliteLexicalSearchOptions) => Promise<SearchResult[]>;
  clearCache?: () => void;
  getSnapshot: () => {
    version: number;
    updatedAt: string | null;
    fileCount: number;
    chunkCount: number;
    workspaceFingerprint: string;
    parser: { id: string; version: number };
    dbPath: string;
  };
}

type SqliteModule = {
  DatabaseSync: new (pathValue: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      all: (...params: unknown[]) => any[];
      get: (...params: unknown[]) => any;
      run: (...params: unknown[]) => void;
    };
    close: () => void;
  };
};

type DatabaseSyncInstance = InstanceType<SqliteModule['DatabaseSync']>;

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

function resolveChunkParser(options: WorkspaceSqliteLexicalIndexOptions): ChunkParser {
  try {
    if (typeof options.chunkParserFactory === 'function') {
      const customParser = options.chunkParserFactory();
      if (customParser) {
        return customParser;
      }
    }
  } catch {
    // ignore and fall back to default parser
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

function isBinaryContent(content: string): boolean {
  const nonPrintableCount = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  const ratio = nonPrintableCount / Math.max(1, content.length);
  return ratio > 0.1 || content.includes('\x00');
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
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

function readIndexState(filePath: string): IndexStateFile {
  const parsed = safeReadJson<Partial<IndexStateFile>>(filePath, {});
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
    return { files: {} };
  }
  return { files: parsed.files as Record<string, IndexStateEntry> };
}

async function discoverFiles(workspacePath: string, relativeTo: string = workspacePath): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(workspacePath, entry.name);
    const relativePath = path.relative(relativeTo, fullPath);
    const sanitized = sanitizePath(relativePath);
    if (!sanitized) {
      continue;
    }
    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      const subFiles = await discoverFiles(fullPath, relativeTo);
      files.push(...subFiles);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.startsWith('.')) {
      if (!INDEXABLE_FILES_BY_NAME.has(entry.name)) {
        continue;
      }
    }
    if (entry.name.startsWith('.context-engine-') || entry.name.startsWith('.augment-')) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext && INDEXABLE_EXTENSIONS.has(ext)) {
      files.push(sanitized);
      continue;
    }
    if (INDEXABLE_FILES_BY_NAME.has(entry.name)) {
      files.push(sanitized);
    }
  }
  return files;
}

function buildSnippetFallback(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars).trimEnd();
}

function countRows(
  db: DatabaseSyncInstance,
  tableName: 'lexical_files' | 'lexical_fts'
): number {
  const row = db.prepare(`SELECT count(*) as count FROM ${tableName}`).get() as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

function computeScore(rawScore: unknown): number {
  if (typeof rawScore !== 'number' || Number.isNaN(rawScore)) {
    return 0;
  }
  if (rawScore <= 0) {
    return 1;
  }
  return 1 / (1 + rawScore);
}

function computeLexicalRank(params: {
  query: string;
  path: string;
  content: string;
  lines?: string;
  chunkId?: string;
  rawScore?: number;
}): number {
  const baseScore = typeof params.rawScore === 'number' ? computeScore(params.rawScore) : 0;
  const exactBoost = computeExactMatchBoost({
    query: params.query,
    path: params.path,
    content: params.content,
    lines: params.lines,
    chunkId: params.chunkId,
  });
  const queryTokens = tokenizeSearchInput(params.query);
  const normalizedContent = normalizeSearchText(params.content);
  const normalizedPath = params.path.toLowerCase();

  let tokenBoost = 0;
  for (const token of queryTokens) {
    if (normalizedPath.includes(token)) {
      tokenBoost += 0.8;
    }
    if (normalizedContent.includes(token)) {
      tokenBoost += 0.5;
    }
  }

  return baseScore + exactBoost + tokenBoost;
}

function createSchema(db: DatabaseSyncInstance): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS lexical_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lexical_files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS lexical_fts USING fts5(
      path,
      chunk_id,
      lines,
      content,
      tokenize = 'porter'
    );
  `);
}

export function createWorkspaceLexicalSearchIndex(
  options: WorkspaceSqliteLexicalIndexOptions
): WorkspaceSqliteLexicalIndex {
  const workspacePath = path.resolve(options.workspacePath);
  const indexStatePath = options.indexStatePath ?? getReadableWorkspacePath(workspacePath, {
    preferred: INDEX_STATE_FILE_NAME,
    legacy: LEGACY_INDEX_STATE_FILE_NAME,
  });
  const sqlitePath = options.sqlitePath ?? options.sqliteIndexPath ?? getPreferredWorkspacePath(workspacePath, {
    preferred: SQLITE_INDEX_FILE_NAME,
    legacy: LEGACY_SQLITE_INDEX_FILE_NAME,
  });
  const readableSqlitePath = options.sqlitePath ?? options.sqliteIndexPath ?? getReadableWorkspacePath(workspacePath, {
    preferred: SQLITE_INDEX_FILE_NAME,
    legacy: LEGACY_SQLITE_INDEX_FILE_NAME,
  });
  const chunkParser = resolveChunkParser(options);
  const workspaceFingerprint = buildWorkspaceFingerprint(workspacePath);
  const maxChunkLines = options.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES;
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

  let dbPromise: Promise<DatabaseSyncInstance> | null = null;
  let dbInstance: DatabaseSyncInstance | null = null;
  let lastSnapshot = {
    version: INDEX_SCHEMA_VERSION,
    updatedAt: null as string | null,
    fileCount: 0,
    chunkCount: 0,
  };
  let initialized = false;

  const resetDbState = (): void => {
    if (dbInstance) {
      try {
        dbInstance.close();
      } catch {
        // ignore close errors
      } finally {
        dbInstance = null;
      }
    }
    if (dbPromise) {
      dbPromise
        .then((db) => {
          try {
            db.close();
          } catch {
            // ignore close errors
          }
        })
        .catch(() => {
          // ignore promise cleanup failures
        });
    }
    dbPromise = null;
    initialized = false;
    lastSnapshot = {
      version: INDEX_SCHEMA_VERSION,
      updatedAt: null,
      fileCount: 0,
      chunkCount: 0,
    };
  };

  const removeSqliteArtifact = (): void => {
    try {
      if (fs.existsSync(sqlitePath)) {
        fs.unlinkSync(sqlitePath);
      }
    } catch {
      // ignore delete failures; recovery can still continue on a fresh path
    }
  };

  const recoverFromCorruptDb = (): void => {
    resetDbState();
    removeSqliteArtifact();
  };

  const ensureDb = async (): Promise<DatabaseSyncInstance> => {
    if (!dbPromise) {
      dbPromise = (async () => {
        const openDb = (): DatabaseSyncInstance => {
          const nodeRequire = createRequire(import.meta.url);
          const moduleExports = nodeRequire('node:sqlite') as unknown;
          const sqliteModule = moduleExports as SqliteModule;
          const db = new sqliteModule.DatabaseSync(sqlitePath);
          try {
            createSchema(db);
            dbInstance = db;
            return db;
          } catch (error) {
            try {
              db.close();
            } catch {
              // ignore close errors while recovering from a corrupt artifact
            }
            throw error;
          }
        };

        try {
          if (
            !options.sqlitePath &&
            !options.sqliteIndexPath &&
            readableSqlitePath !== sqlitePath &&
            fs.existsSync(readableSqlitePath)
          ) {
            try {
              fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
              fs.copyFileSync(readableSqlitePath, sqlitePath);
            } catch {
              // Best-effort migration only; fall through to the readable path if copy fails.
            }
          }
          return openDb();
        } catch {
          recoverFromCorruptDb();
          return openDb();
        }
      })().catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  };

  const loadExistingFileMap = (db: DatabaseSyncInstance): Map<string, SqliteLexicalIndexFileRecord> => {
    const rows = db.prepare('SELECT path, hash, indexed_at FROM lexical_files').all() as SqliteLexicalIndexFileRecord[];
    const map = new Map<string, SqliteLexicalIndexFileRecord>();
    for (const row of rows) {
      map.set(row.path, row);
    }
    return map;
  };

  const deleteFileFromIndex = (db: DatabaseSyncInstance, filePath: string): void => {
    db.prepare('DELETE FROM lexical_fts WHERE path = ?').run(filePath);
    db.prepare('DELETE FROM lexical_files WHERE path = ?').run(filePath);
  };

  const indexFileContents = async (
    db: DatabaseSyncInstance,
    filePath: string,
    content: string,
    indexedAtIso: string,
    hashValue?: string
  ): Promise<number> => {
    if (!content.trim() || isBinaryContent(content)) {
      deleteFileFromIndex(db, filePath);
      return 0;
    }

    const chunks = chunkParser.parse(content, {
      path: filePath,
      maxChunkLines,
      maxChunkChars,
    });
    deleteFileFromIndex(db, filePath);
    for (const chunk of chunks) {
      db.prepare('INSERT INTO lexical_fts (path, chunk_id, lines, content) VALUES (?, ?, ?, ?)').run(
        chunk.path,
        chunk.chunkId,
        chunk.lines,
        chunk.content
      );
    }
    db.prepare('INSERT OR REPLACE INTO lexical_files (path, hash, indexed_at) VALUES (?, ?, ?)').run(
      filePath,
      hashValue ?? hashContent(content),
      indexedAtIso
    );
    return chunks.length;
  };

  const indexFileFromDisk = async (
    db: DatabaseSyncInstance,
    filePath: string,
    indexedAtIso: string,
    expectedHash?: string
  ): Promise<number> => {
    const absolutePath = path.join(workspacePath, filePath);
    try {
      const stats = await fs.promises.stat(absolutePath);
      if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) {
        deleteFileFromIndex(db, filePath);
        return 0;
      }
      const content = await fs.promises.readFile(absolutePath, 'utf8');
      if (expectedHash) {
        const currentHash = hashContent(content);
        if (currentHash !== expectedHash) {
          return indexFileContents(db, filePath, content, indexedAtIso, currentHash);
        }
      }
      return indexFileContents(db, filePath, content, indexedAtIso, expectedHash);
    } catch {
      deleteFileFromIndex(db, filePath);
      return 0;
    }
  };

  const writeMetadataSnapshot = (db: DatabaseSyncInstance, updatedAtIso: string): void => {
    db.prepare('INSERT OR REPLACE INTO lexical_meta (key, value) VALUES (?, ?)').run('updated_at', updatedAtIso);
    db.prepare('INSERT OR REPLACE INTO lexical_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(INDEX_SCHEMA_VERSION)
    );
    db.prepare('INSERT OR REPLACE INTO lexical_meta (key, value) VALUES (?, ?)').run(
      'workspace_fingerprint',
      workspaceFingerprint
    );
    db.prepare('INSERT OR REPLACE INTO lexical_meta (key, value) VALUES (?, ?)').run('parser_id', chunkParser.id);
    db.prepare('INSERT OR REPLACE INTO lexical_meta (key, value) VALUES (?, ?)').run(
      'parser_version',
      String(chunkParser.version)
    );
  };

  const syncSnapshotFromDb = (db: DatabaseSyncInstance): void => {
    const metadataRow = db.prepare('SELECT value FROM lexical_meta WHERE key = ?').get('updated_at') as { value?: string } | undefined;
    lastSnapshot = {
      version: INDEX_SCHEMA_VERSION,
      updatedAt: metadataRow?.value ?? null,
      fileCount: countRows(db, 'lexical_files'),
      chunkCount: countRows(db, 'lexical_fts'),
    };
    initialized = true;
  };

  const resolveWorkspaceFiles = async (): Promise<Map<string, string>> => {
    const state = readIndexState(indexStatePath);
    if (state.files && Object.keys(state.files).length > 0) {
      const map = new Map<string, string>();
      for (const [rawPath, entry] of Object.entries(state.files)) {
        const sanitized = sanitizePath(rawPath);
        if (!sanitized || !entry?.hash) continue;
        const fullPath = path.join(workspacePath, sanitized);
        if (!fs.existsSync(fullPath)) continue;
        map.set(sanitized, entry.hash);
      }
      if (map.size > 0) {
        return map;
      }
    }

    const discovered = await discoverFiles(workspacePath);
    const map = new Map<string, string>();
    for (const relativePath of discovered) {
      const fullPath = path.join(workspacePath, relativePath);
      try {
        const stats = await fs.promises.stat(fullPath);
        if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) continue;
        const content = await fs.promises.readFile(fullPath, 'utf8');
        if (!content.trim() || isBinaryContent(content)) continue;
        map.set(relativePath, hashContent(content));
      } catch {
        // ignore missing files
      }
    }
    return map;
  };

  const refresh = async (): Promise<SqliteLexicalIndexRefreshStats> => {
    const runRefresh = async (): Promise<SqliteLexicalIndexRefreshStats> => {
      const db = await ensureDb();
      const existingFiles = loadExistingFileMap(db);
      const workspaceFiles = await resolveWorkspaceFiles();
      const refreshedFiles: Array<{ path: string; hash: string }> = [];
      let reusedFiles = 0;
      let removedFiles = 0;
      let totalChunks = 0;

      for (const [pathValue] of existingFiles.entries()) {
        if (!workspaceFiles.has(pathValue)) {
          db.prepare('DELETE FROM lexical_fts WHERE path = ?').run(pathValue);
          db.prepare('DELETE FROM lexical_files WHERE path = ?').run(pathValue);
          removedFiles += 1;
        }
      }

      for (const [pathValue, hashValue] of workspaceFiles.entries()) {
        const existing = existingFiles.get(pathValue);
        if (existing && existing.hash === hashValue) {
          reusedFiles += 1;
          continue;
        }
        refreshedFiles.push({ path: pathValue, hash: hashValue });
      }

      for (const fileEntry of refreshedFiles) {
        await indexFileFromDisk(db, fileEntry.path, new Date().toISOString(), fileEntry.hash);
      }

      const fileCount = workspaceFiles.size;
      if (refreshedFiles.length > 0 || removedFiles > 0) {
        writeMetadataSnapshot(db, new Date().toISOString());
      }

      syncSnapshotFromDb(db);
      totalChunks = lastSnapshot.chunkCount;

      return {
        refreshedFiles: refreshedFiles.length,
        reusedFiles,
        removedFiles,
        totalFiles: fileCount,
        totalChunks,
        wroteIndex: refreshedFiles.length > 0 || removedFiles > 0,
      };
    };

    try {
      return await runRefresh();
    } catch {
      recoverFromCorruptDb();
      return runRefresh();
    }
  };

  const applyWorkspaceChanges = async (
    changes: WorkspaceSqliteLexicalIndexChange[]
  ): Promise<SqliteLexicalIndexRefreshStats> => {
    const runApply = async (): Promise<SqliteLexicalIndexRefreshStats> => {
      const db = await ensureDb();
      const existingFiles = loadExistingFileMap(db);
      const latestByPath = new Map<string, WorkspaceSqliteLexicalIndexChange['type']>();
      for (const change of changes) {
        if (!change || typeof change.path !== 'string') {
          continue;
        }
        if (change.type !== 'add' && change.type !== 'change' && change.type !== 'unlink') {
          continue;
        }
        const sanitized = sanitizePath(change.path);
        if (!sanitized) {
          continue;
        }
        latestByPath.set(sanitized, change.type);
      }

      if (latestByPath.size === 0) {
        syncSnapshotFromDb(db);
        return {
          refreshedFiles: 0,
          reusedFiles: 0,
          removedFiles: 0,
          totalFiles: lastSnapshot.fileCount,
          totalChunks: lastSnapshot.chunkCount,
          wroteIndex: false,
        };
      }

      const indexedAtIso = new Date().toISOString();
      let refreshedFiles = 0;
      let reusedFiles = 0;
      let removedFiles = 0;

      for (const [filePath, changeType] of latestByPath.entries()) {
        if (changeType === 'unlink') {
          if (existingFiles.has(filePath)) {
            deleteFileFromIndex(db, filePath);
            existingFiles.delete(filePath);
            removedFiles += 1;
          }
          continue;
        }

        const absolutePath = path.join(workspacePath, filePath);
        try {
          const stats = await fs.promises.stat(absolutePath);
          if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) {
            if (existingFiles.has(filePath)) {
              deleteFileFromIndex(db, filePath);
              existingFiles.delete(filePath);
              removedFiles += 1;
            }
            continue;
          }

          const content = await fs.promises.readFile(absolutePath, 'utf8');
          if (!content.trim() || isBinaryContent(content)) {
            if (existingFiles.has(filePath)) {
              deleteFileFromIndex(db, filePath);
              existingFiles.delete(filePath);
              removedFiles += 1;
            }
            continue;
          }

          const nextHash = hashContent(content);
          const existing = existingFiles.get(filePath);
          if (existing && existing.hash === nextHash) {
            reusedFiles += 1;
            continue;
          }

          await indexFileContents(db, filePath, content, indexedAtIso, nextHash);
          existingFiles.set(filePath, { path: filePath, hash: nextHash, indexed_at: indexedAtIso });
          refreshedFiles += 1;
        } catch {
          if (existingFiles.has(filePath)) {
            deleteFileFromIndex(db, filePath);
            existingFiles.delete(filePath);
            removedFiles += 1;
          }
        }
      }

      if (refreshedFiles > 0 || removedFiles > 0) {
        writeMetadataSnapshot(db, indexedAtIso);
      }
      syncSnapshotFromDb(db);

      return {
        refreshedFiles,
        reusedFiles,
        removedFiles,
        totalFiles: lastSnapshot.fileCount,
        totalChunks: lastSnapshot.chunkCount,
        wroteIndex: refreshedFiles > 0 || removedFiles > 0,
      };
    };

    try {
      return await runApply();
    } catch {
      recoverFromCorruptDb();
      return runApply();
    }
  };

  const search = async (query: string, topK: number, _options?: SqliteLexicalSearchOptions): Promise<SearchResult[]> => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const runSearch = async (): Promise<SearchResult[]> => {
      const db = await ensureDb();
      if (!initialized) {
        await refresh();
      }

      const limit = clampTopK(topK);
      const rows = db.prepare(
        `SELECT path, chunk_id, lines, content, snippet(lexical_fts, 3, '', '', ' … ', 16) AS snippet, bm25(lexical_fts) AS score\n       FROM lexical_fts\n       WHERE lexical_fts MATCH ?\n       ORDER BY score\n       LIMIT ?`
      ).all(normalizedQuery, limit) as Array<{
        path: string;
        chunk_id: string;
        lines: string;
        content: string;
        snippet?: string;
        score?: number;
      }>;

      return rows
        .map((row) => {
        const snippet = (row.snippet ?? '').trim();
        const content = snippet || buildSnippetFallback(row.content, DEFAULT_SNIPPET_MAX_CHARS);
        return {
          path: row.path,
          content,
          lines: row.lines,
          chunkId: row.chunk_id,
          matchType: 'keyword' as const,
          score: computeLexicalRank({
            query: normalizedQuery,
            path: row.path,
            content,
            lines: row.lines,
            chunkId: row.chunk_id,
            rawScore: row.score,
          }),
          relevanceScore: 0,
          retrievedAt: new Date().toISOString(),
        };
      })
        .sort((a, b) => {
          if ((b.score ?? 0) !== (a.score ?? 0)) {
            return (b.score ?? 0) - (a.score ?? 0);
          }
          return a.path.localeCompare(b.path);
        })
        .map((result) => ({
          ...result,
          score: Math.max(0, Math.min(1, result.score ?? 0)),
          relevanceScore: Math.max(0, Math.min(1, result.score ?? 0)),
        }));
    };

    try {
      return await runSearch();
    } catch {
      recoverFromCorruptDb();
      try {
        return await runSearch();
      } catch {
        return [];
      }
    }
  };

  const clearCache = (): void => {
    resetDbState();
  };

  const getSnapshot = (): ReturnType<WorkspaceSqliteLexicalIndex['getSnapshot']> => ({
    version: lastSnapshot.version,
    updatedAt: lastSnapshot.updatedAt,
    fileCount: lastSnapshot.fileCount,
    chunkCount: lastSnapshot.chunkCount,
    workspaceFingerprint,
    parser: { id: chunkParser.id, version: chunkParser.version },
    dbPath: sqlitePath,
  });

  return {
    id: 'sqlite-fts5',
    refresh,
    applyWorkspaceChanges,
    search,
    clearCache,
    getSnapshot,
  };
}

export const createWorkspaceSqliteLexicalIndex = createWorkspaceLexicalSearchIndex;
