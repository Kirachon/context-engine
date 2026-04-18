'use strict';

import { describe, it, expect } from '@jest/globals';
import {
  listProviderDescriptors,
  getProviderDescriptor,
  isKnownProviderId,
  isStableProviderId,
} from '../../../src/ai/providers/registry.js';

describe('provider descriptor registry', () => {
  it('lists exactly one entry: openai_session, stable, with conservative adapter capabilities', () => {
    const arr = listProviderDescriptors();
    expect(arr).toHaveLength(1);
    const d = arr[0];
    expect(d.id).toBe('openai_session');
    expect(d.tier).toBe('stable');
    expect(d.capabilities.streaming).toBe(false);
    expect(d.capabilities.toolCalls).toBe(false);
    expect(d.capabilities.structuredOutput).toBe(false);
  });

  it('returned array is frozen', () => {
    const arr = listProviderDescriptors();
    expect(Object.isFrozen(arr)).toBe(true);
  });

  it('descriptor object is frozen', () => {
    const d = listProviderDescriptors()[0];
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('descriptor capabilities object is frozen', () => {
    const d = listProviderDescriptors()[0];
    expect(Object.isFrozen(d.capabilities)).toBe(true);
  });

  it('mutating attempts throw in strict mode', () => {
    const arr = listProviderDescriptors();
    const d = arr[0];
    expect(() => {
      (arr as any).push({});
    }).toThrow();
    expect(() => {
      (d as any).id = 'x';
    }).toThrow();
    expect(() => {
      (d.capabilities as any).streaming = false;
    }).toThrow();
  });

  it('getProviderDescriptor returns the same reference as the registry entry', () => {
    const fromList = listProviderDescriptors()[0];
    const fromGet = getProviderDescriptor('openai_session');
    expect(fromGet).toBe(fromList);
  });

  it('getProviderDescriptor returns undefined for unknown id', () => {
    expect(getProviderDescriptor('copilot')).toBeUndefined();
  });

  it('getProviderDescriptor returns undefined for empty string', () => {
    expect(getProviderDescriptor('')).toBeUndefined();
  });

  it('isKnownProviderId behaves correctly', () => {
    expect(isKnownProviderId('openai_session')).toBe(true);
    expect(isKnownProviderId('copilot')).toBe(false);
    expect(isKnownProviderId('')).toBe(false);
  });

  it('isStableProviderId behaves correctly', () => {
    expect(isStableProviderId('openai_session')).toBe(true);
    expect(isStableProviderId('copilot')).toBe(false);
    expect(isStableProviderId('')).toBe(false);
  });

  it('two calls return arrays whose contents deep-equal each other', () => {
    const a = listProviderDescriptors();
    const b = listProviderDescriptors();
    expect(a).toEqual(b);
  });

  it('no descriptor is experimental or shadow_only', () => {
    const arr = listProviderDescriptors();
    for (const d of arr) {
      expect(d.tier).not.toBe('experimental');
      expect(d.tier).not.toBe('shadow_only');
    }
  });
});
