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
