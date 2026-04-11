import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDraftSuggestionRecord } from '../../src/mcp/memorySuggestions.js';
import {
  DraftSuggestionVersionConflictError,
  getMemorySuggestionStorePath,
  isMemorySuggestionPath,
  MemorySuggestionStore,
} from '../../src/mcp/memorySuggestionStore.js';

describe('MemorySuggestionStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores drafts outside .memories and keeps session-scoped files under the suggestion store', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestions-'));
    tempDirs.push(tempDir);
    const store = new MemorySuggestionStore(tempDir);
    const draft = createDraftSuggestionRecord({
      draft_id: 'draft-1',
      session_id: 'session-1',
      source_type: 'plan',
      source_ref: 'plans/123',
      category: 'decisions',
      content: 'Keep drafts isolated from durable memory storage.',
      score_breakdown: {
        repetition: 1,
        directive_strength: 1,
        source_reliability: 0.8,
        traceability: 1,
        stability_penalty: 0,
      },
      confidence: 0.95,
      created_at: '2026-04-11T00:00:00.000Z',
    });

    const savedPath = store.saveDraft(draft);
    const persistedDraft = store.getDraft('session-1', 'draft-1');

    expect(savedPath).toContain('.context-engine-memory-suggestions');
    expect(savedPath).not.toContain(`${path.sep}.memories${path.sep}`);
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(persistedDraft?.store_version).toBe(0);
    expect(getMemorySuggestionStorePath(tempDir)).toBe(path.join(tempDir, '.context-engine-memory-suggestions'));
    expect(isMemorySuggestionPath('.context-engine-memory-suggestions/session-1/draft-1.json')).toBe(true);
    expect(isMemorySuggestionPath('.memories/decisions.md')).toBe(false);
  });

  it('expires and cleans up stale drafts deterministically', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestions-ttl-'));
    tempDirs.push(tempDir);
    const store = new MemorySuggestionStore(tempDir, 60_000);
    const draft = createDraftSuggestionRecord({
      draft_id: 'draft-2',
      session_id: 'session-cleanup',
      source_type: 'review',
      source_ref: 'reviews/7',
      category: 'facts',
      content: 'This draft should expire.',
      score_breakdown: {
        repetition: 0.5,
        directive_strength: 0.4,
        source_reliability: 0.9,
        traceability: 1,
        stability_penalty: 0.1,
      },
      confidence: 0.7,
      created_at: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
    });

    const savedPath = store.saveDraft(draft);
    const cleanup = store.cleanupExpired(new Date('2026-04-11T00:02:00.000Z'));

    expect(cleanup.expired).toBe(1);
    expect(cleanup.removedFiles).toContain(savedPath);
    expect(fs.existsSync(savedPath)).toBe(false);
    expect(store.listDrafts()).toEqual([]);
    expect(fs.existsSync(getMemorySuggestionStorePath(tempDir))).toBe(false);
  });

  it('uses monotonic store versions for atomic compare-and-set transitions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestions-cas-'));
    tempDirs.push(tempDir);
    const store = new MemorySuggestionStore(tempDir);
    const draft = createDraftSuggestionRecord({
      draft_id: 'draft-cas',
      session_id: 'session-cas',
      source_type: 'review',
      source_ref: 'reviews/17',
      category: 'decisions',
      content: 'Require reviewed state before promotion.',
      score_breakdown: {
        repetition: 1,
        directive_strength: 1,
        source_reliability: 1,
        traceability: 1,
        stability_penalty: 0,
      },
      confidence: 0.98,
      created_at: '2026-04-11T00:00:00.000Z',
    });

    store.saveDraft(draft);
    const batched = store.compareAndSetDraftState({
      sessionId: 'session-cas',
      draftId: 'draft-cas',
      expectedVersion: 0,
      nextState: 'batched',
      updatedAt: '2026-04-11T00:01:00.000Z',
    });

    expect(batched.store_version).toBe(1);
    let staleWriteError: unknown;
    try {
      store.compareAndSetDraftState({
        sessionId: 'session-cas',
        draftId: 'draft-cas',
        expectedVersion: 0,
        nextState: 'reviewed',
        updatedAt: '2026-04-11T00:02:00.000Z',
      });
    } catch (error) {
      staleWriteError = error;
    }
    expect(staleWriteError).toBeInstanceOf(DraftSuggestionVersionConflictError);
    expect((staleWriteError as Error | undefined)?.message).toBe(
      'Draft version mismatch for session-cas/draft-cas: expected 0, got 1'
    );
  });

  it('guards promotion with an idempotency key so duplicate approvals do not double-write', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-suggestions-promote-'));
    tempDirs.push(tempDir);
    const store = new MemorySuggestionStore(tempDir);
    const draft = createDraftSuggestionRecord({
      draft_id: 'draft-promote',
      session_id: 'session-promote',
      source_type: 'review',
      source_ref: 'reviews/18',
      category: 'decisions',
      content: 'Promote only once per idempotency key.',
      score_breakdown: {
        repetition: 1,
        directive_strength: 1,
        source_reliability: 1,
        traceability: 1,
        stability_penalty: 0,
      },
      confidence: 0.99,
      created_at: '2026-04-11T00:00:00.000Z',
    });

    store.saveDraft(draft);
    store.compareAndSetDraftState({
      sessionId: 'session-promote',
      draftId: 'draft-promote',
      expectedVersion: 0,
      nextState: 'batched',
      updatedAt: '2026-04-11T00:01:00.000Z',
    });
    store.compareAndSetDraftState({
      sessionId: 'session-promote',
      draftId: 'draft-promote',
      expectedVersion: 1,
      nextState: 'reviewed',
      reviewedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2026-04-11T00:02:00.000Z',
    });

    let durableWriteCount = 0;
    const first = store.promoteDraftOnce({
      sessionId: 'session-promote',
      draftId: 'draft-promote',
      idempotencyKey: 'promotion-batch-1',
      updatedAt: '2026-04-11T00:03:00.000Z',
      promote: (record) => {
        durableWriteCount += 1;
        return { category: record.category, content: record.content };
      },
    });
    const second = store.promoteDraftOnce({
      sessionId: 'session-promote',
      draftId: 'draft-promote',
      idempotencyKey: 'promotion-batch-1',
      updatedAt: '2026-04-11T00:04:00.000Z',
      promote: () => {
        durableWriteCount += 1;
        return { category: 'decisions', content: 'should never be written twice' };
      },
    });
    expect(() =>
      store.promoteDraftOnce({
        sessionId: 'session-promote',
        draftId: 'draft-promote',
        idempotencyKey: 'promotion-batch-2',
        updatedAt: '2026-04-11T00:05:00.000Z',
        promote: () => {
          durableWriteCount += 1;
          return { category: 'decisions', content: 'should never be written with a different key either' };
        },
      })
    ).toThrow(DraftSuggestionVersionConflictError);

    expect(first.promoted).toBe(true);
    expect(first.record.state).toBe('promoted');
    expect(first.record.store_version).toBe(3);
    expect(first.record.promotion_result?.promotion_idempotency_key).toBe('promotion-batch-1');
    expect(second.promoted).toBe(false);
    expect(durableWriteCount).toBe(1);
    expect(store.getDraft('session-promote', 'draft-promote')?.promotion_result?.promotion_idempotency_key).toBe(
      'promotion-batch-1'
    );
  });
});
