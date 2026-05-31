import fs from 'node:fs';
import path from 'node:path';
import type { ContextPackV3 } from './types/contextPack.js';

export const CONTEXT_PACKS_DIR = '.context-engine/context-packs';
export const CONTEXT_PACK_FILE_EXTENSION = '.context-pack.json';
export const CONTEXT_PACK_INDEX_FILE = 'packs-index.json';
export const DEFAULT_CONTEXT_PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_STORED_CONTEXT_PACKS = 50;
export const CONTEXT_PACK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const VALID_PACK_ID_RE = /^ctxp_[a-f0-9]{16}$/;
const INDEX_VERSION = 1;

export interface ContextPackSummary {
  id: string;
  query: string;
  item_count: number;
  saved_at: string;
  expires_at: string;
}

interface ContextPackIndex {
  version: number;
  packs: ContextPackSummary[];
  last_updated: string;
}

interface StoredContextPackRecord {
  pack: ContextPackV3;
  saved_at: string;
  expires_at: string;
}

export class InvalidContextPackIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContextPackIdError';
  }
}

function assertValidPackId(packId: string): string {
  const normalized = packId.trim();
  if (!VALID_PACK_ID_RE.test(normalized)) {
    throw new InvalidContextPackIdError('Context pack id must match ctxp_<16 hex chars>.');
  }
  return normalized;
}

function assertPackInsideStore(storeDir: string, filePath: string): void {
  const resolvedStore = path.resolve(storeDir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedStore) {
    throw new InvalidContextPackIdError('Invalid context pack storage path.');
  }
  if (!resolvedFile.startsWith(`${resolvedStore}${path.sep}`)) {
    throw new InvalidContextPackIdError('Context pack path escapes store directory.');
  }
}

export function getContextPackStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONTEXT_PACKS_DIR);
}

export function buildContextPackFilePath(storeDir: string, packId: string): string {
  const safeId = assertValidPackId(packId);
  const filePath = path.join(storeDir, `${safeId}${CONTEXT_PACK_FILE_EXTENSION}`);
  assertPackInsideStore(storeDir, filePath);
  return filePath;
}

function buildSummary(record: StoredContextPackRecord): ContextPackSummary {
  return {
    id: record.pack.id,
    query: record.pack.query,
    item_count: record.pack.metadata.item_count,
    saved_at: record.saved_at,
    expires_at: record.expires_at,
  };
}

