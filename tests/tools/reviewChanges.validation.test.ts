import { describe, it, expect } from '@jest/globals';
import { handleReviewChanges } from '../../src/mcp/tools/codeReview.js';

describe('review_changes validation paths', () => {
  const mockServiceClient = { searchAndAsk: async () => '{}' } as any;
  const mockServiceClientWithValidResponse = {
    searchAndAsk: async () =>
      JSON.stringify({
        findings: [
          {
            id: 'finding_1',
            title: 'Test finding',
            body: 'Mocked output.',
            confidence_score: 0.95,
            priority: 1,
            category: 'correctness',
            code_location: { file_path: 'src/a.ts', line_range: { start: 1, end: 1 } },
            suggestion: { description: 'Add a guard', can_auto_fix: false },
            is_on_changed_line: true,
          },
        ],
        overall_correctness: 'needs attention',
        overall_explanation: 'Mocked output.',
        overall_confidence_score: 0.8,
      }),
  } as any;

  it('rejects diff that becomes empty after trimming', async () => {
    await expect(handleReviewChanges({ diff: '   ' }, mockServiceClient)).rejects.toThrow(
      /missing or invalid "diff" argument\. provide a unified diff string\./i
    );
  });

  it('rejects invalid category values', async () => {
    await expect(
      handleReviewChanges({ diff: 'diff --git a/a.ts b/a.ts', categories: 'correctness,not-real' }, mockServiceClient)
    ).rejects.toThrow(/invalid category: "not-real"\. valid:/i);
  });

  it('rejects non-string file_contexts', async () => {
    await expect(
      handleReviewChanges({ diff: 'diff --git a/a.ts b/a.ts', file_contexts: 123 as unknown as string }, mockServiceClient)
    ).rejects.toThrow(/invalid "file_contexts": must be a json string/i);
  });

  it('rejects oversized file_contexts payload', async () => {
    const hugeFileContexts = 'x'.repeat(2_000_001);

    await expect(
      handleReviewChanges({ diff: 'diff --git a/a.ts b/a.ts', file_contexts: hugeFileContexts }, mockServiceClient)
    ).rejects.toThrow(/invalid "file_contexts": maximum 2000000 characters/i);
  });

  it('rejects file_contexts json values that are not object maps', async () => {
    await expect(
      handleReviewChanges({ diff: 'diff --git a/a.ts b/a.ts', file_contexts: '[]' }, mockServiceClient)
    ).rejects.toThrow(/expected an object map of file path to content/i);
  });

  it('blocks malformed non-empty diff input with no reviewable scope', async () => {
    await expect(
      handleReviewChanges(
        { diff: 'plain text, not a diff' },
        mockServiceClientWithValidResponse
      )
    ).rejects.toThrow(/no reviewable changes found in diff scope/i);
  });

  it('accepts partial git-style file sections without hunks', async () => {
    const resultStr = await handleReviewChanges(
      {
        diff: `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
`,
      },
      mockServiceClientWithValidResponse
    );
    const result = JSON.parse(resultStr);
    expect(Array.isArray(result.findings)).toBe(true);
  });
});
