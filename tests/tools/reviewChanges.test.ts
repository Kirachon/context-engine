import { describe, it, expect } from '@jest/globals';
import { handleReviewChanges } from '../../src/mcp/tools/codeReview.js';

function normalizeReviewChanges(result: any): any {
  const normalized = JSON.parse(JSON.stringify(result));
  if (normalized.metadata) {
    normalized.metadata.reviewed_at = '<fixed>';
    normalized.metadata.review_duration_ms = 0;
  }
  return normalized;
}

describe('review_changes tool', () => {
  it('returns structured JSON (snapshot) for a mocked LLM response', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 export const a = 1;
+export const b = 2;`;

    const mockServiceClient = {
      searchAndAsk: async () =>
        JSON.stringify({
          findings: [
            {
              id: 'finding_1',
              title: 'Add input validation',
              body: 'This is a test finding.',
              confidence_score: 0.95,
              priority: 1,
              category: 'correctness',
              code_location: { file_path: 'src/a.ts', line_range: { start: 2, end: 2 } },
              suggestion: { description: 'Add a guard', can_auto_fix: false },
              is_on_changed_line: true,
            },
            {
              id: 'finding_2',
              title: 'Low-confidence style note',
              body: 'Should be filtered by confidence threshold.',
              confidence_score: 0.2,
              priority: 3,
              category: 'style',
              code_location: { file_path: 'src/a.ts', line_range: { start: 1, end: 1 } },
              suggestion: { description: 'N/A', can_auto_fix: false },
              is_on_changed_line: false,
            },
          ],
          overall_correctness: 'needs attention',
          overall_explanation: 'Mocked output.',
          overall_confidence_score: 0.8,
        }),
    } as any;

    const resultStr = await handleReviewChanges(
      {
        diff,
        confidence_threshold: 0.7,
        max_findings: 20,
        categories: 'correctness,security,performance,maintainability,style,documentation',
        changed_lines_only: true,
      },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(normalizeReviewChanges(parsed)).toMatchSnapshot();
  });
});

