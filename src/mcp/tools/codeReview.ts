/**
 * Layer 3: MCP Interface Layer - Code Review Tool
 *
 * Exposes AI-powered code review capabilities as an MCP tool.
 * Implements structured output schema, confidence scoring, and changed lines filtering.
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to CodeReviewService layer
 * - Format review output for optimal consumption
 *
 * Tools:
 * - review_changes: Review code changes from a diff
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalCodeReviewService } from '../../internal/handlers/codeReview.js';
import {
  ReviewResult,
  ReviewChangesInput,
  ReviewOptions,
  ReviewCategory,
} from '../types/codeReview.js';

// ============================================================================
// Tool Argument Types
// ============================================================================

export interface ReviewChangesArgs {
  /** Diff content to review (unified diff format) */
  diff: string;
  /** File contexts for additional understanding (JSON object: path -> content) */
  file_contexts?: string;
  /** Base branch or commit reference */
  base_ref?: string;
  /** Minimum confidence score threshold (0-1, default: 0.7) */
  confidence_threshold?: number;
  /** Maximum number of findings to return (default: 20) */
  max_findings?: number;
  /** Categories to focus on (comma-separated, e.g., "correctness,security") */
  categories?: string;
  /** Only report issues on changed lines (default: true) */
  changed_lines_only?: boolean;
  /** Custom review instructions */
  custom_instructions?: string;
  /** File patterns to exclude (comma-separated glob patterns) */
  exclude_patterns?: string;
}

// ============================================================================
// Tool Handler
// ============================================================================

/**
 * Handle the review_changes tool call
 */
export async function handleReviewChanges(
  args: ReviewChangesArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const startTime = Date.now();

  try {
    console.error('[review_changes] Starting code review...');

    // Validate required arguments
    if (!args.diff || typeof args.diff !== 'string') {
      throw new Error('Missing or invalid "diff" argument. Provide a unified diff string.');
    }

    // Parse file contexts if provided
    let fileContexts: Record<string, string> | undefined;
    if (args.file_contexts) {
      try {
        fileContexts = JSON.parse(args.file_contexts);
      } catch {
        throw new Error('Invalid "file_contexts" JSON format');
      }
    }

    // Parse categories if provided
    let categories: ReviewCategory[] | undefined;
    if (args.categories) {
      categories = args.categories.split(',').map(c => c.trim()) as ReviewCategory[];
      // Validate categories
      const validCategories: ReviewCategory[] = [
        'correctness', 'security', 'performance', 'maintainability', 'style', 'documentation'
      ];
      for (const cat of categories) {
        if (!validCategories.includes(cat)) {
          throw new Error(`Invalid category: "${cat}". Valid: ${validCategories.join(', ')}`);
        }
      }
    }

    // Parse exclude patterns if provided
    let excludePatterns: string[] | undefined;
    if (args.exclude_patterns) {
      excludePatterns = args.exclude_patterns.split(',').map(p => p.trim());
    }

    // Build review options
    const options: ReviewOptions = {
      confidence_threshold: args.confidence_threshold,
      max_findings: args.max_findings,
      categories,
      changed_lines_only: args.changed_lines_only,
      custom_instructions: args.custom_instructions,
      exclude_patterns: excludePatterns,
    };

    // Build review input
    const input: ReviewChangesInput = {
      diff: args.diff,
      file_contexts: fileContexts,
      base_ref: args.base_ref,
      options,
    };

    // Get service and perform review
    const service = internalCodeReviewService(serviceClient);
    const result: ReviewResult = await service.reviewChanges(input);

    const elapsed = Date.now() - startTime;
    console.error(`[review_changes] Completed in ${elapsed}ms with ${result.findings.length} findings`);

    // Return formatted JSON result
    return JSON.stringify(result, null, 2);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[review_changes] Failed: ${errorMessage}`);
    throw new Error(`Code review failed: ${errorMessage}`);
  }
}

// ============================================================================
// Tool Schema Definition
// ============================================================================

/**
 * Tool schema definition for MCP registration
 */
export const reviewChangesTool = {
  name: 'review_changes',
  description: `Review code changes from a diff using AI-powered analysis.

This tool performs a structured code review on a unified diff, identifying issues
across correctness, security, performance, maintainability, style, and documentation.

**Key Features:**
- Structured output with findings, priority levels (P0-P3), and confidence scores
- Changed lines filter: focuses on modified code (can be toggled)
- Confidence scoring: each finding has a 0-1 confidence score
- Actionable suggestions: includes fix suggestions where applicable

**Priority Levels:**
- P0 (Critical): Must fix before merge - bugs, security vulnerabilities
- P1 (High): Should fix before merge - likely bugs, significant issues
- P2 (Medium): Consider fixing - code smells, minor issues
- P3 (Low): Nice to have - style issues, minor improvements

**Categories:**
- correctness: Bugs, logic errors, edge cases
- security: Vulnerabilities, injection risks, auth issues
- performance: Inefficiencies, memory leaks, N+1 queries
- maintainability: Code clarity, modularity, complexity
- style: Formatting, naming conventions
- documentation: Comments, docstrings, API docs

**Output Schema:**
Returns JSON with: findings[], overall_correctness, overall_explanation,
overall_confidence_score, changes_summary, and metadata.

**Usage Examples:**
1. Basic review: Provide diff content
2. Focused review: Set categories="security,correctness"
3. Strict review: Set confidence_threshold=0.8
4. Include context lines: Set changed_lines_only=false`,

  inputSchema: {
    type: 'object',
    properties: {
      diff: {
        type: 'string',
        description: 'The unified diff content to review (from git diff, etc.)',
      },
      file_contexts: {
        type: 'string',
        description: 'Optional JSON object mapping file paths to file contents for additional context',
      },
      base_ref: {
        type: 'string',
        description: 'Optional base branch or commit reference for context',
      },
      confidence_threshold: {
        type: 'number',
        description: 'Minimum confidence score (0-1) to include findings. Default: 0.7',
        minimum: 0,
        maximum: 1,
        default: 0.7,
      },
      max_findings: {
        type: 'number',
        description: 'Maximum number of findings to return. Default: 20',
        minimum: 1,
        maximum: 100,
        default: 20,
      },
      categories: {
        type: 'string',
        description: 'Comma-separated categories to focus on. Options: correctness, security, performance, maintainability, style, documentation',
      },
      changed_lines_only: {
        type: 'boolean',
        description: 'Only report issues on changed lines. Default: true',
        default: true,
      },
      custom_instructions: {
        type: 'string',
        description: 'Custom instructions for the reviewer (e.g., "Focus on React best practices")',
      },
      exclude_patterns: {
        type: 'string',
        description: 'Comma-separated glob patterns for files to exclude (e.g., "*.test.ts,*.spec.js")',
      },
    },
    required: ['diff'],
  },
};
