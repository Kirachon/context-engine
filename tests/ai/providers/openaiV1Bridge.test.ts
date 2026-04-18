import { describe, it, expect, jest } from '@jest/globals';
import {
  adaptLegacyToV1,
  adaptV1ToLegacy,
} from '../../../src/ai/providers/openaiV1Bridge.js';
import {
  OPENAI_SESSION_CAPABILITIES,
  OPENAI_SESSION_IDENTITY,
} from '../../../src/ai/providers/openaiV1Descriptor.js';
import { AIProviderError } from '../../../src/ai/providers/errors.js';
import {
  ProviderPrivacyClass,
  type ProviderCapabilities,
} from '../../../src/ai/providers/capabilities.js';
import type {
  ProviderContractV1,
  ProviderGenerateRequest,
  ProviderGenerateResponse,
  ProviderIdentity,
  ProviderOperationOptions,
} from '../../../src/ai/providers/contract.js';
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from '../../../src/ai/providers/types.js';

type LegacyCallMock = jest.Mock<(req: AIProviderRequest) => Promise<AIProviderResponse>>;
type LegacyHealthMock = jest.Mock<() => Promise<{ ok: boolean; reason?: string }>>;

function makeStubLegacy(
  overrides: Partial<{
    call: LegacyCallMock;
    health: LegacyHealthMock | undefined;
    response: AIProviderResponse;
  }> = {}
): { provider: AIProvider; call: LegacyCallMock; health: LegacyHealthMock | undefined } {
  const response: AIProviderResponse =
    overrides.response ?? { text: 'hello', model: 'codex-session', finishReason: 'stop' };
  const call: LegacyCallMock =
    overrides.call ?? (jest.fn(async () => response) as LegacyCallMock);
  const health: LegacyHealthMock | undefined =
    'health' in overrides
      ? overrides.health
      : (jest.fn(async () => ({ ok: true })) as LegacyHealthMock);
  const provider: AIProvider = {
    id: 'openai_session',
    modelLabel: 'codex-session',
    call,
    ...(health ? { health } : {}),
  };
  return { provider, call, health };
}

