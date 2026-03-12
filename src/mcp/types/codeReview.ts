/**
 * Code Review Type Definitions
 *
 * Enhanced types for AI-powered code review based on competitive analysis
 * of CodeRabbit, OpenAI Codex, Microsoft PRAssistant, and Google AutoCommenter.
 *
 * Key features:
 * - Structured output schema (Codex-style)
 * - Confidence scoring per finding and overall
 * - Priority levels (P0-P3)
 * - Line-level code location
 */

// ============================================================================
// Review Categories (from industry best practices)
// ============================================================================

/**
 * Categories of code review findings based on industry standards
 */
export type ReviewCategory =
  | 'correctness'      // Bugs, logic errors, edge cases
  | 'security'         // Vulnerabilities, injection risks, authentication issues
  | 'performance'      // Inefficiencies, memory leaks, N+1 queries
  | 'maintainability'  // Code clarity, modularity, test coverage
  | 'style'            // Formatting, naming conventions
  | 'documentation';   // Comments, docstrings, API docs

/**
 * Priority levels for findings (Codex-style P0-P3)
 * P0: Critical - must fix before merge
 * P1: High - should fix before merge
 * P2: Medium - consider fixing
 * P3: Low - nice to have, can defer
 */
export type ReviewPriority = 0 | 1 | 2 | 3;

/**
 * Overall correctness verdict for the reviewed changes
 */
export type CorrectnessVerdict =
  | 'patch is correct'
  | 'patch is incorrect'
  | 'needs attention';

// ============================================================================
// Code Location Types
// ============================================================================

/**
 * Line range within a file
 */
export interface LineRange {
  /** Starting line number (1-indexed) */
  start: number;
  /** Ending line number (1-indexed, inclusive) */
  end: number;
}

/**
 * Location of code within the codebase
 */
export interface CodeLocation {
  /** File path relative to workspace root */
  file_path: string;
  /** Line range where the issue is located */
  line_range: LineRange;
}

// ============================================================================
// Fix Suggestion Types
// ============================================================================

/**
 * Suggested fix for a review finding
 */
export interface FixSuggestion {
  /** Description of the fix */
  description: string;
  /** Code snippet demonstrating the fix (optional) */
  code_snippet?: string;
  /** Whether this fix can be applied automatically */
  can_auto_fix: boolean;
}

// ============================================================================
// Review Finding (Core Type)
// ============================================================================

/**
 * A single finding from the code review
 *
 * Based on OpenAI Codex structured output schema with enhancements
 * from Google AutoCommenter and CodeRabbit patterns.
 */
export interface ReviewFinding {
  /** Unique identifier for this finding */
  id: string;

  /** Short title (max 80 chars) - concise headline */
  title: string;

  /** Detailed explanation of the issue */
  body: string;

  /** Confidence score (0-1) - per-finding confidence */
  confidence_score: number;

  /** Priority level (P0=critical, P3=low) */
  priority: ReviewPriority;

  /** Category of the finding */
  category: ReviewCategory;

  /** Location in the code */
  code_location: CodeLocation;

  /** Suggested fix (optional) */
  suggestion?: FixSuggestion;

  /** Whether this finding is on a changed line */
  is_on_changed_line: boolean;
}

// ============================================================================
// Review Result (Main Output)
// ============================================================================

/**
 * Complete result of a code review
 *
 * This is the main structured output from the review_changes tool.
 */
export interface ReviewResult {
  /** List of findings, ordered by priority */
  findings: ReviewFinding[];

  /** Overall correctness verdict */
  overall_correctness: CorrectnessVerdict;

  /** High-level explanation of the review */
  overall_explanation: string;

  /** Overall confidence score (0-1) */
  overall_confidence_score: number;

  /** Summary of changes reviewed */
  changes_summary: {
    files_changed: number;
    lines_added: number;
    lines_removed: number;
  };

  /** Metadata about the review */
  metadata: ReviewMetadata;
}

// ============================================================================
// Review Metadata
// ============================================================================

/**
 * Metadata about the code review process
 */
export interface ReviewMetadata {
  /** Timestamp when review was performed */
  reviewed_at: string;

  /** Time taken to perform review (milliseconds) */
  review_duration_ms: number;

  /** Model or engine used for review */
  model_used: string;

  /** Version of the review tool */
  tool_version: string;

  /** Number of findings filtered out (below threshold) */
  findings_filtered: number;

  /** Confidence threshold used */
  confidence_threshold: number;

  /** Categories included in review */
  categories_reviewed: ReviewCategory[];
}

// ============================================================================
// Review Input Types
// ============================================================================

/**
 * Options for filtering and customizing the review
 */
export interface ReviewOptions {
  /** Minimum confidence score to include findings (0-1, default: 0.7) */
  confidence_threshold?: number;

  /** Maximum number of findings to return (default: 20) */
  max_findings?: number;

  /** Categories to include (default: all) */
  categories?: ReviewCategory[];

  /** Whether to only report issues on changed lines (default: true) */
  changed_lines_only?: boolean;

  /** Custom instructions for the reviewer */
  custom_instructions?: string;

  /** File patterns to exclude from review (glob patterns) */
  exclude_patterns?: string[];

  /** Optional AI timeout override in milliseconds for this review call */
  llm_timeout_ms?: number;
}

/**
 * Input for the review_changes tool
 */
export interface ReviewChangesInput {
  /** Diff content to review (unified diff format) */
  diff: string;

  /** Optional: File contents for context (path -> content) */
  file_contexts?: Record<string, string>;

  /** Optional: Base branch or commit for context */
  base_ref?: string;

  /** Optional: Review options */
  options?: ReviewOptions;
}

// ============================================================================
// Diff Parsing Types
// ============================================================================

/**
 * A single hunk from a diff
 */
export interface DiffHunk {
  /** Original file start line */
  old_start: number;
  /** Original file line count */
  old_lines: number;
  /** New file start line */
  new_start: number;
  /** New file line count */
  new_lines: number;
  /** Lines in this hunk */
  lines: DiffLine[];
}

/**
 * A single line from a diff
 */
export interface DiffLine {
  /** Type of change */
  type: 'add' | 'remove' | 'context';
  /** Line content (without +/- prefix) */
  content: string;
  /** Line number in old file (for context and remove) */
  old_line_number?: number;
  /** Line number in new file (for context and add) */
  new_line_number?: number;
}

/**
 * A parsed diff file
 */
export interface ParsedDiffFile {
  /** Old file path */
  old_path: string;
  /** New file path */
  new_path: string;
  /** Whether file was added */
  is_new: boolean;
  /** Whether file was deleted */
  is_deleted: boolean;
  /** Whether file is binary */
  is_binary: boolean;
  /** Hunks in this file */
  hunks: DiffHunk[];
  /** Set of changed line numbers in new file */
  changed_lines: Set<number>;
}

/**
 * Complete parsed diff
 */
export interface ParsedDiff {
  /** Files in the diff */
  files: ParsedDiffFile[];
  /** Total lines added */
  lines_added: number;
  /** Total lines removed */
  lines_removed: number;
}

// ============================================================================
// Export all types
// ============================================================================

export type {
  ReviewCategory as Category,
  ReviewPriority as Priority,
};
