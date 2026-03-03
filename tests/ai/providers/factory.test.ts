import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createAIProvider, resolveAIProviderId } from '../../../src/ai/providers/factory.js';

const ORIGINAL_ENV = { ...process.env };

describe('AI provider factory (openai_session only)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_AI_PROVIDER;
    delete process.env.CE_AI_OPENAI_SESSION_ONLY;
    delete process.env.CE_OPENAI_SESSION_ARGS_JSON;
    delete process.env.CE_OPENAI_SESSION_CMD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to openai_session when CE_AI_PROVIDER is unset', () => {
    expect(resolveAIProviderId()).toBe('openai_session');
  });

  it('rejects augment when explicitly configured', () => {
    process.env.CE_AI_PROVIDER = 'augment';
    expect(() => resolveAIProviderId()).toThrow(/must be openai_session/i);
  });

  it('allows openai_session when explicitly configured', () => {
    process.env.CE_AI_PROVIDER = 'openai_session';
    expect(resolveAIProviderId()).toBe('openai_session');
  });

  it('creates codex session provider for openai_session', () => {
    const provider = createAIProvider({
      providerId: 'openai_session',
      getAugmentContext: async () => ({}) as any,
      maxRateLimitRetries: 1,
      baseRateLimitBackoffMs: 100,
      maxRateLimitBackoffMs: 1000,
    });

    expect(provider.id).toBe('openai_session');
  });
});
