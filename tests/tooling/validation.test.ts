import { describe, expect, it } from '@jest/globals';
import {
  parseJsonString,
  validateBoolean,
  validateLineRange,
  validateMaxLength,
  validateNonEmptyString,
  validateNumberInRange,
  validateOneOf,
} from '../../src/mcp/tooling/validation.js';

describe('mcp tooling validation helpers', () => {
  it('validateNonEmptyString returns value for valid strings', () => {
    expect(validateNonEmptyString('value', 'bad')).toBe('value');
  });

  it('validateNonEmptyString throws for empty input', () => {
    expect(() => validateNonEmptyString('', 'bad')).toThrow('bad');
  });

  it('validateMaxLength throws when over max', () => {
    expect(() => validateMaxLength('abc', 2, 'too long')).toThrow('too long');
  });

  it('validateNumberInRange accepts undefined', () => {
    expect(() => validateNumberInRange(undefined, 1, 10, 'bad')).not.toThrow();
  });

  it('validateNumberInRange throws for out-of-range values', () => {
    expect(() => validateNumberInRange(11, 1, 10, 'bad')).toThrow('bad');
  });

  it('validateBoolean throws for non-boolean values', () => {
    expect(() => validateBoolean('true', 'bad')).toThrow('bad');
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
