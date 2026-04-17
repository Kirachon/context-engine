import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAIProvider } from '../../../src/ai/providers/factory.js';
import { ProviderPrivacyClass } from '../../../src/ai/providers/capabilities.js';
import type { AIProviderErrorCode } from '../../../src/ai/providers/errors.js';

const ORIGINAL_ENV = { ...process.env };

const ALL_ERROR_CODES: readonly AIProviderErrorCode[] = [
  'provider_auth',
  'provider_timeout',
  'provider_unavailable',
  'provider_exec_error',
  'provider_parse_error',
  'provider_aborted',
  'provider_capability',
  'provider_circuit_open',
];

function makeProvider() {
  return createAIProvider({
    providerId: 'openai_session',
    getProviderContext: async () => ({}) as unknown,
    maxRateLimitRetries: 1,
    baseRateLimitBackoffMs: 100,
    maxRateLimitBackoffMs: 1000,
  });
}

describe('Provider contract v1 — capabilities & taxonomy fence', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_AI_PROVIDER;
    delete process.env.CE_OPENAI_SESSION_ARGS_JSON;
    delete process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON;
    delete process.env.CE_OPENAI_SESSION_CMD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('legacy AIProvider shim shape', () => {
    it('createAIProvider(openai_session) returns an object satisfying the legacy AIProvider contract', () => {
      const provider = makeProvider();

      expect(provider.id).toBe('openai_session');
      expect(typeof provider.modelLabel).toBe('string');
      expect(provider.modelLabel.length).toBeGreaterThan(0);
      expect(typeof provider.call).toBe('function');

      if (provider.health !== undefined) {
        expect(typeof provider.health).toBe('function');
      }

      if (provider.capabilities !== undefined) {
        expect(typeof provider.capabilities).toBe('object');
        expect(provider.capabilities).not.toBeNull();
      }
    });

    it('when capabilities is present, it conforms to ProviderCapabilities invariants', () => {
      const provider = makeProvider();
      const caps = provider.capabilities;
      if (caps === undefined) {
        // Legacy shim allows omission; nothing to assert.
        return;
      }

      expect(typeof caps.supportsCancellation).toBe('boolean');
      expect(typeof caps.supportsStreaming).toBe('boolean');
      expect(typeof caps.supportsEmbeddings).toBe('boolean');
      expect(typeof caps.supportsRerank).toBe('boolean');
      expect(typeof caps.maxInFlight).toBe('number');
      expect(typeof caps.maxContextTokens).toBe('number');
      expect(Object.values(ProviderPrivacyClass)).toContain(caps.privacyClass);

      expect(typeof caps.requestIsolation).toBe('object');
      expect(caps.requestIsolation).not.toBeNull();
      expect(typeof caps.requestIsolation.authHeadersPerRequest).toBe('boolean');
      expect(typeof caps.requestIsolation.noSharedMutableAuthState).toBe('boolean');
      expect(typeof caps.requestIsolation.modelSelectionPerRequest).toBe('boolean');

      if (caps.connectionPool !== undefined) {
        expect(typeof caps.connectionPool.maxConnections).toBe('number');
        expect(typeof caps.connectionPool.reuseSockets).toBe('boolean');
      }
      if (caps.circuitBreaker !== undefined) {
        expect(typeof caps.circuitBreaker.failureWindow).toBe('number');
        expect(typeof caps.circuitBreaker.cooldownMs).toBe('number');
        expect(typeof caps.circuitBreaker.halfOpenProbes).toBe('number');
      }
      if (caps.backpressure !== undefined) {
        expect(['queue', 'reject', 'caller_managed']).toContain(caps.backpressure);
      }
    });
  });

  describe('ProviderPrivacyClass enum', () => {
    it('exposes exactly the four expected members', () => {
      const values = Object.values(ProviderPrivacyClass).sort();
      expect(values).toEqual(['hosted', 'local', 'self-hosted', 'unsupported']);
    });
  });

  describe('error taxonomy ↔ docs/providers/contract.md fence', () => {
    it('every AIProviderErrorCode value appears in the documented taxonomy', () => {
      const docPath = path.resolve(process.cwd(), 'docs', 'providers', 'contract.md');
      const doc = fs.readFileSync(docPath, 'utf-8');

      for (const code of ALL_ERROR_CODES) {
        expect(doc).toContain(`\`${code}\``);
      }
    });
  });
});
