import * as fs from 'fs';
import * as path from 'path';
import {
  type DraftSuggestionRecord,
  type DraftSuggestionState,
  transitionDraftSuggestionState,
} from './memorySuggestions.js';
import { assertDraftSuggestionSafeForPersistence } from './memorySuggestionSafety.js';

export const MEMORY_SUGGESTIONS_DIR = '.context-engine-memory-suggestions';
export const DEFAULT_MEMORY_SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000;

export class DraftSuggestionVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftSuggestionVersionConflictError';
  }
}

function sanitizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('session_id is required');
  }
  if (normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error('session_id must be a relative identifier');
  }
  return normalized.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeDraftId(draftId: string): string {
  const normalized = draftId.trim();
  if (!normalized) {
    throw new Error('draft_id is required');
  }
  if (normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error('draft_id must be a relative identifier');
  }
  return normalized.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function isMemorySuggestionPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized === MEMORY_SUGGESTIONS_DIR || normalized.startsWith(`${MEMORY_SUGGESTIONS_DIR}/`);
}

export function getMemorySuggestionStorePath(workspacePath: string): string {
  return path.join(workspacePath, MEMORY_SUGGESTIONS_DIR);
}

function getDraftFilePath(workspacePath: string, sessionId: string, draftId: string): string {
  return path.join(
    getMemorySuggestionStorePath(workspacePath),
    sanitizeSessionId(sessionId),
    `${sanitizeDraftId(draftId)}.json`
  );
}

function ensureDraftParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getDraftLockFilePath(workspacePath: string, sessionId: string, draftId: string): string {
  return `${getDraftFilePath(workspacePath, sessionId, draftId)}.lock`;
}

function tryAcquireDraftLock(lockPath: string): number | null {
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return null;
    }
    throw error;
  }
}

function sleepMs(delayMs: number): void {
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    // Busy wait is acceptable here because the store API is synchronous and used only for
    // short-lived draft transitions in tests/tool handlers.
  }
}

function withDraftLock<T>(
  workspacePath: string,
  sessionId: string,
  draftId: string,
  operation: () => T
): T {
  const lockPath = getDraftLockFilePath(workspacePath, sessionId, draftId);
  ensureDraftParentDir(lockPath);

  const startedAt = Date.now();
  while (true) {
    const lockFd = tryAcquireDraftLock(lockPath);
    if (lockFd !== null) {
      try {
        return operation();
      } finally {
        fs.closeSync(lockFd);
        fs.rmSync(lockPath, { force: true });
      }
    }

    if (Date.now() - startedAt > 2_000) {
      throw new Error(`Timed out waiting for draft lock: ${sessionId}/${draftId}`);
    }
    sleepMs(10);
  }
}

function normalizeStoredRecord(record: DraftSuggestionRecord): DraftSuggestionRecord {
  return {
    ...record,
    store_version: typeof record.store_version === 'number' && Number.isFinite(record.store_version)
      ? record.store_version
      : 1,
  };
}

export class MemorySuggestionStore {
  constructor(
    private readonly workspacePath: string,
    private readonly ttlMs: number = DEFAULT_MEMORY_SUGGESTION_TTL_MS
  ) {}

  getStorePath(): string {
    return getMemorySuggestionStorePath(this.workspacePath);
  }

