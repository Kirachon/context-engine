/**
 * Layer 3: MCP Interface Layer - Review Auto Tool
 *
 * Smart wrapper that chooses the most appropriate review tool based on inputs.
 * - If `diff` is provided: runs `review_diff`
 * - Otherwise: runs `review_git_diff`
 *
 * This keeps external schemas stable by returning a wrapper object with a stable shape.
 */

import type { ContextServiceClient } from '../serviceClient.js';
import type { ReviewOptions } from '../types/codeReview.js';
import type { EnterpriseReviewResult } from '../../reviewer/types.js';
import { handleReviewGitDiff, type ReviewGitDiffArgs } from './gitReview.js';
import { handleReviewDiff, type ReviewDiffArgs } from './reviewDiff.js';
import type { ReviewGitDiffOutput } from './gitReview.js';

export type ReviewAutoSelectedTool = 'review_diff' | 'review_git_diff';

export interface ReviewAutoArgs {
  /**
   * Force a specific tool. Default: auto.
   */
  tool?: 'auto' | ReviewAutoSelectedTool;

  /**
   * Unified diff content (when provided, selects review_diff unless tool overrides).
   */
  diff?: string;

  /**
   * Optional list of changed files (review_diff only).
   */
  changed_files?: string[];

  /**
   * Git mode args (review_git_diff only).
   */
  target?: string;
  base?: string;
  include_patterns?: string[];

  /**
   * Options for review_diff.
   */
  review_diff_options?: ReviewDiffArgs['options'];

  /**
   * Options for review_git_diff (same as review_changes).
   */
  review_git_diff_options?: ReviewOptions;
}

export interface ReviewAutoResult {
  selected_tool: ReviewAutoSelectedTool;
  rationale: string;
  output: EnterpriseReviewResult | ReviewGitDiffOutput;
}

function selectTool(args: ReviewAutoArgs): { selected: ReviewAutoSelectedTool; rationale: string } {
  if (args.tool && args.tool !== 'auto') {
    return { selected: args.tool, rationale: `Forced tool: ${args.tool}` };
  }

  if (typeof args.diff === 'string' && args.diff.trim().length > 0) {
    return { selected: 'review_diff', rationale: 'diff provided -> using review_diff' };
  }

  return { selected: 'review_git_diff', rationale: 'no diff provided -> using review_git_diff' };
}

function looksLikeUnifiedDiff(diff: string): boolean {
  const d = diff.trimStart();
  if (d.startsWith('diff --git ')) return true;
  // Some diffs may be patch-style without the leading `diff --git` line.
  const hasFileHeaders = d.includes('\n--- ') && d.includes('\n+++ ');
  const hasHunkHeader = d.includes('\n@@ ');
  return hasFileHeaders || hasHunkHeader;
}

function parseJsonOrThrow<T = unknown>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: failed to parse JSON (${message})`);
  }
}

export async function handleReviewAuto(args: ReviewAutoArgs, serviceClient: ContextServiceClient): Promise<string> {
  const { selected, rationale } = selectTool(args);

  if (selected === 'review_diff') {
    if (!args.diff || typeof args.diff !== 'string') {
      throw new Error('review_diff selected but no valid diff provided');
    }
    if (!looksLikeUnifiedDiff(args.diff)) {
      throw new Error('review_diff selected but diff does not look like a unified diff');
    }
    if (args.target || args.base || (args.include_patterns && args.include_patterns.length > 0)) {
      throw new Error('review_diff selected; git args (target/base/include_patterns) are not applicable');
    }
    if (args.review_git_diff_options) {
      throw new Error('review_diff selected; review_git_diff_options is not applicable');
    }

    const resultStr = await handleReviewDiff(
      { diff: args.diff, changed_files: args.changed_files, options: args.review_diff_options } as ReviewDiffArgs,
      serviceClient
    );
    const output = parseJsonOrThrow<EnterpriseReviewResult>(resultStr, 'review_diff output');
    const result: ReviewAutoResult = { selected_tool: selected, rationale, output };
    return JSON.stringify(result, null, 2);
  }

  if (typeof args.diff === 'string' && args.diff.trim().length > 0) {
    throw new Error('review_git_diff selected; diff argument is not applicable');
  }
  if (args.changed_files) {
    throw new Error('review_git_diff selected; changed_files is not applicable');
  }
  if (args.review_diff_options) {
    throw new Error('review_git_diff selected; review_diff_options is not applicable');
  }

  const resultStr = await handleReviewGitDiff(
    {
      target: args.target,
      base: args.base,
      include_patterns: args.include_patterns,
      options: args.review_git_diff_options ?? {},
    } as ReviewGitDiffArgs,
    serviceClient
  );
  const output = parseJsonOrThrow<ReviewGitDiffOutput>(resultStr, 'review_git_diff output');
  const result: ReviewAutoResult = { selected_tool: selected, rationale, output };
  return JSON.stringify(result, null, 2);
}

export const reviewAutoTool = {
  name: 'review_auto',
  description:
    'Smart wrapper that chooses review_diff when a diff is provided; otherwise chooses review_git_diff for the current git workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: "Force tool selection. One of: 'auto', 'review_diff', 'review_git_diff'. Default: auto.",
        enum: ['auto', 'review_diff', 'review_git_diff'],
        default: 'auto',
      },
      diff: { type: 'string', description: 'Unified diff content (selects review_diff in auto mode)' },
      changed_files: { type: 'array', items: { type: 'string' }, description: 'Optional list of changed files (review_diff only)' },
      target: { type: 'string', description: "Git target to review (review_git_diff only). Default: 'staged'." },
      base: { type: 'string', description: 'Base ref for git comparisons (review_git_diff only)' },
      include_patterns: { type: 'array', items: { type: 'string' }, description: 'File globs to include (review_git_diff only)' },
      review_diff_options: { type: 'object', description: 'Options passed through to review_diff (advanced/CI-oriented)' },
      review_git_diff_options: { type: 'object', description: 'Options passed through to review_git_diff (same as review_changes options)' },
    },
    required: [],
  },
};
