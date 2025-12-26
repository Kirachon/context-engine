/**
 * Code Review Service
 *
 * Service layer for AI-powered code review with structured output.
 * Implements P0 priority features from competitive analysis:
 * - Structured output schema (Codex-style)
 * - Confidence scoring per finding and overall
 * - Changed lines filter
 * - Priority classification (P0-P3)
 *
 * Responsibilities:
 * - Parse and analyze diffs
 * - Filter findings by confidence threshold
 * - Generate structured review results
 * - Provide actionable suggestions
 */

import { ContextServiceClient } from '../serviceClient.js';
import {
  ReviewResult,
  ReviewFinding,
  ReviewOptions,
  ReviewChangesInput,
  ParsedDiff,
  ReviewMetadata,
} from '../types/codeReview.js';
import { parseUnifiedDiff } from '../../reviewer/diff/parse.js';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewPrompt,
  extractJsonFromResponse,
  validateReviewResult,
} from '../prompts/codeReview.js';
import { postProcessReviewFindings } from './codeReviewPost.js';

// ============================================================================
// Constants
// ============================================================================

/** Tool version for metadata */
const TOOL_VERSION = '1.0.0';

/** Default review options */
const DEFAULT_OPTIONS: Required<ReviewOptions> = {
  confidence_threshold: 0.7,
  max_findings: 20,
  categories: ['correctness', 'security', 'performance', 'maintainability', 'style', 'documentation'],
  changed_lines_only: true,
  custom_instructions: '',
  exclude_patterns: [],
};

// ============================================================================
// Code Review Service Class
// ============================================================================

export class CodeReviewService {
  private contextClient: ContextServiceClient;

  constructor(contextClient: ContextServiceClient) {
    this.contextClient = contextClient;
  }

  private resolveOptions(options?: ReviewOptions): Required<ReviewOptions> {
    return {
      confidence_threshold: options?.confidence_threshold ?? DEFAULT_OPTIONS.confidence_threshold,
      max_findings: options?.max_findings ?? DEFAULT_OPTIONS.max_findings,
      categories: options?.categories ? [...options.categories] : [...DEFAULT_OPTIONS.categories],
      changed_lines_only: options?.changed_lines_only ?? DEFAULT_OPTIONS.changed_lines_only,
      custom_instructions: options?.custom_instructions ?? DEFAULT_OPTIONS.custom_instructions,
      exclude_patterns: options?.exclude_patterns ? [...options.exclude_patterns] : [...DEFAULT_OPTIONS.exclude_patterns],
    };
  }

  // ==========================================================================
  // Core Review Method
  // ==========================================================================

  /**
   * Review code changes from a diff
   */
  async reviewChanges(input: ReviewChangesInput): Promise<ReviewResult> {
    const startTime = Date.now();
    const opts = this.resolveOptions(input.options);

    console.error(`[CodeReviewService] Starting code review...`);

    try {
      // Step 1: Parse the diff to understand the changes
      const parsedDiff = this.parseDiff(input.diff);
      console.error(`[CodeReviewService] Parsed diff: ${parsedDiff.files.length} files, +${parsedDiff.lines_added}/-${parsedDiff.lines_removed}`);

      // Step 2: Filter out excluded files
      const filteredDiff = this.filterExcludedFiles(parsedDiff, opts.exclude_patterns);

      // Step 3: Build the review prompt
      const reviewPrompt = buildCodeReviewPrompt(
        input.diff,
        input.file_contexts || {},
        opts
      );

      // Step 4: Combine system prompt with review prompt
      const fullPrompt = `${CODE_REVIEW_SYSTEM_PROMPT}\n\n${reviewPrompt}`;

      // Step 5: Call AI to perform the review
      const response = await this.contextClient.searchAndAsk(
        'Review code changes for issues',
        fullPrompt
      );

      // Step 6: Parse and validate the response
      const jsonStr = extractJsonFromResponse(response);
      if (!jsonStr) {
        throw new Error('Failed to extract JSON from LLM response');
      }

      let rawResult: Record<string, unknown>;
      try {
        rawResult = JSON.parse(jsonStr);
      } catch {
        throw new Error('Failed to parse review JSON response');
      }

      if (!validateReviewResult(rawResult)) {
        throw new Error('Invalid review result structure');
      }

      // Step 7: Filter findings by confidence threshold
      const findings = this.filterFindings(
        rawResult.findings as ReviewFinding[],
        parsedDiff,
        opts
      );

      // Step 8: Build the final result
      const result: ReviewResult = {
        findings,
        overall_correctness: rawResult.overall_correctness as ReviewResult['overall_correctness'],
        overall_explanation: rawResult.overall_explanation as string,
        overall_confidence_score: rawResult.overall_confidence_score as number,
        changes_summary: {
          files_changed: filteredDiff.files.length,
          lines_added: filteredDiff.lines_added,
          lines_removed: filteredDiff.lines_removed,
        },
        metadata: this.buildMetadata(startTime, opts, findings.length),
      };

      console.error(`[CodeReviewService] Review complete: ${findings.length} findings`);
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CodeReviewService] Review failed: ${errorMessage}`);

      // Return an error result
      return {
        findings: [],
        overall_correctness: 'needs attention',
        overall_explanation: `Review failed: ${errorMessage}`,
        overall_confidence_score: 0,
        changes_summary: { files_changed: 0, lines_added: 0, lines_removed: 0 },
        metadata: this.buildMetadata(startTime, opts, 0),
      };
    }
  }

  // ==========================================================================
  // Diff Parsing
  // ==========================================================================

  /**
   * Parse a unified diff into a structured format
   */
  parseDiff(diffContent: string): ParsedDiff {
    return parseUnifiedDiff(diffContent);
  }

  // ==========================================================================
  // Filtering Methods (Public for testing)
  // ==========================================================================

  /**
   * Filter out files matching exclude patterns
   * @public - exposed for unit testing
   */
  filterExcludedFiles(diff: ParsedDiff, excludePatterns: string[]): ParsedDiff {
    if (excludePatterns.length === 0) {
      return diff;
    }

    const filteredFiles = diff.files.filter(file => {
      return !excludePatterns.some(pattern => {
        // Simple glob matching (just * for now)
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(file.new_path) || regex.test(file.old_path);
      });
    });

    return {
      files: filteredFiles,
      lines_added: filteredFiles.reduce(
        (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'add').length, 0),
        0
      ),
      lines_removed: filteredFiles.reduce(
        (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'remove').length, 0),
        0
      ),
    };
  }

  /**
   * Filter findings by confidence threshold and options
   * @public - exposed for unit testing
   */
  filterFindings(
    findings: ReviewFinding[],
    parsedDiff: ParsedDiff,
    opts: Required<ReviewOptions>
  ): ReviewFinding[] {
    // Preserve existing behavior by delegating to the shared post-processor.
    // (parsedDiff currently isn't used in the filtering logic but is kept for API stability.)
    return postProcessReviewFindings({ findings, parsedDiff, opts });
  }

  // ==========================================================================
  // Metadata Builder
  // ==========================================================================

  /**
   * Build review metadata
   */
  private buildMetadata(
    startTime: number,
    opts: Required<ReviewOptions>,
    findingsFiltered: number
  ): ReviewMetadata {
    return {
      reviewed_at: new Date().toISOString(),
      review_duration_ms: Date.now() - startTime,
      model_used: 'auggie-context-engine',
      tool_version: TOOL_VERSION,
      findings_filtered: findingsFiltered,
      confidence_threshold: opts.confidence_threshold,
      categories_reviewed: opts.categories,
    };
  }
}
