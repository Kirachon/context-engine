/**
 * Git Review Tool
 *
 * MCP tool that combines git diff retrieval with code review.
 * Automatically retrieves diffs from git and reviews them.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { getGitDiff, getGitStatus, getCommitDiff, GitDiffOptions } from '../utils/gitUtils.js';
import { ReviewResult, ReviewOptions } from '../types/codeReview.js';
import { internalCodeReviewService } from '../../internal/handlers/codeReview.js';

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

  // Check if we're in a git repository
  const status = await getGitStatus(workspacePath);
  if (!status.is_git_repo) {
    throw new Error('Not a git repository. Please run this tool from within a git repository.');
  }

  // Get the diff based on target type
  let diffResult;
  
  // Check if target looks like a commit hash (7-40 hex chars)
  const isCommitHash = /^[a-f0-9]{7,40}$/i.test(target);
  
  if (isCommitHash) {
    console.error(`[review_git_diff] Getting diff for commit: ${target}`);
    diffResult = await getCommitDiff(workspacePath, target);
  } else {
    const diffOptions: GitDiffOptions = {
      target,
      base,
      pathPatterns: include_patterns,
    };
    console.error(`[review_git_diff] Getting diff with options:`, diffOptions);
    diffResult = await getGitDiff(workspacePath, diffOptions);
  }

  // Check if there's anything to review
  if (!diffResult.diff.trim()) {
    const emptyReview: ReviewResult = {
      findings: [],
      overall_correctness: 'patch is correct',
      overall_explanation: 'No changes to review.',
      overall_confidence_score: 1.0,
      changes_summary: {
        files_changed: 0,
        lines_added: 0,
        lines_removed: 0,
      },
      metadata: {
        reviewed_at: new Date().toISOString(),
        review_duration_ms: 0,
        model_used: 'none',
        tool_version: '1.5.0',
        findings_filtered: 0,
        confidence_threshold: 0.7,
        categories_reviewed: [],
      },
    };
    const output: ReviewGitDiffOutput = {
      git_info: {
        target,
        base,
        command: diffResult.command,
        files_changed: [],
        stats: { additions: 0, deletions: 0, files_count: 0 },
      },
      review: emptyReview,
    };
    return JSON.stringify(output, null, 2);
  }

  console.error(`[review_git_diff] Found ${diffResult.files_changed.length} files changed`);
  console.error(`[review_git_diff] Stats: +${diffResult.stats.additions}/-${diffResult.stats.deletions}`);

  // Perform the code review using CodeReviewService
  const reviewService = internalCodeReviewService(serviceClient);
  const reviewResult = await reviewService.reviewChanges({
    diff: diffResult.diff,
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
      command: diffResult.command,
      files_changed: diffResult.files_changed,
      stats: diffResult.stats,
    },
    review: reviewResult,
  };

  console.error(`[review_git_diff] Review complete: ${reviewResult.overall_correctness} (${reviewResult.findings.length} findings)`);

  return JSON.stringify(output, null, 2);
}