  saveDraft(record: DraftSuggestionRecord): string {
    assertDraftSuggestionSafeForPersistence(record);
    const filePath = getDraftFilePath(this.workspacePath, record.session_id, record.draft_id);
    ensureDraftParentDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(normalizeStoredRecord(record), null, 2)}\n`, 'utf-8');
    return filePath;
  }

  getDraft(sessionId: string, draftId: string): DraftSuggestionRecord | null {
    const filePath = getDraftFilePath(this.workspacePath, sessionId, draftId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return normalizeStoredRecord(JSON.parse(raw) as DraftSuggestionRecord);
  }

  listDrafts(sessionId?: string): DraftSuggestionRecord[] {
    const storePath = this.getStorePath();
    if (!fs.existsSync(storePath)) {
      return [];
    }

    const sessionDirs = sessionId
      ? [sanitizeSessionId(sessionId)]
      : fs.readdirSync(storePath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);

    const drafts: DraftSuggestionRecord[] = [];
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(storePath, sessionDir);
      if (!fs.existsSync(sessionPath)) {
        continue;
      }
      const entries = fs.readdirSync(sessionPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name) !== '.json') {
          continue;
        }
        const filePath = path.join(sessionPath, entry.name);
        const raw = fs.readFileSync(filePath, 'utf-8');
        drafts.push(normalizeStoredRecord(JSON.parse(raw) as DraftSuggestionRecord));
      }
    }

    return drafts.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  compareAndSetDraftState(args: {
    sessionId: string;
    draftId: string;
    expectedVersion: number;
    nextState: DraftSuggestionState;
    updatedAt?: string;
    reviewedAt?: string;
  }): DraftSuggestionRecord {
    const { sessionId, draftId, expectedVersion, nextState, updatedAt, reviewedAt } = args;
    return withDraftLock(this.workspacePath, sessionId, draftId, () => {
      const current = this.getDraft(sessionId, draftId);
      if (!current) {
        throw new Error(`Draft not found: ${sessionId}/${draftId}`);
      }
      if ((current.store_version ?? 0) !== expectedVersion) {
        throw new DraftSuggestionVersionConflictError(
          `Draft version mismatch for ${sessionId}/${draftId}: expected ${expectedVersion}, got ${current.store_version ?? 0}`
        );
      }

      const transitioned = transitionDraftSuggestionState(current, nextState, {
        updated_at: updatedAt,
        reviewed_at: reviewedAt,
      });
      const nextRecord = normalizeStoredRecord({
        ...transitioned,
        store_version: expectedVersion + 1,
      });
      this.saveDraft(nextRecord);
      return nextRecord;
    });
  }

  promoteDraftOnce<T>(args: {
    sessionId: string;
    draftId: string;
    idempotencyKey: string;
    promote: (draft: DraftSuggestionRecord) => T;
    nextState?: 'promoted' | 'promoted_pending_index';
    indexStatus?: 'completed' | 'pending';
    updatedAt?: string;
  }): { record: DraftSuggestionRecord; result: T; promoted: boolean } {
    const {
      sessionId,
      draftId,
      idempotencyKey,
      promote,
      nextState = 'promoted',
      indexStatus = nextState === 'promoted' ? 'completed' : 'pending',
      updatedAt,
    } = args;
    if (!idempotencyKey.trim()) {
      throw new Error('promotion idempotency key is required');
    }

    return withDraftLock(this.workspacePath, sessionId, draftId, () => {
      const current = this.getDraft(sessionId, draftId);
      if (!current) {
        throw new Error(`Draft not found: ${sessionId}/${draftId}`);
      }

      const currentPromotionKey = current.promotion_result?.promotion_idempotency_key;
      if (
        (current.state === 'promoted' || current.state === 'promoted_pending_index') &&
        currentPromotionKey === idempotencyKey
      ) {
        return {
          record: current,
          result: undefined as T,
          promoted: false,
        };
      }

      if (current.state === 'promoted' || current.state === 'promoted_pending_index') {
        throw new DraftSuggestionVersionConflictError(
          `Draft ${sessionId}/${draftId} is already promoted with a different idempotency key`
        );
      }

      if (current.state !== 'reviewed') {
        throw new DraftSuggestionVersionConflictError(
          `Draft ${sessionId}/${draftId} must be reviewed before promotion; current state is ${current.state}`
        );
      }

      const result = promote(current);
      const transitioned = transitionDraftSuggestionState(current, nextState, {
        updated_at: updatedAt,
        reviewed_at: current.reviewed_at ?? updatedAt,
        promotion_result: {
          promoted_at: updatedAt ?? new Date().toISOString(),
          state: nextState,
          index_status: indexStatus,
        },
      });

      const nextRecord = normalizeStoredRecord({
        ...transitioned,
        store_version: (current.store_version ?? 0) + 1,
        promotion_result: transitioned.promotion_result
          ? {
              ...transitioned.promotion_result,
              promotion_idempotency_key: idempotencyKey,
            }
          : undefined,
      });
      this.saveDraft(nextRecord);
      return {
        record: nextRecord,
        result,
        promoted: true,
      };
    });
  }

  cleanupExpired(now: Date = new Date()): { expired: number; removedFiles: string[] } {
    const cutoff = now.getTime();
    const removedFiles: string[] = [];
    const drafts = this.listDrafts();

    for (const draft of drafts) {
      const expiresAt = draft.expires_at ? Date.parse(draft.expires_at) : Date.parse(draft.updated_at) + this.ttlMs;
      if (Number.isNaN(expiresAt) || expiresAt > cutoff) {
        continue;
      }

      const filePath = getDraftFilePath(this.workspacePath, draft.session_id, draft.draft_id);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const expiredRecord = transitionDraftSuggestionState(draft, 'expired', {
        updated_at: now.toISOString(),
        expires_at: now.toISOString(),
      });
      fs.writeFileSync(filePath, `${JSON.stringify(expiredRecord, null, 2)}\n`, 'utf-8');
      fs.rmSync(filePath, { force: true });
      removedFiles.push(filePath);

      const sessionPath = path.dirname(filePath);
      if (fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length === 0) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }

    const storePath = this.getStorePath();
    if (fs.existsSync(storePath) && fs.readdirSync(storePath).length === 0) {
      fs.rmSync(storePath, { recursive: true, force: true });
    }

    return { expired: removedFiles.length, removedFiles };
  }
}
