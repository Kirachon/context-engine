import { describe, expect, it } from '@jest/globals';
import {
  PHASE_1_MEMORY_SUGGESTION_SOURCES,
  detectDraftSuggestion,
} from '../../src/mcp/memorySuggestionDetector.js';

describe('memorySuggestionDetector', () => {
  const baseInput = {
    draft_id: 'draft-detector-1',
    session_id: 'session-1',
    source_type: 'explicit_user_directives' as const,
    source_ref: 'conversation/turn-1',
    category: 'decisions' as const,
    title: 'Transport rule',
    content: 'Do not rename existing MCP tools. Keep transport changes additive.',
    metadata: {
      linked_files: ['src/mcp/server.ts'],
      linked_plans: ['vibe-coder-memory-mode-plan'],
      evidence: 'Repeated user rule',
      source: 'user',
      priority: 'critical' as const,
    },
    repetition_count: 2,
  };

  it('accepts high-signal inputs from the phase 1 allowlist with deterministic explainability', () => {
    const result = detectDraftSuggestion(baseInput);

    expect(PHASE_1_MEMORY_SUGGESTION_SOURCES).toEqual([
      'plan_outputs',
      'review_outputs',
      'explicit_user_directives',
    ]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      throw new Error(`Expected accepted draft, got ${result.rejection_reason}`);
    }
    expect(result.record.source_type).toBe('explicit_user_directives');
    expect(result.record.score_breakdown).toMatchObject({
      repetition: expect.any(Number),
      directive_strength: expect.any(Number),
      source_reliability: expect.any(Number),
      traceability: expect.any(Number),
      stability_penalty: expect.any(Number),
    });
    expect(result.record.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.explainability).toContain('directive');
    expect(result.explainability).toContain('trusted source');
    expect(result.explainability).toContain('traceable evidence');
  });

  it('accepts a one-off review finding when the directive and evidence are strong', () => {
    const result = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-2',
      source_type: 'review_outputs',
      source_ref: 'review/42',
      content: 'Block any rollout that enables hosted auth by default.',
      metadata: {
        ...baseInput.metadata,
        subtype: 'review_finding',
        source: 'review_auto',
        evidence: 'Critical review finding',
      },
      repetition_count: 1,
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      throw new Error(`Expected accepted draft, got ${result.rejection_reason}`);
    }
    expect(result.record.confidence).toBeGreaterThanOrEqual(0.68);
    expect(result.record.score_breakdown.repetition).toBeLessThanOrEqual(0.4);
    expect(result.record.score_breakdown.directive_strength).toBeGreaterThanOrEqual(0.8);
  });

  it('rejects sources outside the phase 1 allowlist', () => {
    const result = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-3',
      source_type: 'chat_transcript',
    });

    expect(result).toEqual({
      accepted: false,
      rejection_reason: 'source_not_allowed',
    });
  });

  it('rejects secrets before they can become draft suggestions', () => {
    const result = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-4',
      content: `Store this API key for later: sk-proj-${'a'.repeat(90)}`,
    });

    expect(result).toEqual({
      accepted: false,
      rejection_reason: 'contains_secret',
    });
  });

  it('rejects raw logs, unstable brainstorms, and implementation-noise notes', () => {
    const rawLog = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-5',
      source_type: 'review_outputs',
      content: [
        '2026-04-11T10:15:30.123Z ERROR MemoryDraftPromoter failed',
        '    at promoteDraft (src/mcp/promoter.ts:42:11)',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ].join('\n'),
    });
    const unstable = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-6',
      content: 'Maybe we should try changing this later if the experiment feels right.',
    });
    const noisy = detectDraftSuggestion({
      ...baseInput,
      draft_id: 'draft-detector-7',
      content: 'Rename tempVar to value and remove the debug console.log from this file.',
    });

    expect(rawLog).toEqual({
      accepted: false,
      rejection_reason: 'raw_log',
    });
    expect(unstable).toEqual({
      accepted: false,
      rejection_reason: 'unstable_statement',
    });
    expect(noisy).toEqual({
      accepted: false,
      rejection_reason: 'implementation_noise',
    });
  });
});
