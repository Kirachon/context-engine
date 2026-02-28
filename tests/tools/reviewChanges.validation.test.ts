import { describe, it, expect } from '@jest/globals';
import { handleReviewChanges } from '../../src/mcp/tools/codeReview.js';

describe('review_changes validation paths', () => {
  const mockServiceClient = { searchAndAsk: async () => '{}' } as any;

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
});
