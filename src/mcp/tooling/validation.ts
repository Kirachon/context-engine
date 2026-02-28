/**
 * Shared validation helpers for MCP tool arguments.
 *
 * These helpers intentionally keep validation semantics simple so tools can
 * preserve their existing behavior and error messages.
 */

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
