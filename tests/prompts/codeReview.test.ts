/**
 * Unit tests for Code Review Prompts
 *
 * Tests the prompt building and validation utilities.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  CATEGORY_FOCUS_PROMPTS,
  buildCodeReviewPrompt,
  buildFileReviewPrompt,
  extractJsonFromResponse,
  validateReviewResult,
} from '../../src/mcp/prompts/codeReview.js';

describe('Code Review Prompts', () => {
  // ============================================================================
  // System Prompt Tests
  // ============================================================================

  describe('CODE_REVIEW_SYSTEM_PROMPT', () => {
    it('should be a non-empty string', () => {
      expect(typeof CODE_REVIEW_SYSTEM_PROMPT).toBe('string');
      expect(CODE_REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('should mention JSON output format', () => {
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('JSON');
    });

    it('should mention priority levels', () => {
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('P0');
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('P1');
    });

    it('should define review categories', () => {
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('correctness');
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain('security');
    });
  });

  describe('CATEGORY_FOCUS_PROMPTS', () => {
    it('should have prompts for key categories', () => {
      expect(CATEGORY_FOCUS_PROMPTS.security).toBeDefined();
      expect(CATEGORY_FOCUS_PROMPTS.security.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // buildCodeReviewPrompt Tests
  // ============================================================================

  describe('buildCodeReviewPrompt', () => {
    const sampleDiff = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };`;

    it('should include the diff in the prompt', () => {
      const prompt = buildCodeReviewPrompt(sampleDiff, {});

      expect(prompt).toContain(sampleDiff);
    });

    it('should include file contexts when provided', () => {
      const fileContexts = {
        'src/file.ts': 'This file handles configuration loading.',
      };

      const prompt = buildCodeReviewPrompt(sampleDiff, fileContexts);

      expect(prompt).toContain('src/file.ts');
      expect(prompt).toContain('configuration loading');
    });

    it('should include custom instructions when provided', () => {
      const prompt = buildCodeReviewPrompt(sampleDiff, {}, {
        custom_instructions: 'Focus on type safety issues.',
      });

      expect(prompt).toContain('Focus on type safety issues');
    });

    it('should work with empty file contexts', () => {
      const prompt = buildCodeReviewPrompt(sampleDiff, {});

      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should handle multiple file contexts', () => {
      const fileContexts = {
        'src/file1.ts': 'File 1 context',
        'src/file2.ts': 'File 2 context',
      };

      const prompt = buildCodeReviewPrompt(sampleDiff, fileContexts);

      expect(prompt).toContain('File 1 context');
      expect(prompt).toContain('File 2 context');
    });

    it('should render file contexts and categories in stable sorted order', () => {
      const fileContexts = {
        'src/z.ts': '  z context  ',
        'src/a.ts': 'a context',
      };

      const prompt = buildCodeReviewPrompt(sampleDiff, fileContexts, {
        categories: ['performance', 'correctness'],
        custom_instructions: '  Prefer the smallest safe fix.  ',
      });

      expect(prompt).toContain('## Context');
      expect(prompt.indexOf('src/a.ts')).toBeLessThan(prompt.indexOf('src/z.ts'));
      expect(prompt.indexOf('correctness')).toBeLessThan(prompt.indexOf('performance'));
      expect(prompt).toContain('Prefer the smallest safe fix.');
      expect(prompt).not.toContain('File Contexts (for additional understanding)');
      expect(prompt).not.toContain('Analyze the diff above and return your findings as valid JSON matching the schema in your system prompt.');
      expect(prompt).toContain('Order findings by priority (P0 first) and include confidence scores.');
    });
  });

  describe('buildFileReviewPrompt', () => {
    it('should normalize changed lines and trim prompt extras', () => {
      const prompt = buildFileReviewPrompt(
        'src/file.ts',
        'const a = 1;\nconst b = 2;\n',
        [12, 3, 12, 7],
        {
          categories: ['style', 'correctness'],
          custom_instructions: '  Keep it concise.  ',
        }
      );

      expect(prompt).toContain('## File Review: src/file.ts');
      expect(prompt).toContain('3, 7, 12');
      expect(prompt).toContain('Keep it concise.');
      expect(prompt).not.toContain('The following line numbers were changed');
    });
  });

  // ============================================================================
  // extractJsonFromResponse Tests
  // ============================================================================

  describe('extractJsonFromResponse', () => {
    it('should extract JSON string from code block', () => {
      const response = `Here is the review:
\`\`\`json
{"findings": [], "overall_correctness": "correct"}
\`\`\``;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed).toEqual({ findings: [], overall_correctness: 'correct' });
    });

    it('should extract JSON without code block markers', () => {
      const response = '{"findings": [], "overall_correctness": "correct"}';

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed).toEqual({ findings: [], overall_correctness: 'correct' });
    });

    it('should handle JSON with surrounding text', () => {
      const response = `The review is complete.
{"findings": [{"id": "1"}], "overall_correctness": "correct"}
End of review.`;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.findings).toHaveLength(1);
    });

    it('should return null when no JSON found', () => {
      const response = 'This is not valid JSON at all.';

      const result = extractJsonFromResponse(response);

      expect(result).toBeNull();
    });

    it('should handle nested JSON structures', () => {
      const response = `\`\`\`json
{
  "findings": [
    {
      "id": "f1",
      "title": "Issue",
      "code_location": {"file_path": "test.ts", "line_range": {"start": 1, "end": 2}}
    }
  ],
  "overall_correctness": "issues_found"
}
\`\`\``;

      const result = extractJsonFromResponse(response);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.findings[0].code_location.file_path).toBe('test.ts');
    });
  });

  // ============================================================================
  // validateReviewResult Tests
  // ============================================================================

  describe('validateReviewResult', () => {
    it('should validate a correct review result structure', () => {
      const validResult = {
        findings: [
          {
            id: 'f1',
            title: 'Test Finding',
            body: 'Description',
            confidence_score: 0.9,
            priority: 2,
            category: 'correctness',
            code_location: {
              file_path: 'src/test.ts',
              line_range: { start: 1, end: 5 },
            },
            is_on_changed_line: true,
          },
        ],
        overall_correctness: 'correct',
        overall_explanation: 'The code looks good.',
        overall_confidence_score: 0.95,
      };

      expect(validateReviewResult(validResult)).toBe(true);
    });

    it('should validate result with empty findings array', () => {
      const validResult = {
        findings: [],
        overall_correctness: 'correct',
        overall_explanation: 'No issues found.',
        overall_confidence_score: 1.0,
      };

      expect(validateReviewResult(validResult)).toBe(true);
    });

    it('should reject null or undefined', () => {
      expect(validateReviewResult(null)).toBe(false);
      expect(validateReviewResult(undefined)).toBe(false);
    });

    it('should reject non-object types', () => {
      expect(validateReviewResult('string')).toBe(false);
      expect(validateReviewResult(123)).toBe(false);
      expect(validateReviewResult([])).toBe(false);
    });

    it('should reject result without findings array', () => {
      const invalidResult = {
        overall_correctness: 'correct',
        overall_explanation: 'Missing findings.',
        overall_confidence_score: 0.9,
      };

      expect(validateReviewResult(invalidResult)).toBe(false);
    });

    it('should reject result with non-array findings', () => {
      const invalidResult = {
        findings: 'not an array',
        overall_correctness: 'correct',
        overall_explanation: 'Test',
        overall_confidence_score: 0.9,
      };

      expect(validateReviewResult(invalidResult)).toBe(false);
    });

    it('should reject result without overall_correctness', () => {
      const invalidResult = {
        findings: [],
        overall_explanation: 'Missing verdict.',
        overall_confidence_score: 0.9,
      };

      expect(validateReviewResult(invalidResult)).toBe(false);
    });

    it('should validate result with all verdict types', () => {
      const verdicts = ['correct', 'issues_found', 'needs_major_changes', 'cannot_determine'];

      for (const verdict of verdicts) {
        const result = {
          findings: [],
          overall_correctness: verdict,
          overall_explanation: 'Test',
          overall_confidence_score: 0.8,
        };
        expect(validateReviewResult(result)).toBe(true);
      }
    });
  });
});
