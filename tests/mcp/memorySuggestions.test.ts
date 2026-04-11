import { describe, expect, it } from '@jest/globals';
import {
  canTransitionDraftSuggestion,
  computePromotionPayloadHash,
  createDraftSuggestionRecord,
  toPromotionPayload,
  transitionDraftSuggestionState,
} from '../../src/mcp/memorySuggestions.js';

describe('memorySuggestions', () => {
  const baseInput = {
    draft_id: 'draft-1',
    session_id: 'session-1',
    source_type: 'review',
    source_ref: 'reviews/123',
    category: 'decisions' as const,
    content: ' Keep transport changes additive. ',
    title: 'Transport guardrail',
    metadata: {
      priority: 'critical' as const,
      subtype: 'review_finding',
      tags: [' transport ', 'mcp'],
      linked_files: ['src/http/httpServer.ts'],
      linked_plans: ['vibe-coder-memory-mode-plan'],
      source: 'review_auto',
      evidence: 'review finding #1',
      owner: 'platform-team',
    },
    score_breakdown: {
      repetition: 0.9,
      directive_strength: 1,
      source_reliability: 0.8,
      traceability: 1,
      stability_penalty: 0.1,
    },
    confidence: 0.92,
    created_at: '2026-04-11T00:00:00.000Z',
  };

  it('creates a deterministic promotable draft record', () => {
    const first = createDraftSuggestionRecord(baseInput);
    const second = createDraftSuggestionRecord({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        tags: ['mcp', 'transport'],
      },
    });

    expect(first.state).toBe('drafted');
    expect(first.content).toBe('Keep transport changes additive.');
    expect(first.metadata.tags).toEqual(['mcp', 'transport']);
    expect(first.promotion_payload_hash).toHaveLength(64);
    expect(first.promotion_payload_hash).toBe(second.promotion_payload_hash);
    expect(toPromotionPayload(first)).toMatchObject({
      category: 'decisions',
      content: 'Keep transport changes additive.',
      title: 'Transport guardrail',
      subtype: 'review_finding',
      priority: 'critical',
    });
  });

  it('supports deterministic lifecycle transitions including pending index state', () => {
    const drafted = createDraftSuggestionRecord(baseInput);
    const batched = transitionDraftSuggestionState(drafted, 'batched', {
      updated_at: '2026-04-11T00:05:00.000Z',
    });
    const reviewed = transitionDraftSuggestionState(batched, 'reviewed', {
      reviewed_at: '2026-04-11T00:06:00.000Z',
      updated_at: '2026-04-11T00:06:00.000Z',
    });
    const promotedPending = transitionDraftSuggestionState(reviewed, 'promoted_pending_index', {
      updated_at: '2026-04-11T00:07:00.000Z',
    });
    const promoted = transitionDraftSuggestionState(promotedPending, 'promoted', {
      updated_at: '2026-04-11T00:08:00.000Z',
    });

    expect(canTransitionDraftSuggestion('reviewed', 'promoted_pending_index')).toBe(true);
    expect(promotedPending.promotion_result).toMatchObject({
      state: 'promoted_pending_index',
      index_status: 'pending',
      memory_category: 'decisions',
    });
    expect(promoted.promotion_result).toMatchObject({
      state: 'promoted',
      index_status: 'completed',
    });
    expect(promoted.reviewed_at).toBe('2026-04-11T00:06:00.000Z');
  });

  it('rejects invalid transitions and invalid confidence values', () => {
    const drafted = createDraftSuggestionRecord(baseInput);

    expect(() =>
      transitionDraftSuggestionState(drafted, 'promoted', {
        updated_at: '2026-04-11T00:07:00.000Z',
      })
    ).toThrow('Invalid draft suggestion transition: drafted -> promoted');

    expect(() =>
      createDraftSuggestionRecord({
        ...baseInput,
        draft_id: 'draft-2',
        confidence: 2,
      })
    ).toThrow('Draft suggestion confidence must be a number between 0 and 1');
  });

  it('keeps promotion payload hashing stable for backward-compatible durable memory writes', () => {
    const record = createDraftSuggestionRecord(baseInput);
    const payload = toPromotionPayload(record);

    expect(computePromotionPayloadHash(payload)).toBe(record.promotion_payload_hash);
    expect(payload).toEqual({
      category: 'decisions',
      content: 'Keep transport changes additive.',
      title: 'Transport guardrail',
      subtype: 'review_finding',
      tags: ['mcp', 'transport'],
      priority: 'critical',
      source: 'review_auto',
      linked_files: ['src/http/httpServer.ts'],
      linked_plans: ['vibe-coder-memory-mode-plan'],
      evidence: 'review finding #1',
      created_at: undefined,
      updated_at: undefined,
      owner: 'platform-team',
    });
  });
});
