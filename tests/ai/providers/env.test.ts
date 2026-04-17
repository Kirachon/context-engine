import { describe, it, expect } from '@jest/globals';
import { readProviderEnvConfig } from '../../../src/ai/providers/env.js';

describe('readProviderEnvConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = readProviderEnvConfig({});
    expect(cfg.providerId).toBe('openai_session');
    expect(cfg.experimentalEnabled).toBe(false);
    expect(cfg.shadowEnabled).toBe(false);
    expect(cfg.canaryEnabled).toBe(false);
  });

  it('treats explicit openai_session as default-safe', () => {
    const cfg = readProviderEnvConfig({ CE_AI_PROVIDER: 'openai_session' });
    expect(cfg.providerId).toBe('openai_session');
    expect(cfg.experimentalEnabled).toBe(false);
  });

  it('treats whitespace-only CE_AI_PROVIDER as unset', () => {
    const cfg = readProviderEnvConfig({ CE_AI_PROVIDER: '   ' });
    expect(cfg.providerId).toBe('openai_session');
  });

  it('throws when non-default provider requested without experimental gate', () => {
    expect(() => readProviderEnvConfig({ CE_AI_PROVIDER: 'copilot' })).toThrow(
      /copilot[\s\S]*CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS|CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS[\s\S]*copilot/
    );
    try {
      readProviderEnvConfig({ CE_AI_PROVIDER: 'copilot' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('copilot');
      expect(msg).toContain('CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS');
    }
  });

  it('allows non-default provider when experimental=1', () => {
    const cfg = readProviderEnvConfig({
      CE_AI_PROVIDER: 'copilot',
      CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '1',
    });
    expect(cfg.providerId).toBe('copilot');
    expect(cfg.experimentalEnabled).toBe(true);
  });

  it('accepts true (case-insensitive) for experimental flag', () => {
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'true' }).experimentalEnabled).toBe(true);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'TRUE' }).experimentalEnabled).toBe(true);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'True' }).experimentalEnabled).toBe(true);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '1' }).experimentalEnabled).toBe(true);
  });

  it('rejects 0/false/yes/garbage for experimental flag', () => {
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '0' }).experimentalEnabled).toBe(false);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'false' }).experimentalEnabled).toBe(false);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'yes' }).experimentalEnabled).toBe(false);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: 'garbage' }).experimentalEnabled).toBe(false);
    expect(readProviderEnvConfig({ CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '' }).experimentalEnabled).toBe(false);
  });

  it('throws when shadow enabled without experimental', () => {
    try {
      readProviderEnvConfig({ CE_AI_ENABLE_SHADOW: '1' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('CE_AI_ENABLE_SHADOW');
      expect(msg).toContain('CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS');
    }
  });

  it('enables shadow when both shadow and experimental are set', () => {
    const cfg = readProviderEnvConfig({
      CE_AI_ENABLE_SHADOW: '1',
      CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '1',
    });
    expect(cfg.shadowEnabled).toBe(true);
    expect(cfg.experimentalEnabled).toBe(true);
  });

  it('throws when canary enabled without experimental', () => {
    try {
      readProviderEnvConfig({ CE_AI_ENABLE_CANARY: '1' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('CE_AI_ENABLE_CANARY');
      expect(msg).toContain('CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS');
    }
  });

  it('enables canary when both canary and experimental are set', () => {
    const cfg = readProviderEnvConfig({
      CE_AI_ENABLE_CANARY: '1',
      CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '1',
    });
    expect(cfg.canaryEnabled).toBe(true);
    expect(cfg.experimentalEnabled).toBe(true);
  });

  it('does not mutate the input env object', () => {
    const env = {
      CE_AI_PROVIDER: 'openai_session',
      CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS: '1',
      CE_AI_ENABLE_SHADOW: '1',
      CE_AI_ENABLE_CANARY: '1',
      OTHER: 'keep',
    };
    const before = JSON.stringify(env);
    const beforeKeys = Object.keys(env).sort();
    readProviderEnvConfig(env);
    expect(JSON.stringify(env)).toBe(before);
    expect(Object.keys(env).sort()).toEqual(beforeKeys);
  });

  it('reads from process.env when called with no args', () => {
    const KEY = 'CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS';
    const original = process.env[KEY];
    try {
      process.env[KEY] = '1';
      expect(readProviderEnvConfig().experimentalEnabled).toBe(true);
      delete process.env[KEY];
      expect(readProviderEnvConfig().experimentalEnabled).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = original;
      }
    }
  });
});
