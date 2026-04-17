import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createAIProvider, resolveAIProviderId } from '../../../src/ai/providers/factory.js';
import { CodexSessionProvider } from '../../../src/ai/providers/codexSessionProvider.js';
import type { AIProvider, AIProviderId } from '../../../src/ai/providers/types.js';

/**
 * OpenAI/Codex provider parity fence (slice: prov-parity-fence).
 *
 * Freezes the current OpenAI-only control lane behavior so subsequent
 * multi-provider framework slices cannot accidentally widen the surface
 * without an explicit, reviewed change to these invariants.
 *
 * No production code is modified by this slice.
 */

const ORIGINAL_ENV = { ...process.env };

function resetProviderEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CE_AI_PROVIDER;
  delete process.env.CE_AI_OPENAI_SESSION_ONLY;
  delete process.env.CE_OPENAI_SESSION_ARGS_JSON;
  delete process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON;
  delete process.env.CE_OPENAI_SESSION_CMD;
  delete process.env.CE_OPENAI_SESSION_REFRESH_MODE;
  delete process.env.CE_OPENAI_SESSION_IDENTITY_TTL_MS;
  delete process.env.CE_OPENAI_SESSION_HEALTHCHECK_TIMEOUT_MS;
}

function buildStubFactoryArgs(providerId: AIProviderId) {
  return {
    providerId,
    getProviderContext: async () => ({}) as unknown,
    maxRateLimitRetries: 1,
    baseRateLimitBackoffMs: 100,
    maxRateLimitBackoffMs: 1000,
  };
}

describe('OpenAI provider parity fence', () => {
  beforeEach(() => {
    resetProviderEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('resolveAIProviderId()', () => {
    it('returns openai_session when CE_AI_PROVIDER is unset', () => {
      delete process.env.CE_AI_PROVIDER;
      expect(resolveAIProviderId()).toBe('openai_session');
    });

    it('returns openai_session when CE_AI_PROVIDER is the empty string', () => {
      process.env.CE_AI_PROVIDER = '';
      expect(resolveAIProviderId()).toBe('openai_session');
    });

    it('returns openai_session when CE_AI_PROVIDER is whitespace only', () => {
      process.env.CE_AI_PROVIDER = '   \t  ';
      expect(resolveAIProviderId()).toBe('openai_session');
    });

    it('returns openai_session when CE_AI_PROVIDER is set to openai_session explicitly', () => {
      process.env.CE_AI_PROVIDER = 'openai_session';
      expect(resolveAIProviderId()).toBe('openai_session');
    });

    for (const offending of ['anthropic', 'copilot', 'foo', 'OpenAI_Session', 'openai']) {
      it(`throws for unsupported provider id "${offending}" and mentions both the offending value and openai_session`, () => {
        process.env.CE_AI_PROVIDER = offending;
        let captured: unknown;
        try {
          resolveAIProviderId();
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(Error);
        const message = (captured as Error).message;
        expect(message).toContain(offending);
        expect(message).toContain('openai_session');
      });
    }
  });

  describe('createAIProvider()', () => {
    it('returns a CodexSessionProvider instance for providerId="openai_session"', () => {
      const provider = createAIProvider(buildStubFactoryArgs('openai_session'));
      expect(provider).toBeInstanceOf(CodexSessionProvider);
    });

    it('returned provider exposes id="openai_session" and a stable modelLabel string', () => {
      const provider = createAIProvider(buildStubFactoryArgs('openai_session'));
      expect(provider.id).toBe('openai_session');
      expect(typeof provider.modelLabel).toBe('string');
      expect(provider.modelLabel.length).toBeGreaterThan(0);
      // The current control-lane model label is frozen as 'codex-session'.
      // If this ever changes, parity must be re-evaluated explicitly.
      expect(provider.modelLabel).toBe('codex-session');
    });

    for (const offending of ['anthropic', 'copilot', 'foo', '']) {
      it(`throws for unsupported providerId "${offending}" mentioning the offending id and openai_session`, () => {
        let captured: unknown;
        try {
          createAIProvider({
            ...buildStubFactoryArgs('openai_session'),
            providerId: offending as unknown as AIProviderId,
          });
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(Error);
        const message = (captured as Error).message;
        expect(message).toContain(offending);
        expect(message).toContain('openai_session');
      });
    }
  });

  describe('AIProvider contract surface stability', () => {
    it('exposes call, id, and modelLabel on the returned provider', () => {
      const provider: AIProvider = createAIProvider(buildStubFactoryArgs('openai_session'));
      expect(typeof provider.call).toBe('function');
      expect(typeof provider.id).toBe('string');
      expect(typeof provider.modelLabel).toBe('string');
    });

    it('exposes a function-typed health() method (not invoked here to avoid subprocess)', () => {
      const provider: AIProvider = createAIProvider(buildStubFactoryArgs('openai_session'));
      // health is optional on the legacy AIProvider shim; today the codex
      // provider defines it. Lock the shape, not the runtime behavior.
      if (provider.health !== undefined) {
        expect(typeof provider.health).toBe('function');
      }
    });
  });

  describe('Default OpenAI path is the only registry-eligible provider today', () => {
    it('createAIProvider always returns a CodexSessionProvider for the default config', () => {
      const provider = createAIProvider(buildStubFactoryArgs('openai_session'));
      expect(provider).toBeInstanceOf(CodexSessionProvider);
      expect(provider.constructor.name).toBe('CodexSessionProvider');
    });

    it('there is no exported alternate factory that bypasses the openai_session policy', async () => {
      const factoryModule = await import('../../../src/ai/providers/factory.js');
      const exportedNames = Object.keys(factoryModule).sort();
      // Lock the public surface of the factory module to exactly these two
      // exports today. Any new export here is a deliberate framework change
      // and should be reviewed against the parity invariants.
      expect(exportedNames).toEqual(['createAIProvider', 'resolveAIProviderId']);
    });
  });

  describe('AIProviderId type narrowness (compile-time fence)', () => {
    it('rejects widening AIProviderId beyond openai_session at the type level', () => {
      const allowed: AIProviderId = 'openai_session';
      expect(allowed).toBe('openai_session');

      // @ts-expect-error widening AIProviderId to a non-openai_session literal must be a type error today.
      const disallowed: AIProviderId = 'copilot';
      // Runtime check kept trivial; the real assertion is the @ts-expect-error above.
      expect(typeof disallowed).toBe('string');
    });
  });
});
