/**
 * Shared diff input parsing/validation helpers for MCP tools.
 *
 * These utilities keep semantics simple so each tool can preserve existing
 * public error behavior while reusing consistent diff handling.
 */

import { validateNonEmptyString } from './validation.js';
import { parseUnifiedDiff } from '../../reviewer/diff/parse.js';

export const NO_REVIEWABLE_DIFF_SCOPE_MESSAGE =
  'No reviewable changes found in diff scope. Provide a unified diff with at least one changed file.';

/**
 * Normalize an optional diff argument by trimming whitespace.
 * Returns `undefined` for missing, non-string, or empty values.
 */
export function normalizeOptionalDiffInput(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize and validate a required diff argument.
 */
export function normalizeRequiredDiffInput(value: unknown, missingOrInvalidMessage: string): string {
  return validateNonEmptyString(normalizeOptionalDiffInput(value), missingOrInvalidMessage);
}

/**
 * Lightweight shape check for unified diffs.
 * Supports git-style headers and patch-style hunks.
 */
export function looksLikeUnifiedDiff(diff: string): boolean {
  const normalized = diff.trimStart();
  if (normalized.startsWith('diff --git ')) {
    return true;
  }
  const hasFileHeaders = normalized.includes('\n--- ') && normalized.includes('\n+++ ');
  const hasHunkHeader = normalized.includes('\n@@ ');
  return hasFileHeaders || hasHunkHeader;
}

/**
 * Reusable helper for tools that require a valid diff and optionally require
 * unified-diff shape.
 */
export function parseRequiredDiffInput(
  value: unknown,
  missingOrInvalidMessage: string,
  invalidUnifiedDiffMessage?: string
): string {
  const diff = normalizeRequiredDiffInput(value, missingOrInvalidMessage);
  if (invalidUnifiedDiffMessage && !looksLikeUnifiedDiff(diff)) {
    throw new Error(invalidUnifiedDiffMessage);
  }
  return diff;
}

/**
 * Guard against no-op review scopes where the diff parser yields no changed files
 * and the caller did not provide an explicit changed_files override.
 */
export function assertNonEmptyDiffScope(
  diff: string,
  changedFiles: string[] | undefined,
  noScopeMessage: string = NO_REVIEWABLE_DIFF_SCOPE_MESSAGE
): void {
  const parsed = parseUnifiedDiff(diff);
  const hasParsedChangedFiles = parsed.files.length > 0;
  const hasProvidedChangedFiles = Array.isArray(changedFiles)
    && changedFiles.some((filePath) => typeof filePath === 'string' && filePath.trim().length > 0);

  if (!hasParsedChangedFiles && !hasProvidedChangedFiles) {
    throw new Error(noScopeMessage);
  }
}
