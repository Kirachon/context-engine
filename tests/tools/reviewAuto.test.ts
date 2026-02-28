import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReviewAuto } from '../../src/mcp/tools/reviewAuto.js';

function sh(bin: string, args: string[], cwd: string): string {
  return execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

function createRepoWithStagedChange(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-auto-'));

  sh('git', ['init'], tmp);
  sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
  sh('git', ['config', 'user.name', 'CI'], tmp);

  writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
  sh('git', ['add', '.'], tmp);
  sh('git', ['commit', '-m', 'base'], tmp);

  writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', 'export const b = 2;', ''].join('\n'));
  sh('git', ['add', '.'], tmp);

  return tmp;
}

function createRepoWithNoStagedChange(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-auto-empty-'));

  sh('git', ['init'], tmp);
  sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
  sh('git', ['config', 'user.name', 'CI'], tmp);

  writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
  sh('git', ['add', '.'], tmp);
  sh('git', ['commit', '-m', 'base'], tmp);

  return tmp;
}

function normalizeReviewAuto(result: any): any {
  const normalized = JSON.parse(JSON.stringify(result));

  if (normalized.output?.metadata?.reviewed_at) normalized.output.metadata.reviewed_at = '<fixed>';
  if (normalized.output?.stats?.duration_ms) normalized.output.stats.duration_ms = 0;
  if (normalized.output?.stats?.timings_ms) normalized.output.stats.timings_ms = {};
  if (normalized.output?.run_id) normalized.output.run_id = '<fixed>';

  if (normalized.output?.review?.metadata?.reviewed_at) normalized.output.review.metadata.reviewed_at = '<fixed>';
  if (normalized.output?.review?.metadata?.review_duration_ms) normalized.output.review.metadata.review_duration_ms = 0;

  return normalized;
}

describe('review_auto tool', () => {
  it('selects review_diff when diff is provided', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-export const a = 1;
+export const a = 2;
`;

    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      getFile: async () => '',
      searchAndAsk: async () => '',
    } as any;

    const resultStr = await handleReviewAuto(
      {
        diff,
        review_diff_options: { enable_llm: false, enable_static_analysis: false, include_sarif: false, include_markdown: false },
      },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(normalizeReviewAuto(parsed)).toMatchSnapshot();
  });

  it('selects review_git_diff when no diff is provided', async () => {
    const tmp = createRepoWithStagedChange();

    const mockServiceClient = {
      getWorkspacePath: () => tmp,
      searchAndAsk: async () =>
        JSON.stringify({
          findings: [
            {
              id: 'finding_1',
              title: 'Add input validation',
              body: 'Mocked output.',
              confidence_score: 0.95,
              priority: 1,
              category: 'correctness',
              code_location: { file_path: 'src/a.ts', line_range: { start: 2, end: 2 } },
              suggestion: { description: 'Add a guard', can_auto_fix: false },
              is_on_changed_line: true,
            },
          ],
          overall_correctness: 'needs attention',
          overall_explanation: 'Mocked output.',
          overall_confidence_score: 0.8,
        }),
    } as any;

    const resultStr = await handleReviewAuto(
      {
        target: 'staged',
        review_git_diff_options: { confidence_threshold: 0.7, changed_lines_only: true },
      },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(normalizeReviewAuto(parsed)).toMatchSnapshot();
  });

  it('blocks when auto-select routes to review_git_diff with empty staged scope', async () => {
    const tmp = createRepoWithNoStagedChange();
    const mockServiceClient = {
      getWorkspacePath: () => tmp,
      searchAndAsk: async () => '',
    } as any;

    await expect(
      handleReviewAuto(
        {
          target: 'staged',
        },
        mockServiceClient
      )
    ).rejects.toThrow(/No changes found for review_git_diff target "staged".*review is blocked/i);
  });

  it('treats whitespace-only diff as absent and auto-selects review_git_diff', async () => {
    const tmp = createRepoWithStagedChange();
    const mockServiceClient = {
      getWorkspacePath: () => tmp,
      searchAndAsk: async () =>
        JSON.stringify({
          findings: [],
          overall_correctness: 'looks good',
          overall_explanation: 'Mocked output.',
          overall_confidence_score: 0.8,
        }),
    } as any;

    const resultStr = await handleReviewAuto(
      {
        diff: '  \n\t  ',
        target: 'staged',
      },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(parsed.selected_tool).toBe('review_git_diff');
  });

  it('accepts patch-style partial diffs when review_diff is forced', async () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;

    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      getFile: async () => '',
      searchAndAsk: async () => '',
    } as any;

    const resultStr = await handleReviewAuto(
      {
        tool: 'review_diff',
        diff,
      },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(parsed.selected_tool).toBe('review_diff');
    expect(parsed.output).toHaveProperty('stats');
  });

  it('rejects review_diff selection when diff is not unified-diff shaped', async () => {
    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      getFile: async () => '',
      searchAndAsk: async () => '',
    } as any;

    await expect(
      handleReviewAuto(
        {
          tool: 'review_diff',
          diff: 'plain text, not a diff',
        },
        mockServiceClient
      )
    ).rejects.toThrow(/does not look like a unified diff/i);
  });

  it('rejects git args when auto-select resolves to review_diff', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-export const a = 1;
+export const a = 2;
`;

    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      getFile: async () => '',
      searchAndAsk: async () => '',
    } as any;

    await expect(
      handleReviewAuto(
        {
          diff,
          target: 'staged',
        },
        mockServiceClient
      )
    ).rejects.toThrow(/git args .* not applicable/i);
  });

  it('rejects diff argument when review_git_diff is forced', async () => {
    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      searchAndAsk: async () => '{}',
    } as any;

    await expect(
      handleReviewAuto(
        {
          tool: 'review_git_diff',
          diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
        },
        mockServiceClient
      )
    ).rejects.toThrow(/diff argument is not applicable/i);
  });

  it('treats whitespace-only diff as missing when review_diff is forced', async () => {
    const mockServiceClient = {
      getWorkspacePath: () => process.cwd(),
      getFile: async () => '',
      searchAndAsk: async () => '',
    } as any;

    await expect(
      handleReviewAuto(
        {
          tool: 'review_diff',
          diff: '  \n\t  ',
        },
        mockServiceClient
      )
    ).rejects.toThrow(/no valid diff provided/i);
  });
});
