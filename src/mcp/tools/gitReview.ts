/**
 * Git Review Tool
 *
 * MCP tool that combines git diff retrieval with code review.
 * Automatically retrieves diffs from git and reviews them.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { ReviewResult, ReviewOptions } from '../types/codeReview.js';
import { internalCodeReviewService } from '../../internal/handlers/codeReview.js';
import { buildEmptyReviewDiffScopeError, getReviewDiffSource } from '../tooling/reviewDiffSource.js';

// ============================================================================
// Types
// ============================================================================

export interface ReviewGitDiffArgs {
  /** Target to review: 'staged', 'unstaged', 'head', branch name, or commit hash */
  target?: string;
  /** Base reference for branch comparisons (e.g., 'main', 'develop') */
  base?: string;
  /** File patterns to include (glob patterns) */
  include_patterns?: string[];
  /** Review options (same as review_changes) */
  options?: ReviewOptions;
}

export interface ReviewGitDiffOutput {
  /** Git information about the diff */
  git_info: {
    target: string;
    base?: string;
    command: string;
    files_changed: string[];
    stats: {
      additions: number;
      deletions: number;
      files_count: number;
    };
  };
  /** The review result */
  review: ReviewResult;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const reviewGitDiffTool = {
  name: 'review_git_diff',
  description: `Review code changes from git automatically.

This tool combines git diff retrieval with AI-powered code review. It automatically:
1. Retrieves the diff from git based on the target
2. Analyzes the changes for issues
3. Returns structured findings with confidence scores

**Target Options:**
- 'staged' (default): Review staged changes (git diff --staged)
- 'unstaged': Review unstaged working directory changes
- 'head': Review all uncommitted changes (staged + unstaged)
- '<branch>': Review changes compared to a branch (e.g., 'main')
- '<commit>': Review a specific commit

**Example usage:**
- Review staged changes: { "target": "staged" }
- Review against main: { "target": "main" }
- Review a commit: { "target": "abc1234" }
- Review feature branch: { "target": "feature/login", "base": "main" }`,
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: "Target to review: 'staged', 'unstaged', 'head', branch name, or commit hash. Default: 'staged'",
        default: 'staged',
      },
      base: {
        type: 'string',
        description: 'Base reference for branch comparisons (e.g., main, develop)',
      },
      include_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'File patterns to include in review (glob patterns)',
      },
      options: {
        type: 'object',
        description: 'Review options (same as review_changes tool)',
        properties: {
          confidence_threshold: {
            type: 'number',
            description: 'Minimum confidence score (0-1) for findings. Default: 0.7',
          },
          max_findings: {
            type: 'number',
            description: 'Maximum number of findings to return. Default: 20',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categories to focus on (correctness, security, performance, etc.)',
          },
          changed_lines_only: {
            type: 'boolean',
            description: 'Only report issues on changed lines (P0 issues always included). Default: true',
          },
          custom_instructions: {
            type: 'string',
            description: 'Additional instructions for the reviewer',
          },
          llm_timeout_ms: {
            type: 'number',
            description: 'Optional AI timeout override in milliseconds for this review call (1000-1800000).',
            minimum: 1000,
            maximum: 1800000,
          },
          exclude_patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'File patterns to exclude from review',
          },
        },
      },
    },
    required: [],
  },
};

// ============================================================================
// Handler
// ============================================================================

export async function handleReviewGitDiff(
  args: ReviewGitDiffArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { target = 'staged', base, include_patterns = [], options = {} } = args;

  console.error(`[review_git_diff] Starting review for target: ${target}`);

  // Get workspace path from service client
  const workspacePath = serviceClient.getWorkspacePath();
  const diffSource = await getReviewDiffSource({
    workspacePath,
    target,
    base,
    include_patterns,
  });

  // Block no-op scopes so operators do not mistake empty input for a completed review.
  if (!diffSource.diff.trim() || diffSource.changed_files.length === 0) {
    throw buildEmptyReviewDiffScopeError(diffSource, 'review_git_diff');
  }

  console.error(`[review_git_diff] Found ${diffSource.changed_files.length} files changed`);
  console.error(`[review_git_diff] Stats: +${diffSource.stats.additions}/-${diffSource.stats.deletions}`);

  // Perform the code review using CodeReviewService
  const reviewService = internalCodeReviewService(serviceClient);
  const reviewResult = await reviewService.reviewChanges({
    diff: diffSource.diff,
    options: {
      ...options,
      // Default changed_lines_only to true for git reviews
      changed_lines_only: options.changed_lines_only ?? true,
    },
  });

  // Build the output
  const output: ReviewGitDiffOutput = {
    git_info: {
      target,
      base,
      command: diffSource.command,
      files_changed: diffSource.changed_files,
      stats: diffSource.stats,
    },
    review: reviewResult,
  };

  console.error(`[review_git_diff] Review complete: ${reviewResult.overall_correctness} (${reviewResult.findings.length} findings)`);

  return JSON.stringify(output, null, 2);
}