describe('adaptLegacyToV1', () => {
  it('returns an object with contractVersion === "v1"', () => {
    const { provider } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    expect(v1.contractVersion).toBe('v1');
  });

  it('preserves and freezes identity and capabilities references', () => {
    const identity: ProviderIdentity = { ...OPENAI_SESSION_IDENTITY };
    const capabilities: ProviderCapabilities = { ...OPENAI_SESSION_CAPABILITIES };
    const { provider } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, identity, capabilities);
    expect(v1.identity).toBe(identity);
    expect(v1.capabilities).toBe(capabilities);
    expect(Object.isFrozen(v1.identity)).toBe(true);
    expect(Object.isFrozen(v1.capabilities)).toBe(true);
  });

  it('forwards mapped request with default 30000ms timeout', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    await v1.generate({ prompt: 'p', searchQuery: 'q', workspacePath: '/w' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      searchQuery: 'q',
      prompt: 'p',
      timeoutMs: 30000,
      workspacePath: '/w',
    });
  });

  it('uses defaultTimeoutMs from bridge options when no deadline supplied', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(
      provider,
      OPENAI_SESSION_IDENTITY,
      OPENAI_SESSION_CAPABILITIES,
      { defaultTimeoutMs: 5000 }
    );
    await v1.generate({ prompt: 'p' });
    expect(call.mock.calls[0]?.[0].timeoutMs).toBe(5000);
  });

  it('computes timeoutMs from a future deadlineMs in options', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const deadlineMs = Date.now() + 10_000;
    await v1.generate({ prompt: 'p' }, { deadlineMs });
    const ts = call.mock.calls[0]?.[0].timeoutMs ?? 0;
    expect(ts).toBeGreaterThanOrEqual(9000);
    expect(ts).toBeLessThanOrEqual(10000);
  });

  it('throws AIProviderError(provider_timeout) when deadlineMs is in the past', async () => {
    const { provider } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    let captured: unknown;
    try {
      await v1.generate({ prompt: 'p' }, { deadlineMs: Date.now() - 1 });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(AIProviderError);
    expect((captured as AIProviderError).code).toBe('provider_timeout');
  });

  it('forwards signal and deadlineMs to the legacy call', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const signal = new AbortController().signal;
    const deadlineMs = Date.now() + 5000;
    await v1.generate({ prompt: 'p' }, { signal, deadlineMs });
    expect(call.mock.calls[0]?.[0].signal).toBe(signal);
    expect(call.mock.calls[0]?.[0].deadlineMs).toBe(deadlineMs);
  });

  it('forwards missing searchQuery as empty string', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    await v1.generate({ prompt: 'p' });
    expect(call.mock.calls[0]?.[0].searchQuery).toBe('');
  });

  it('forwards missing workspacePath as process.cwd()', async () => {
    const { provider, call } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    await v1.generate({ prompt: 'p' });
    expect(call.mock.calls[0]?.[0].workspacePath).toBe(process.cwd());
  });

  it('maps response fields and falls back to capabilities.privacyClass', async () => {
    const { provider } = makeStubLegacy({
      response: {
        text: 't',
        model: 'm',
        finishReason: 'stop',
        latencyMs: 42,
      },
    });
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const resp = await v1.generate({ prompt: 'p' });
    expect(resp.text).toBe('t');
    expect(resp.model).toBe('m');
    expect(resp.finishReason).toBe('stop');
    expect(resp.latencyMs).toBe(42);
    expect(resp.privacyClass).toBe(OPENAI_SESSION_CAPABILITIES.privacyClass);
  });

  it('maps legacy warnings to {code: legacy_warning, message} entries', async () => {
    const { provider } = makeStubLegacy({
      response: {
        text: 't',
        model: 'm',
        finishReason: 'stop',
        warnings: ['a', 'b'],
      },
    });
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const resp = await v1.generate({ prompt: 'p' });
    expect(resp.warnings).toEqual([
      { code: 'legacy_warning', message: 'a' },
      { code: 'legacy_warning', message: 'b' },
    ]);
  });

  it('delegates health() to legacy provider', async () => {
    const health: LegacyHealthMock = jest.fn(async () => ({
      ok: false,
      reason: 'down',
    })) as LegacyHealthMock;
    const { provider } = makeStubLegacy({ health });
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const result = await v1.health();
    expect(health).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: 'down' });
  });

  it('returns {ok: true} when legacy has no health()', async () => {
    const { provider } = makeStubLegacy({ health: undefined });
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    const result = await v1.health();
    expect(result).toEqual({ ok: true });
  });

  it('does not define embed or rerank on the result', () => {
    const { provider } = makeStubLegacy();
    const v1 = adaptLegacyToV1(provider, OPENAI_SESSION_IDENTITY, OPENAI_SESSION_CAPABILITIES);
    expect('embed' in v1).toBe(false);
    expect('rerank' in v1).toBe(false);
  });
});

function makeStubV1(
  overrides: Partial<{
    generate: jest.Mock<
      (req: ProviderGenerateRequest, opts?: ProviderOperationOptions) => Promise<ProviderGenerateResponse>
    >;
    health: jest.Mock<() => Promise<{ ok: boolean; reason?: string }>>;
    response: ProviderGenerateResponse;
  }> = {}
): {
  v1: ProviderContractV1;
  generate: jest.Mock<
    (req: ProviderGenerateRequest, opts?: ProviderOperationOptions) => Promise<ProviderGenerateResponse>
  >;
  health: jest.Mock<() => Promise<{ ok: boolean; reason?: string }>>;
} {
  const response: ProviderGenerateResponse =
    overrides.response ?? {
      text: 'v1text',
      model: 'codex-session',
      finishReason: 'stop',
      privacyClass: ProviderPrivacyClass.Hosted,
    };
  const generate =
    overrides.generate ??
    (jest.fn(async () => response) as jest.Mock<
      (req: ProviderGenerateRequest, opts?: ProviderOperationOptions) => Promise<ProviderGenerateResponse>
    >);
  const health =
    overrides.health ??
    (jest.fn(async () => ({ ok: true })) as jest.Mock<() => Promise<{ ok: boolean; reason?: string }>>);
  const v1: ProviderContractV1 = {
    contractVersion: 'v1',
    identity: OPENAI_SESSION_IDENTITY,
    capabilities: OPENAI_SESSION_CAPABILITIES,
    generate,
    health,
  };
  return { v1, generate, health };
}

