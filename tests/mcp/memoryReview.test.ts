import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FEATURE_FLAGS } from '../../src/config/features.js';
import { createDraftSuggestionRecord } from '../../src/mcp/memorySuggestions.js';
import { MemorySuggestionStore } from '../../src/mcp/memorySuggestionStore.js';
import { handleReviewMemorySuggestions } from '../../src/mcp/tools/memoryReview.js';

function createMockServiceClient(workspacePath: string, options?: { failIndex?: boolean }) {
  return {
    getWorkspacePath: () => workspacePath,
    indexFiles: async () => {
      if (options?.failIndex) {
        throw new Error('index follow-up failed');
      }
      return { indexed: 1, skipped: 0, errors: [], duration: 1 };
    },
  } as any;
}

describe('review_memory_suggestions tool', () => {
  const originalFlag = FEATURE_FLAGS.memory_suggestions_v1;

  afterEach(() => {
    FEATURE_FLAGS.memory_suggestions_v1 = originalFlag;
  });

  it('approves a draft by promoting it through the durable memory writer', async () => {
    FEATURE_FLAGS.memory_suggestions_v1 = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-review-promote-'));
    const store = new MemorySuggestionStore(tmp);
    store.saveDraft(
      createDraftSuggestionRecord({
        draft_id: 'draft-1',
        session_id: 'session-1',
        source_type: 'explicit_user_directives',
        source_ref: 'thread://1',
        category: 'decisions',
        title: 'Keep transport additive',
        content: 'Do not rename MCP endpoints while memory mode is rolling out.',
        metadata: {
          priority: 'critical',
          subtype: 'plan_note',
          source: 'user directive',
        },
        score_breakdown: {
          repetition: 1,
          directive_strength: 1,
          source_reliability: 1,
          traceability: 1,
          stability_penalty: 0,
        },
        confidence: 0.94,
      })
    );

    try {
      const response = JSON.parse(
        await handleReviewMemorySuggestions(
          { action: 'approve', session_id: 'session-1' },
          createMockServiceClient(tmp)
        )
      ) as { success: boolean; updated_drafts?: Array<{ state: string }> };

      expect(response.success).toBe(true);
      expect(response.updated_drafts?.[0]?.state).toBe('promoted');

      const storedDraft = store.getDraft('session-1', 'draft-1');
      expect(storedDraft?.state).toBe('promoted');
      expect(storedDraft?.promotion_result?.index_status).toBe('completed');

      const memoryFile = path.join(tmp, '.memories', 'decisions.md');
      expect(fs.existsSync(memoryFile)).toBe(true);
      const content = fs.readFileSync(memoryFile, 'utf-8');
      expect(content).toContain('Keep transport additive');
      expect(content).toContain('Do not rename MCP endpoints while memory mode is rolling out.');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('marks approved drafts as promoted_pending_index when indexing follow-up fails', async () => {
    FEATURE_FLAGS.memory_suggestions_v1 = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-review-pending-index-'));
    const store = new MemorySuggestionStore(tmp);
    store.saveDraft(
      createDraftSuggestionRecord({
        draft_id: 'draft-2',
        session_id: 'session-2',
        source_type: 'review_outputs',
        source_ref: 'review://2',
        category: 'facts',
        content: 'A durable memory write can succeed even if reindexing needs a retry.',
        score_breakdown: {
          repetition: 1,
          directive_strength: 0.8,
          source_reliability: 1,
          traceability: 1,
          stability_penalty: 0,
        },
        confidence: 0.87,
      })
    );

    try {
      const response = JSON.parse(
        await handleReviewMemorySuggestions(
          { action: 'approve', session_id: 'session-2' },
          createMockServiceClient(tmp, { failIndex: true })
        )
      ) as { success: boolean; updated_drafts?: Array<{ state: string }> };

      expect(response.success).toBe(true);
      expect(response.updated_drafts?.[0]?.state).toBe('promoted_pending_index');

      const storedDraft = store.getDraft('session-2', 'draft-2');
      expect(storedDraft?.state).toBe('promoted_pending_index');
      expect(storedDraft?.promotion_result?.index_status).toBe('pending');

      const memoryFile = path.join(tmp, '.memories', 'facts.md');
      expect(fs.existsSync(memoryFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
