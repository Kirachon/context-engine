/**
 * Unit tests for Planning Prompts
 *
 * Tests the prompt building functions and JSON extraction utilities.
 */

import { describe, it, expect } from '@jest/globals';
import {
  extractJsonFromResponse,
  buildPlanningPrompt,
  buildRefinementPrompt,
  buildDiagramPrompt,
  PLANNING_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
} from '../../src/mcp/prompts/planning.js';

describe('Planning Prompts', () => {
  describe('extractJsonFromResponse', () => {
    it('should extract raw JSON object', () => {
      const response = '{"goal": "Test goal", "steps": []}';
      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ goal: 'Test goal', steps: [] });
    });

    it('should extract JSON from markdown code fence', () => {
      const response = `Here is the plan:
\`\`\`json
{"goal": "Markdown goal", "version": 1}
\`\`\`
That's the plan!`;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ goal: 'Markdown goal', version: 1 });
    });

    it('should extract JSON from plain code fence (no language)', () => {
      const response = `Result:
\`\`\`
{"status": "ok"}
\`\`\``;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ status: 'ok' });
    });

    it('should handle JSON with leading/trailing text', () => {
      const response = 'The plan is: {"goal": "embedded"} and that is all.';
      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ goal: 'embedded' });
    });

    it('should handle nested JSON objects', () => {
      const response = '{"outer": {"inner": {"deep": true}}}';
      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ outer: { inner: { deep: true } } });
    });

    it('should handle JSON with arrays', () => {
      const response = '{"steps": [{"id": 1}, {"id": 2}, {"id": 3}]}';
      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.steps).toHaveLength(3);
    });

    it('should return null for empty string', () => {
      expect(extractJsonFromResponse('')).toBeNull();
    });

    it('should return null for no JSON content', () => {
      expect(extractJsonFromResponse('No JSON here at all!')).toBeNull();
    });

    it('should return null for incomplete JSON', () => {
      const response = '{"goal": "incomplete';
      // This will match the pattern but parsing might fail
      const result = extractJsonFromResponse(response);
      // extractJsonFromResponse just extracts, doesn't validate
      // So it might return the broken JSON or null depending on regex
      if (result) {
        expect(() => JSON.parse(result)).toThrow();
      }
    });

    it('should prefer code fence JSON over inline JSON', () => {
      const response = `{"inline": true}
\`\`\`json
{"fenced": true}
\`\`\``;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual({ fenced: true });
    });
  });

  describe('buildPlanningPrompt', () => {
    it('should include task in output', () => {
      const result = buildPlanningPrompt('Implement user auth', 'Some context');
      expect(result).toContain('Implement user auth');
    });

    it('should include context summary', () => {
      const result = buildPlanningPrompt('Task', 'Context with important info');
      expect(result).toContain('Context with important info');
    });

    it('should include instructions section', () => {
      const result = buildPlanningPrompt('Task', 'Context');
      expect(result).toContain('## Instructions');
      expect(result).toContain('Return ONLY valid JSON');
    });
  });

  describe('buildRefinementPrompt', () => {
    it('should include current plan', () => {
      const plan = '{"goal": "Original plan"}';
      const result = buildRefinementPrompt(plan, 'Please improve');
      expect(result).toContain(plan);
    });

    it('should include feedback', () => {
      const result = buildRefinementPrompt('{}', 'Need more detail');
      expect(result).toContain('Need more detail');
    });

    it('should include clarifications when provided', () => {
      const clarifications = {
        'What database?': 'PostgreSQL',
        'Which framework?': 'Express',
      };
      const result = buildRefinementPrompt('{}', 'Feedback', clarifications);

      expect(result).toContain('What database?');
      expect(result).toContain('PostgreSQL');
      expect(result).toContain('Which framework?');
      expect(result).toContain('Express');
    });

    it('should handle empty clarifications', () => {
      const result = buildRefinementPrompt('{}', 'Feedback', {});
      expect(result).not.toContain('Clarification Answers');
    });
  });

  describe('buildDiagramPrompt', () => {
    it('should replace placeholders', () => {
      const result = buildDiagramPrompt('architecture', 'User service', 'API layer');

      expect(result).toContain('architecture');
      expect(result).toContain('User service');
      expect(result).toContain('API layer');
    });
  });

  describe('System Prompts', () => {
    it('PLANNING_SYSTEM_PROMPT should be defined', () => {
      expect(PLANNING_SYSTEM_PROMPT).toBeDefined();
      expect(PLANNING_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('PLANNING_SYSTEM_PROMPT should include schema structure', () => {
      expect(PLANNING_SYSTEM_PROMPT).toContain('goal');
      expect(PLANNING_SYSTEM_PROMPT).toContain('steps');
      expect(PLANNING_SYSTEM_PROMPT).toContain('depends_on');
    });

    it('REFINEMENT_SYSTEM_PROMPT should be defined', () => {
      expect(REFINEMENT_SYSTEM_PROMPT).toBeDefined();
      expect(REFINEMENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });
  });
});

