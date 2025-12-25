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
  ParsedDiffFile,
  DiffHunk,
  DiffLine,
  ReviewCategory,
  ReviewMetadata,
} from '../types/codeReview.js';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewPrompt,
  extractJsonFromResponse,
  validateReviewResult,
} from '../prompts/codeReview.js';

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

  // ==========================================================================
  // Core Review Method
  // ==========================================================================

  /**
   * Review code changes from a diff
   */
  async reviewChanges(input: ReviewChangesInput): Promise<ReviewResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...input.options };

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
    const files: ParsedDiffFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    // Split by file headers
    const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    const matches = [...diffContent.matchAll(fileRegex)];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const oldPath = match[1];
      const newPath = match[2];
      const startIdx = match.index!;
      const endIdx = matches[i + 1]?.index ?? diffContent.length;
      const fileSection = diffContent.slice(startIdx, endIdx);

      const file = this.parseFileSection(fileSection, oldPath, newPath);
      files.push(file);
      totalAdded += file.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'add').length, 0);
      totalRemoved += file.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.type === 'remove').length, 0);
    }

    return {
      files,
      lines_added: totalAdded,
      lines_removed: totalRemoved,
    };
  }

  /**
   * Parse a single file section from a diff
   */
  private parseFileSection(section: string, oldPath: string, newPath: string): ParsedDiffFile {
    const isNew = section.includes('new file mode');
    const isDeleted = section.includes('deleted file mode');
    const isBinary = section.includes('Binary files');

    const hunks: DiffHunk[] = [];
    const changedLines = new Set<number>();

    // Parse hunks
    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    const hunkMatches = [...section.matchAll(hunkRegex)];

    for (let i = 0; i < hunkMatches.length; i++) {
      const hunkMatch = hunkMatches[i];
      const hunkStart = hunkMatch.index!;
      const hunkEnd = hunkMatches[i + 1]?.index ?? section.length;
      const hunkContent = section.slice(hunkStart, hunkEnd);

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = parseInt(hunkMatch[2] || '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = parseInt(hunkMatch[4] || '1', 10);

      const lines = this.parseHunkLines(hunkContent, oldStart, newStart, changedLines);

      hunks.push({
        old_start: oldStart,
        old_lines: oldLines,
        new_start: newStart,
        new_lines: newLines,
        lines,
      });
    }

    return {
      old_path: oldPath,
      new_path: newPath,
      is_new: isNew,
      is_deleted: isDeleted,
      is_binary: isBinary,
      hunks,
      changed_lines: changedLines,
    };
  }

  /**
   * Parse lines within a hunk
   * @param hunkContent - The raw hunk content including the @@ header
   * @param oldStart - Starting line number in the old file
   * @param newStart - Starting line number in the new file
   * @param changedLines - Set to accumulate changed line numbers (in new file)
   */
  private parseHunkLines(
    hunkContent: string,
    oldStart: number,
    newStart: number,
    changedLines: Set<number>
  ): DiffLine[] {
    const lines: DiffLine[] = [];
    const contentLines = hunkContent.split('\n').slice(1); // Skip the @@ header

    let newLineNum = newStart;
    let oldLineNum = oldStart; // Properly track old file line numbers

    for (const line of contentLines) {
      if (line.startsWith('+')) {
        lines.push({
          type: 'add',
          content: line.slice(1),
          new_line_number: newLineNum,
        });
        changedLines.add(newLineNum);
        newLineNum++;
      } else if (line.startsWith('-')) {
        lines.push({
          type: 'remove',
          content: line.slice(1),
          old_line_number: oldLineNum,
        });
        oldLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        lines.push({
          type: 'context',
          content: line.slice(1) || '',
          old_line_number: oldLineNum,
          new_line_number: newLineNum,
        });
        oldLineNum++;
        newLineNum++;
      }
    }

    return lines;
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
    let filtered = findings;

    // Filter by confidence threshold
    filtered = filtered.filter(f => f.confidence_score >= opts.confidence_threshold);

    // Filter by changed lines if enabled
    if (opts.changed_lines_only) {
      filtered = filtered.filter(f => {
        // Always include P0 findings
        if (f.priority === 0) return true;
        // Include findings on changed lines
        return f.is_on_changed_line;
      });
    }

    // Filter by categories if specified
    if (opts.categories.length > 0) {
      filtered = filtered.filter(f => opts.categories.includes(f.category));
    }

    // Sort by priority (lower is higher priority)
    filtered.sort((a, b) => a.priority - b.priority);

    // Limit to max findings
    filtered = filtered.slice(0, opts.max_findings);

    return filtered;
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