function readStoredRecord(filePath: string): StoredContextPackRecord | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredContextPackRecord;
    if (!parsed?.pack?.id || typeof parsed.saved_at !== 'string' || typeof parsed.expires_at !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class ContextPackStore {
  private readonly storeDir: string;
  private readonly indexPath: string;
  private cachedIndex: ContextPackIndex | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly ttlMs: number = DEFAULT_CONTEXT_PACK_TTL_MS,
    private readonly maxStoredPacks: number = DEFAULT_MAX_STORED_CONTEXT_PACKS
  ) {
    this.storeDir = getContextPackStorePath(workspaceRoot);
    this.indexPath = path.join(this.storeDir, CONTEXT_PACK_INDEX_FILE);
  }

  getStorePath(): string {
    return this.storeDir;
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
  }

  private loadIndex(): ContextPackIndex {
    if (this.cachedIndex) {
      return this.cachedIndex;
    }

    try {
      if (fs.existsSync(this.indexPath)) {
        const content = fs.readFileSync(this.indexPath, 'utf-8');
        this.cachedIndex = JSON.parse(content) as ContextPackIndex;
        return this.cachedIndex;
      }
    } catch {
      // Fall through to empty index.
    }

    this.cachedIndex = {
      version: INDEX_VERSION,
      packs: [],
      last_updated: new Date(0).toISOString(),
    };
    return this.cachedIndex;
  }

  private saveIndex(index: ContextPackIndex): void {
    this.ensureDirectory();
    const nextIndex: ContextPackIndex = {
      ...index,
      last_updated: new Date().toISOString(),
    };
    fs.writeFileSync(this.indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf-8');
    this.cachedIndex = nextIndex;
  }

  private resolveRecordPath(packId: string): string {
    return buildContextPackFilePath(this.storeDir, packId);
  }

  async save(pack: ContextPackV3, savedAt: Date = new Date()): Promise<void> {
    assertValidPackId(pack.id);
    this.ensureDirectory();

    const saved_at = savedAt.toISOString();
    const expires_at = new Date(savedAt.getTime() + this.ttlMs).toISOString();
    const record: StoredContextPackRecord = {
      pack,
      saved_at,
      expires_at,
    };

    const filePath = this.resolveRecordPath(pack.id);
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');

    const index = this.loadIndex();
    const summary = buildSummary(record);
    const withoutCurrent = index.packs.filter((entry) => entry.id !== pack.id);
    this.saveIndex({
      ...index,
      packs: [summary, ...withoutCurrent],
    });

    this.cleanupStale(savedAt);
  }

  async get(packId: string): Promise<ContextPackV3 | null> {
    assertValidPackId(packId);
    this.cleanupStale();

    const record = readStoredRecord(this.resolveRecordPath(packId));
    if (!record) {
      return null;
    }

    if (Date.parse(record.expires_at) <= Date.now()) {
      await this.delete(packId);
      return null;
    }

    return record.pack;
  }

  async list(limit?: number): Promise<ContextPackSummary[]> {
    this.cleanupStale();

    const packs = [...this.loadIndex().packs].sort(
      (left, right) => Date.parse(right.saved_at) - Date.parse(left.saved_at)
    );

    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      return packs.slice(0, Math.trunc(limit));
    }

    return packs;
  }

  async delete(packId: string): Promise<boolean> {
    assertValidPackId(packId);
    const filePath = this.resolveRecordPath(packId);
    let removed = false;

    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed = true;
    }

    const index = this.loadIndex();
    const nextPacks = index.packs.filter((entry) => entry.id !== packId);
    if (nextPacks.length !== index.packs.length) {
      removed = true;
      this.saveIndex({ ...index, packs: nextPacks });
    }

    if (fs.existsSync(this.storeDir) && fs.readdirSync(this.storeDir).length === 0) {
      fs.rmSync(this.storeDir, { recursive: true, force: true });
      this.cachedIndex = null;
    }

    return removed;
  }

  cleanupStale(now: Date = new Date()): { removed: number; removedPackIds: string[] } {
    const cutoff = now.getTime();
    const removedPackIds: string[] = [];
    const index = this.loadIndex();
    const surviving: ContextPackSummary[] = [];

    for (const summary of index.packs) {
      const expiresAt = Date.parse(summary.expires_at);
      const filePath = this.resolveRecordPath(summary.id);
      const expired = Number.isNaN(expiresAt) || expiresAt <= cutoff;
      const missing = !fs.existsSync(filePath);

      if (expired || missing) {
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
        }
        removedPackIds.push(summary.id);
        continue;
      }

      surviving.push(summary);
    }

    const sorted = surviving.sort(
      (left, right) => Date.parse(right.saved_at) - Date.parse(left.saved_at)
    );
    const overflow = sorted.slice(this.maxStoredPacks);
    const kept = sorted.slice(0, this.maxStoredPacks);

    for (const summary of overflow) {
      const filePath = this.resolveRecordPath(summary.id);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
      removedPackIds.push(summary.id);
    }

    if (removedPackIds.length > 0 || kept.length !== index.packs.length) {
      this.saveIndex({ ...index, packs: kept });
    }

    if (fs.existsSync(this.storeDir) && fs.readdirSync(this.storeDir).length === 0) {
      fs.rmSync(this.storeDir, { recursive: true, force: true });
      this.cachedIndex = null;
    }

    return {
      removed: removedPackIds.length,
      removedPackIds,
    };
  }

  startCleanupTimer(intervalMs: number = CONTEXT_PACK_CLEANUP_INTERVAL_MS): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupStale();
    }, intervalMs);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  stopCleanupTimer(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

let defaultStore: ContextPackStore | null = null;

export function initializeContextPackStore(workspaceRoot: string): ContextPackStore {
  defaultStore = new ContextPackStore(workspaceRoot);
  defaultStore.startCleanupTimer();
  return defaultStore;
}

export function getContextPackStore(): ContextPackStore {
  if (!defaultStore) {
    throw new Error('Context pack store not initialized');
  }
  return defaultStore;
}

export function resetContextPackStoreForTests(): void {
  if (defaultStore) {
    defaultStore.stopCleanupTimer();
  }
  defaultStore = null;
}
