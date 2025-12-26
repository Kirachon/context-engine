import type { FindingSeverity, ReviewCategory } from '../../types.js';

export type InvariantAction = 'deny' | 'require' | 'when_require';

export interface InvariantRegex {
  /** JavaScript regex pattern (without delimiters) */
  pattern: string;
  /** Regex flags, e.g. "i", "m" */
  flags?: string;
}

export interface ReviewInvariant {
  id: string;
  /**
   * Human readable policy statement. May be informational only unless `action` + regex fields are provided.
   */
  rule: string;
  /** Glob patterns for file paths this invariant applies to */
  paths: string[];
  severity: FindingSeverity;
  category: ReviewCategory;

  /**
   * Deterministic check type.
   * - deny: fails if `deny.regex` matches added lines
   * - require: fails if `require.regex` does NOT match added lines
   * - when_require: if `when.regex` matches, then `require.regex` must match
   */
  action?: InvariantAction;

  when?: { regex: InvariantRegex };
  require?: { regex: InvariantRegex };
  deny?: { regex: InvariantRegex };
}

export interface InvariantsConfig {
  [category: string]: ReviewInvariant[];
}

