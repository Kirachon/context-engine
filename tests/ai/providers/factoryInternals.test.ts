import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createAIProvider, resolveAIProviderId } from '../../../src/ai/providers/factory.js';
import type { AIProviderId } from '../../../src/ai/providers/types.js';

/**
 * Internal-wiring tests for the generalized factory (slice prov-factory-generalize).
 * Parity is already covered by parityFence.test.ts; these tests document the new
 * env+registry wiring without re-asserting parity invariants.
 */

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CE_AI_PROVIDER;
  delete process.env.CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS;
  delete process.env.CE_AI_ENABLE_SHADOW;
  delete process.env.CE_AI_ENABLE_CANARY;
}

describe('factory internals (env + registry wiring)', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolveAIProviderId throws for CE_AI_PROVIDER=copilot without experimental flag', () => {
    process.env.CE_AI_PROVIDER = 'copilot';
    let captured: unknown;
    try {
      resolveAIProviderId();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).toContain('copilot');
    expect(message).toContain('openai_session');
  });

  it('resolveAIProviderId still throws for unknown id even with experimental flag enabled', () => {
    process.env.CE_AI_PROVIDER = 'copilot';
    process.env.CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS = '1';
    let captured: unknown;
    try {
      resolveAIProviderId();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).toContain('copilot');
    expect(message).toContain('openai_session');
  });

  it('createAIProvider returns a provider with id="openai_session" for the stable id', () => {
    const provider = createAIProvider({
      providerId: 'openai_session' as AIProviderId,
      getProviderContext: async () => ({}),
      maxRateLimitRetries: 0,
      baseRateLimitBackoffMs: 0,
      maxRateLimitBackoffMs: 0,
    });
    expect(provider.id).toBe('openai_session');
  });

  it('importing factory.ts does not throw at import time even when CE_AI_PROVIDER is invalid (env reads are lazy)', async () => {
    process.env.CE_AI_PROVIDER = 'definitely-not-a-real-provider';
    await expect(import('../../../src/ai/providers/factory.js')).resolves.toBeDefined();
  });
});
