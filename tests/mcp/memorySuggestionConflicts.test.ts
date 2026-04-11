import { describe, expect, it } from '@jest/globals';
import {
  findDraftConflicts,
  gateBulkDraftPromotion,
  gateDraftPromotion,
  type ApprovedMemoryRecord,
} from '../../src/mcp/memorySuggestionConflicts.js';
import { createDraftSuggestionRecord } from '../../src/mcp/memorySuggestions.js';

describe('memorySuggestionConflicts', () => {
  function createDraft(content: string, overrides: Partial<Parameters<typeof createDraftSuggestionRecord>[0]> = {}) {
    return createDraftSuggestionRecord({
      draft_id: 'draft-1',
      session_id: 'session-1',
      source_type: 'review_outputs',
      source_ref: 'review/1',
      category: 'decisions',
      content,
      metadata: {
        priority: 'critical',
        subtype: 'review_finding',
      },
      score_breakdown: {
        repetition: 1,
        directive_strength: 1,
        source_reliability: 0.92,
        traceability: 1,
        stability_penalty: 0,
      },
      confidence: 0.95,
      ...overrides,
    });
  }

  const approvedMemories: ApprovedMemoryRecord[] = [
    {
      category: 'decisions',
      title: 'Hosted auth default',
      content: 'Do not enable hosted auth by default.',
      source: 'review_auto',
    },
    {
      category: 'preferences',
      title: 'Tone',
      content: 'Keep responses concise and direct.',
      source: 'user_pref',
    },
    {
      category: 'decisions',
      title: 'Transport',
      content: 'Keep transport changes additive.',
      source: 'plan',
    },
  ];

  it('finds contradictions using deterministic conflict keys and top-N comparison', () => {
    const candidate = createDraft('Enable hosted auth by default for new sessions.');
    const conflicts = findDraftConflicts(candidate, approvedMemories, 2);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.approved_memory.title).toBe('Hosted auth default');
    expect(conflicts[0]?.candidate_conflict_key).toContain('auth default hosted');
    expect(conflicts[0]?.approved_conflict_key).toContain('auth default hosted');
    expect(conflicts[0]?.relevance_score).toBeGreaterThan(0.6);
  });

  it('blocks promotion on contradiction until an override reason is provided', () => {
    const candidate = createDraft('Enable hosted auth by default for new sessions.');

    const blocked = gateDraftPromotion(candidate, approvedMemories);
    const overridden = gateDraftPromotion(candidate, approvedMemories, {
      override_reason: 'Architecture owner approved this exception for hosted rollout canary.',
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.requires_override_reason).toBe(true);
    expect(blocked.override_applied).toBe(false);
    expect(blocked.conflict_matches).toHaveLength(1);

    expect(overridden.allowed).toBe(true);
    expect(overridden.requires_override_reason).toBe(true);
    expect(overridden.override_applied).toBe(true);
    expect(overridden.conflict_matches).toHaveLength(1);
  });

  it('does not block non-conflicting drafts', () => {
    const candidate = createDraft('Keep transport changes additive in the HTTP path.');

    const decision = gateDraftPromotion(candidate, approvedMemories);

    expect(decision.allowed).toBe(true);
    expect(decision.requires_override_reason).toBe(false);
    expect(decision.conflict_matches).toEqual([]);
  });

  it('applies the same contradiction gate to bulk-save batches', () => {
    const contradictory = createDraft('Enable hosted auth by default for new sessions.', { draft_id: 'draft-contradict' });
    const safe = createDraft('Keep transport changes additive in the HTTP path.', { draft_id: 'draft-safe' });

    const result = gateBulkDraftPromotion([contradictory, safe], approvedMemories);
    const withOverride = gateBulkDraftPromotion([contradictory, safe], approvedMemories, {
      override_reason: 'Approved during hosted rollout review.',
    });

    expect(result.eligible.map((draft) => draft.draft_id)).toEqual(['draft-safe']);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.draft.draft_id).toBe('draft-contradict');
    expect(result.blocked[0]?.decision.requires_override_reason).toBe(true);

    expect(withOverride.eligible.map((draft) => draft.draft_id).sort()).toEqual([
      'draft-contradict',
      'draft-safe',
    ]);
    expect(withOverride.blocked).toEqual([]);
  });
});
