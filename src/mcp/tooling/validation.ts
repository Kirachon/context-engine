/**
 * Shared validation helpers for MCP tool arguments.
 *
 * These helpers intentionally keep validation semantics simple so tools can
 * preserve their existing behavior and error messages.
 */

import {
  validateAndNormalizeExternalSources,
  type NormalizedExternalSource,
} from './externalGrounding.js';

export function validateNonEmptyString(value: unknown, errorMessage: string): string {
  if (!value || typeof value !== 'string') {
    throw new Error(errorMessage);
  }
  return value;
}

export function validateTrimmedNonEmptyString(value: unknown, errorMessage: string): string {
  const validated = validateNonEmptyString(value, errorMessage).trim();
  if (!validated) {
    throw new Error(errorMessage);
  }
  return validated;
}

export function validateMaxLength(value: string, maxLength: number, errorMessage: string): void {
  if (value.length > maxLength) {
    throw new Error(errorMessage);
  }
}

export function validateOptionalString(
  value: unknown,
  typeErrorMessage: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(typeErrorMessage);
  }
  return value;
}

export function validateTrimmedRequiredStringWithMaxLength(
  value: unknown,
  maxLength: number,
  missingMessage: string,
  maxLengthMessage: string
): string {
  const trimmed = validateTrimmedNonEmptyString(value, missingMessage);
  validateMaxLength(trimmed, maxLength, maxLengthMessage);
  return trimmed;
}

export function validateOptionalNonNegativeIntegerWithMax(
  value: unknown,
  integerErrorMessage: string,
  nonNegativeErrorMessage: string,
  maxValue: number,
  maxValueErrorMessage: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(integerErrorMessage);
  }
  if (value < 0) {
    throw new Error(nonNegativeErrorMessage);
  }
  if (value > maxValue) {
    throw new Error(maxValueErrorMessage);
  }

  return value;
}

export function validateNumberInRange(
  value: unknown,
  min: number,
  max: number,
  errorMessage: string
): void {
  if (value !== undefined && (typeof value !== 'number' || value < min || value > max)) {
    throw new Error(errorMessage);
  }
}

export function validateFiniteNumberInRange(
  value: unknown,
  min: number,
  max: number,
  errorMessage: string
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
  ) {
    throw new Error(errorMessage);
  }
}

export function validateBoolean(value: unknown, errorMessage: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(errorMessage);
  }
}

function normalizeScopeGlobPattern(pattern: string): string {
  let normalized = pattern.trim().replace(/\\/g, '/');

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  normalized = normalized.replace(/\/{2,}/g, '/');

  if (!normalized) {
    throw new Error('invalid');
  }
  if (/^(?:\/|[a-zA-Z]:\/|\/\/)/.test(normalized)) {
    throw new Error('invalid');
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('invalid');
  }

  if (normalized.endsWith('/')) {
    normalized = `${normalized.slice(0, -1)}/**`;
  }

  return normalized;
}

export function validatePathScopeGlobs(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid ${fieldName} parameter: must be an array of workspace-relative glob strings`
    );
  }

  const caseInsensitive = process.platform === 'win32';
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(
        `Invalid ${fieldName} parameter: must be an array of workspace-relative glob strings`
      );
    }

    let normalizedEntry: string;
    try {
      normalizedEntry = normalizeScopeGlobPattern(entry);
    } catch {
      throw new Error(
        `Invalid ${fieldName} parameter: must contain only workspace-relative glob strings`
      );
    }

    const dedupeKey = caseInsensitive ? normalizedEntry.toLowerCase() : normalizedEntry;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(normalizedEntry);
  }

  if (normalized.length === 0) {
    return undefined;
  }

  normalized.sort((left, right) => {
    const a = caseInsensitive ? left.toLowerCase() : left;
    const b = caseInsensitive ? right.toLowerCase() : right;
    return a.localeCompare(b);
  });

  return normalized;
}

export function validateRequiredNumber(value: unknown, errorMessage: string): number {
  if (typeof value !== 'number') {
    throw new Error(errorMessage);
  }
  return value;
}

export function validateOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  errorMessage: string
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(errorMessage);
  }
}

export function validateLineRange(
  startLine: number | undefined,
  endLine: number | undefined,
  errorMessage: string
): void {
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error(errorMessage);
  }
}

export function parseJsonString<T = unknown>(value: unknown, errorMessage: string): T {
  if (typeof value !== 'string') {
    throw new Error(errorMessage);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

export function validateExternalSources(
  value: unknown,
  fieldName = 'external_sources'
): NormalizedExternalSource[] | undefined {
  try {
    return validateAndNormalizeExternalSources(value, fieldName);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message.replace(/^Invalid external_sources/u, `Invalid ${fieldName}`));
    }
    throw error;
  }
}

export function parseOptionalExternalSourcesJsonString(
  value: unknown,
  fieldName = 'external_sources'
): NormalizedExternalSource[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName} parameter: must be a JSON string when provided`);
  }
  if (value.trim().length === 0) {
    return undefined;
  }
  return validateExternalSources(
    parseJsonString(value, `Invalid ${fieldName} parameter: must be valid JSON`),
    fieldName
  );
}
