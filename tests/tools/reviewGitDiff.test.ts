import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReviewGitDiff } from '../../src/mcp/tools/gitReview.js';

function sh(bin: string, args: string[], cwd: string): string {
  return execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

function normalizeReviewGitDiff(output: any): any {
  const normalized = JSON.parse(JSON.stringify(output));
  if (normalized.review?.metadata) {
    normalized.review.metadata.reviewed_at = '<fixed>';
    normalized.review.metadata.review_duration_ms = 0;
  }
  return normalized;
}

describe('review_git_diff tool', () => {
  it('returns git_info + review (snapshot) for staged changes with mocked LLM response', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-git-diff-'));

    sh('git', ['init'], tmp);
    sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
    sh('git', ['config', 'user.name', 'CI'], tmp);

    writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
    sh('git', ['add', '.'], tmp);
    sh('git', ['commit', '-m', 'base'], tmp);

    // Create staged change
    writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', 'export const b = 2;', ''].join('\n'));
    sh('git', ['add', '.'], tmp);

    const mockServiceClient = {
      getWorkspacePath: () => tmp,
      searchAndAsk: async (_q: string, _p: string) =>
        JSON.stringify({
          findings: [
            {
              id: 'finding_p0',
              title: 'Critical issue even off changed lines',
              body: 'Mocked P0 finding.',
              confidence_score: 0.95,
              priority: 0,
              category: 'security',
              code_location: { file_path: 'src/a.ts', line_range: { start: 1, end: 1 } },
              suggestion: { description: 'Fix it', can_auto_fix: false },
              is_on_changed_line: false,
            },
            {
              id: 'finding_p1',
              title: 'Add input validation',
              body: 'Mocked P1 finding.',
              confidence_score: 0.95,
              priority: 1,
              category: 'correctness',
              code_location: { file_path: 'src/a.ts', line_range: { start: 2, end: 2 } },
              suggestion: { description: 'Add a guard', can_auto_fix: false },
              is_on_changed_line: true,
            },
            {
              id: 'finding_low_conf',
              title: 'Low-confidence note',
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

    const resultStr = await handleReviewGitDiff(
      { target: 'staged', options: { confidence_threshold: 0.7, changed_lines_only: true } },
      mockServiceClient
    );

    const parsed = JSON.parse(resultStr);
    expect(normalizeReviewGitDiff(parsed)).toMatchSnapshot();
  });

  it('returns an empty review when there is nothing staged', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-git-diff-empty-'));

    sh('git', ['init'], tmp);
    sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
    sh('git', ['config', 'user.name', 'CI'], tmp);

    writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
    sh('git', ['add', '.'], tmp);
    sh('git', ['commit', '-m', 'base'], tmp);

    const mockServiceClient = { getWorkspacePath: () => tmp, searchAndAsk: async () => '' } as any;
    const resultStr = await handleReviewGitDiff({ target: 'staged' }, mockServiceClient);

    const parsed = JSON.parse(resultStr);
    expect(normalizeReviewGitDiff(parsed)).toMatchSnapshot();
  });
});