describe('adaptV1ToLegacy', () => {
  it('derives id, modelLabel, and capabilities from v1 identity/capabilities', () => {
    const { v1 } = makeStubV1();
    const legacy = adaptV1ToLegacy(v1);
    expect(legacy.id).toBe('openai_session');
    expect(legacy.modelLabel).toBe(OPENAI_SESSION_IDENTITY.model);
    expect(legacy.capabilities).toBe(OPENAI_SESSION_CAPABILITIES);
  });

  it('invokes v1.generate with mapped request and forwards signal/deadline', async () => {
    const { v1, generate } = makeStubV1();
    const legacy = adaptV1ToLegacy(v1);
    const signal = new AbortController().signal;
    const deadlineMs = Date.now() + 5000;
    await legacy.call({
      searchQuery: 'q',
      prompt: 'p',
      timeoutMs: 1000,
      workspacePath: '/w',
      signal,
      deadlineMs,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const [req, opts] = generate.mock.calls[0] ?? [];
    expect(req).toEqual({ prompt: 'p', searchQuery: 'q', workspacePath: '/w' });
    expect(opts).toEqual({ signal, deadlineMs });
  });

  it('falls back prompt to searchQuery when prompt is missing', async () => {
    const { v1, generate } = makeStubV1();
    const legacy = adaptV1ToLegacy(v1);
    await legacy.call({
      searchQuery: 'fallback',
      timeoutMs: 1000,
      workspacePath: '/w',
    });
    expect(generate.mock.calls[0]?.[0].prompt).toBe('fallback');
  });

  it('defaults text to empty string when v1 returns no text', async () => {
    const { v1 } = makeStubV1({
      response: {
        model: 'm',
        finishReason: 'stop',
        privacyClass: ProviderPrivacyClass.Hosted,
      },
    });
    const legacy = adaptV1ToLegacy(v1);
    const resp = await legacy.call({
      searchQuery: 'q',
      timeoutMs: 1000,
      workspacePath: '/w',
    });
    expect(resp.text).toBe('');
  });

  it('maps finishReason "tool_calls" to legacy "error"', async () => {
    const { v1 } = makeStubV1({
      response: {
        text: 't',
        model: 'm',
        finishReason: 'tool_calls',
        privacyClass: ProviderPrivacyClass.Hosted,
      },
    });
    const legacy = adaptV1ToLegacy(v1);
    const resp = await legacy.call({
      searchQuery: 'q',
      timeoutMs: 1000,
      workspacePath: '/w',
    });
    expect(resp.finishReason).toBe('error');
  });

  it('maps v1 warnings ({code,message}[]) to legacy string[] of messages', async () => {
    const { v1 } = makeStubV1({
      response: {
        text: 't',
        model: 'm',
        finishReason: 'stop',
        privacyClass: ProviderPrivacyClass.Hosted,
        warnings: [
          { code: 'x', message: 'first' },
          { code: 'y', message: 'second' },
        ],
      },
    });
    const legacy = adaptV1ToLegacy(v1);
    const resp = await legacy.call({
      searchQuery: 'q',
      timeoutMs: 1000,
      workspacePath: '/w',
    });
    expect(resp.warnings).toEqual(['first', 'second']);
  });

  it('delegates health() to v1', async () => {
    const health = jest.fn(async () => ({ ok: false, reason: 'why' })) as jest.Mock<
      () => Promise<{ ok: boolean; reason?: string }>
    >;
    const { v1 } = makeStubV1({ health });
    const legacy = adaptV1ToLegacy(v1);
    const result = await legacy.health!();
    expect(health).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: 'why' });
  });
});

describe('openaiV1Descriptor', () => {
  it('exposes frozen identity and capabilities objects', () => {
    expect(Object.isFrozen(OPENAI_SESSION_IDENTITY)).toBe(true);
    expect(Object.isFrozen(OPENAI_SESSION_CAPABILITIES)).toBe(true);
  });

  it('identity.providerId is "openai_session"', () => {
    expect(OPENAI_SESSION_IDENTITY.providerId).toBe('openai_session');
  });

  it('capabilities reflect hosted, cancellable defaults', () => {
    expect(OPENAI_SESSION_CAPABILITIES.privacyClass).toBe(ProviderPrivacyClass.Hosted);
    expect(OPENAI_SESSION_CAPABILITIES.supportsCancellation).toBe(true);
  });
});
