import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDraftSuggestionRecord, toPromotionPayload } from '../../src/mcp/memorySuggestions.js';
import {
  assertPromotionPayloadSafeForPersistence,
  assessPromotionPayloadSafety,
} from '../../src/mcp/memorySuggestionSafety.js';
import { MemorySuggestionStore } from '../../src/mcp/memorySuggestionStore.js';

describe('memory suggestion safety pipeline', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks secret-bearing drafts before they can be persisted to the suggestion store', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-memory-safety-'));
    tempDirs.push(tempDir);
    const store = new MemorySuggestionStore(tempDir);
    const unsafeDraft = createDraftSuggestionRecord({
      draft_id: 'unsafe-secret-draft',
      session_id: 'session-secret',
      source_type: 'explicit_user_directives',
      source_ref: 'conversation/turn-3',
      category: 'decisions',
      content: `Do not forget this secret: sk-proj-${'a'.repeat(90)}`,
      score_breakdown: {
        repetition: 1,
        directive_strength: 1,
        source_reliability: 1,
        traceability: 0.8,
        stability_penalty: 0,
      },
      confidence: 0.95,
    });

    expect(() => store.saveDraft(unsafeDraft)).toThrow(
      /Draft suggestion blocked by safety pipeline: content:contains_secret/i
    );
    expect(store.listDrafts()).toEqual([]);
  });

  it('blocks disallowed evidence and secrets before promotion reaches the durable memory path', () => {
    const unsafePromotionDraft = createDraftSuggestionRecord({
      draft_id: 'unsafe-promotion-draft',
      session_id: 'session-promotion',
      source_type: 'review_outputs',
      source_ref: 'review/17',
      category: 'facts',
      content: 'Keep the promotion gate strict and evidence-backed.',
      metadata: {
        evidence: [
          '2026-04-11T10:15:30.123Z ERROR DraftPromoter failed',
          '    at promoteDraft (src/mcp/promoter.ts:42:11)',
          '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        ].join('\n'),
        source: `ghp_${'a'.repeat(36)}`,
      },
      score_breakdown: {
        repetition: 0.7,
        directive_strength: 0.95,
        source_reliability: 0.92,
        traceability: 0.8,
        stability_penalty: 0,
      },
      confidence: 0.88,
    });

    const payload = toPromotionPayload(unsafePromotionDraft);
    const assessment = assessPromotionPayloadSafety(payload);

    expect(assessment.safe).toBe(false);
    expect(assessment.issues).toEqual(
      expect.arrayContaining([
        { field: 'source', violation: 'contains_secret' },
        { field: 'evidence', violation: 'raw_log' },
      ])
    );
    expect(() => assertPromotionPayloadSafeForPersistence(payload)).toThrow(
      /Memory promotion blocked by safety pipeline/i
    );
  });
});
