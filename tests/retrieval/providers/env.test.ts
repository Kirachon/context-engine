import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { resolveRetrievalProviderEnv, shouldRunShadowCompare } from '../../../src/retrieval/providers/env.js';

const ORIGINAL_ENV = { ...process.env };

describe('retrieval provider env resolution', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_RETRIEVAL_PROVIDER;
    delete process.env.CE_RETRIEVAL_FORCE_LEGACY;
    delete process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED;
    delete process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to augment_legacy with shadow compare disabled', () => {
    expect(resolveRetrievalProviderEnv()).toEqual({
      providerId: 'augment_legacy',
      forceLegacy: false,
      shadowCompareEnabled: false,
      shadowSampleRate: 0,
    });
  });

  it('accepts local_native provider when configured', () => {
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';

    expect(resolveRetrievalProviderEnv().providerId).toBe('local_native');
  });

  it('force legacy override pins provider to augment_legacy', () => {
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
    process.env.CE_RETRIEVAL_FORCE_LEGACY = 'true';

    const resolved = resolveRetrievalProviderEnv();
    expect(resolved.forceLegacy).toBe(true);
    expect(resolved.providerId).toBe('augment_legacy');
  });

  it('fails fast on invalid provider', () => {
    process.env.CE_RETRIEVAL_PROVIDER = 'invalid_provider';

    expect(() => resolveRetrievalProviderEnv()).toThrow(/Invalid CE_RETRIEVAL_PROVIDER value/i);
  });

  it('parses shadow compare flags and sample rate', () => {
    process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'on';
    process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '0.25';

    expect(resolveRetrievalProviderEnv()).toMatchObject({
      shadowCompareEnabled: true,
      shadowSampleRate: 0.25,
    });
  });

  it('fails on invalid shadow sample rate values', () => {
    process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = '1.1';
    expect(() => resolveRetrievalProviderEnv()).toThrow(/CE_RETRIEVAL_SHADOW_SAMPLE_RATE/i);

    process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = 'oops';
    expect(() => resolveRetrievalProviderEnv()).toThrow(/CE_RETRIEVAL_SHADOW_SAMPLE_RATE/i);
  });
});

describe('shadow compare sample-rate gating', () => {
  it('returns false when shadow compare is disabled', () => {
    expect(shouldRunShadowCompare({ shadowCompareEnabled: false, shadowSampleRate: 1 }, 0)).toBe(false);
  });

  it('returns false when sample rate is zero', () => {
    expect(shouldRunShadowCompare({ shadowCompareEnabled: true, shadowSampleRate: 0 }, 0)).toBe(false);
  });

  it('returns true when sample rate is one', () => {
    expect(shouldRunShadowCompare({ shadowCompareEnabled: true, shadowSampleRate: 1 }, 0.999)).toBe(true);
  });

  it('uses strict less-than check for random sampling', () => {
    const config = { shadowCompareEnabled: true, shadowSampleRate: 0.25 };
    expect(shouldRunShadowCompare(config, 0.24)).toBe(true);
    expect(shouldRunShadowCompare(config, 0.25)).toBe(false);
  });
});
