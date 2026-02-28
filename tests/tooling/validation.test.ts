import { describe, expect, it } from '@jest/globals';
import {
  validateFiniteNumberInRange,
  parseJsonString,
  validateBoolean,
  validateLineRange,
  validateMaxLength,
  validateNonEmptyString,
  validateOptionalNonNegativeIntegerWithMax,
  validateOptionalString,
  validateNumberInRange,
  validateRequiredNumber,
  validateTrimmedRequiredStringWithMaxLength,
  validateTrimmedNonEmptyString,
  validateOneOf,
} from '../../src/mcp/tooling/validation.js';

describe('mcp tooling validation helpers', () => {
  it('validateNonEmptyString returns value for valid strings', () => {
    expect(validateNonEmptyString('value', 'bad')).toBe('value');
  });

  it('validateNonEmptyString throws for empty input', () => {
    expect(() => validateNonEmptyString('', 'bad')).toThrow('bad');
  });

  it('validateTrimmedNonEmptyString returns trimmed value and rejects whitespace-only', () => {
    expect(validateTrimmedNonEmptyString('  value  ', 'bad')).toBe('value');
    expect(() => validateTrimmedNonEmptyString('   ', 'bad')).toThrow('bad');
  });

  it('validateMaxLength throws when over max', () => {
    expect(() => validateMaxLength('abc', 2, 'too long')).toThrow('too long');
  });

  it('validateOptionalString returns undefined for undefined and throws for non-string', () => {
    expect(validateOptionalString(undefined, 'bad')).toBeUndefined();
    expect(() => validateOptionalString(5, 'bad')).toThrow('bad');
  });

  it('validateTrimmedRequiredStringWithMaxLength trims and enforces max length', () => {
    expect(
      validateTrimmedRequiredStringWithMaxLength('  value  ', 10, 'missing', 'too long')
    ).toBe('value');
    expect(() =>
      validateTrimmedRequiredStringWithMaxLength('   ', 10, 'missing', 'too long')
    ).toThrow('missing');
    expect(() =>
      validateTrimmedRequiredStringWithMaxLength('abcdef', 3, 'missing', 'too long')
    ).toThrow('too long');
  });

  it('validateOptionalNonNegativeIntegerWithMax enforces integer/non-negative/max bounds', () => {
    expect(validateOptionalNonNegativeIntegerWithMax(undefined, 'int', 'nonneg', 10, 'max')).toBeUndefined();
    expect(validateOptionalNonNegativeIntegerWithMax(3, 'int', 'nonneg', 10, 'max')).toBe(3);
    expect(() => validateOptionalNonNegativeIntegerWithMax(1.5, 'int', 'nonneg', 10, 'max')).toThrow('int');
    expect(() => validateOptionalNonNegativeIntegerWithMax(-1, 'int', 'nonneg', 10, 'max')).toThrow('nonneg');
    expect(() => validateOptionalNonNegativeIntegerWithMax(11, 'int', 'nonneg', 10, 'max')).toThrow('max');
  });

  it('validateNumberInRange accepts undefined', () => {
    expect(() => validateNumberInRange(undefined, 1, 10, 'bad')).not.toThrow();
  });

  it('validateNumberInRange throws for out-of-range values', () => {
    expect(() => validateNumberInRange(11, 1, 10, 'bad')).toThrow('bad');
  });

  it('validateFiniteNumberInRange rejects non-finite values', () => {
    expect(() => validateFiniteNumberInRange(Number.NaN, 0, 10, 'bad')).toThrow('bad');
    expect(() => validateFiniteNumberInRange(Number.POSITIVE_INFINITY, 0, 10, 'bad')).toThrow('bad');
  });

  it('validateBoolean throws for non-boolean values', () => {
    expect(() => validateBoolean('true', 'bad')).toThrow('bad');
  });

  it('validateRequiredNumber accepts numbers and rejects non-number values', () => {
    expect(validateRequiredNumber(3, 'bad')).toBe(3);
    expect(() => validateRequiredNumber('3', 'bad')).toThrow('bad');
  });

  it('validateOneOf accepts allowed value', () => {
    expect(() => validateOneOf('fast', ['fast', 'deep'] as const, 'bad')).not.toThrow();
  });

  it('validateOneOf throws for invalid enum values', () => {
    expect(() => validateOneOf('turbo', ['fast', 'deep'] as const, 'bad')).toThrow('bad');
  });

  it('validateLineRange throws when start exceeds end', () => {
    expect(() => validateLineRange(5, 2, 'bad range')).toThrow('bad range');
  });

  it('parseJsonString parses valid JSON', () => {
    expect(parseJsonString<{ a: number }>('{\"a\":1}', 'bad json')).toEqual({ a: 1 });
  });

  it('parseJsonString throws for invalid JSON', () => {
    expect(() => parseJsonString('{oops}', 'bad json')).toThrow('bad json');
  });
});
