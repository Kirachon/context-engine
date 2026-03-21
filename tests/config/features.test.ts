import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getFeatureFlagsFromEnv } from '../../src/config/features.js';

const ORIGINAL_ENV = { ...process.env };

describe('feature flag env parsing', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_RETRIEVAL_PROVIDER_V2;
    delete process.env.CE_RETRIEVAL_ARTIFACTS_V2;
    delete process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults retrieval V2 migration flags to false', () => {
    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
  });

  it('parses retrieval V2 migration flags from env booleans', () => {
    process.env.CE_RETRIEVAL_PROVIDER_V2 = '1';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'true';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'yes';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(true);
    expect(flags.retrieval_artifacts_v2).toBe(true);
    expect(flags.retrieval_shadow_control_v2).toBe(true);
  });

  it('falls back to default false for invalid V2 migration flag values', () => {
    process.env.CE_RETRIEVAL_PROVIDER_V2 = 'definitely';
    process.env.CE_RETRIEVAL_ARTIFACTS_V2 = 'maybe';
    process.env.CE_RETRIEVAL_SHADOW_CONTROL_V2 = 'sometimes';

    const flags = getFeatureFlagsFromEnv();

    expect(flags.retrieval_provider_v2).toBe(false);
    expect(flags.retrieval_artifacts_v2).toBe(false);
    expect(flags.retrieval_shadow_control_v2).toBe(false);
  });
});
