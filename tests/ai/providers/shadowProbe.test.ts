import { describe, it, expect, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runShadowProbe,
  type ShadowProbeLogEvent,
} from '../../../src/ai/providers/shadowProbe.js';
import {
  ProviderPrivacyClass,
  type ProviderCapabilities,
} from '../../../src/ai/providers/capabilities.js';
import type {
  ProviderContractV1,
  ProviderGenerateRequest,
  ProviderGenerateResponse,
  ProviderHealthStatus,
  ProviderOperationOptions,
} from '../../../src/ai/providers/contract.js';
import type { ProviderEnvConfig } from '../../../src/ai/providers/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CAPS: ProviderCapabilities = Object.freeze({
  supportsCancellation: true,
  supportsStreaming: false,
  supportsEmbeddings: false,
  supportsRerank: false,
  maxInFlight: 1,
  maxContextTokens: 1000,
  privacyClass: ProviderPrivacyClass.Local,
  requestIsolation: Object.freeze({
    authHeadersPerRequest: true,
    noSharedMutableAuthState: true,
    modelSelectionPerRequest: false,
  }),
});

type GenerateMock = jest.Mock<
  (
    req: ProviderGenerateRequest,
    options?: ProviderOperationOptions,
  ) => Promise<ProviderGenerateResponse>
>;
type HealthMock = jest.Mock<
  (options?: ProviderOperationOptions) => Promise<ProviderHealthStatus>
>;
type ReadinessMock = HealthMock;

interface StubOverrides {
  identity?: ProviderContractV1['identity'];
  capabilities?: ProviderCapabilities;
  health?: HealthMock;
  readiness?: ReadinessMock;
  generate?: GenerateMock;
}

function makeStubV1(overrides: StubOverrides = {}): ProviderContractV1 & {
  health: HealthMock;
  readiness?: ReadinessMock;
  generate: GenerateMock;
} {
  const generate: GenerateMock =
    overrides.generate ??
    (jest.fn(async () => {
      throw new Error('generate must not be called by shadow probe');
    }) as GenerateMock);
  const health: HealthMock =
    overrides.health ?? (jest.fn(async () => ({ ok: true })) as HealthMock);
  const stub: ProviderContractV1 & {
    health: HealthMock;
    readiness?: ReadinessMock;
    generate: GenerateMock;
  } = {
    contractVersion: 'v1',
    identity:
      overrides.identity ?? {
        providerId: 'stub',
        backendFamily: 'stub-fam',
        model: 'stub-m',
        transport: 'stub-t',
      },
    capabilities: overrides.capabilities ?? DEFAULT_CAPS,
    generate,
    health,
  };
  if (overrides.readiness) {
    stub.readiness = overrides.readiness;
  }
  return stub;
}

function envOf(over: Partial<ProviderEnvConfig> = {}): ProviderEnvConfig {
  return Object.freeze({
    providerId: 'openai_session',
    experimentalEnabled: true,
    shadowEnabled: true,
    canaryEnabled: false,
    ...over,
  });
}

describe('runShadowProbe — gating', () => {
  it('skips with flags_disabled when both flags are false', async () => {
    const stub = makeStubV1();
    const report = await runShadowProbe({
      env: envOf({ experimentalEnabled: false, shadowEnabled: false }),
      providers: [stub],
    });
    expect(report.enabled).toBe(false);
    expect(report.skippedReason).toBe('flags_disabled');
    expect(report.results).toEqual([]);
    expect(stub.health).not.toHaveBeenCalled();
    expect(stub.generate).not.toHaveBeenCalled();
  });

  it('skips when experimental enabled but shadow disabled', async () => {
    const stub = makeStubV1();
    const report = await runShadowProbe({
      env: envOf({ experimentalEnabled: true, shadowEnabled: false }),
      providers: [stub],
    });
    expect(report.enabled).toBe(false);
    expect(report.skippedReason).toBe('flags_disabled');
    expect(stub.health).not.toHaveBeenCalled();
  });

  it('skips with no_providers when shadow enabled but no providers registered', async () => {
    const report = await runShadowProbe({ env: envOf(), providers: [] });
    expect(report.enabled).toBe(true);
    expect(report.skippedReason).toBe('no_providers');
    expect(report.results).toEqual([]);
  });
});

describe('runShadowProbe — per-provider outcomes', () => {
  it('returns ok for a healthy provider and never calls generate', async () => {
    const stub = makeStubV1();
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    expect(report.enabled).toBe(true);
    expect(report.skippedReason).toBeUndefined();
    expect(report.results).toHaveLength(1);
    const r = report.results[0]!;
    expect(r.outcome).toBe('ok');
    expect(r.health).toEqual({ ok: true });
    expect(r.errors).toEqual([]);
    expect(stub.health).toHaveBeenCalledTimes(1);
    expect(stub.generate).not.toHaveBeenCalled();
    // The probe must not pass prompts/inputs to health.
    const callArgs = stub.health.mock.calls[0] ?? [];
    if (callArgs.length > 0) {
      const opts = callArgs[0];
      expect(opts).not.toHaveProperty('prompt');
      expect(opts).not.toHaveProperty('searchQuery');
      expect(opts).not.toHaveProperty('inputs');
    }
  });

  it('reports degraded when health returns ok:false (no exception)', async () => {
    const health = jest.fn(async () => ({ ok: false, reason: 'auth' })) as HealthMock;
    const stub = makeStubV1({ health });
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    const r = report.results[0]!;
    expect(r.outcome).toBe('degraded');
    expect(r.health).toEqual({ ok: false, reason: 'auth' });
    expect(r.errors).toEqual([]);
  });

  it('reports unavailable and captures error when health rejects', async () => {
    const health = jest.fn(async () => {
      throw new Error('boom');
    }) as HealthMock;
    const stub = makeStubV1({ health });
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    const r = report.results[0]!;
    expect(r.outcome).toBe('unavailable');
    expect(r.errors).toContain('boom');
    expect(r.health).toEqual({ ok: false, reason: 'boom' });
  });

  it('reports unavailable with timeout reason when health never resolves', async () => {
    // Use a small real timeout (50ms) — chosen to keep tests fast and deterministic.
    const health = jest.fn(
      () => new Promise<ProviderHealthStatus>(() => undefined),
    ) as HealthMock;
    const stub = makeStubV1({ health });
    const report = await runShadowProbe({
      env: envOf(),
      providers: [stub],
      perCheckTimeoutMs: 50,
    });
    const r = report.results[0]!;
    expect(r.outcome).toBe('unavailable');
    expect(r.health?.ok).toBe(false);
    expect(r.health?.reason).toMatch(/timed out/);
    expect(r.health?.reason).toMatch(/50ms/);
    expect(r.errors.some((e) => e.includes('timed out'))).toBe(true);
  });

  it('aborts timed-out health checks via ProviderOperationOptions.signal', async () => {
    let observedSignal: AbortSignal | undefined;
    let observedDeadlineMs: number | undefined;
    const health = jest.fn(async (options?: ProviderOperationOptions) => {
      observedSignal = options?.signal;
      observedDeadlineMs = options?.deadlineMs;
      return await new Promise<ProviderHealthStatus>(() => undefined);
    }) as HealthMock;
    const stub = makeStubV1({ health });
    const report = await runShadowProbe({
      env: envOf(),
      providers: [stub],
      perCheckTimeoutMs: 20,
    });
    const r = report.results[0]!;
    expect(r.outcome).toBe('unavailable');
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(observedDeadlineMs).toBeGreaterThan(Date.now() - 1000);
  });

  it('records readiness when defined and outcome stays ok', async () => {
    const readiness = jest.fn(async () => ({ ok: true })) as ReadinessMock;
    const stub = makeStubV1({ readiness });
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    const r = report.results[0]!;
    expect(r.outcome).toBe('ok');
    expect(r.health).toEqual({ ok: true });
    expect(r.readiness).toEqual({ ok: true });
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it('omits readiness field when provider has no readiness method', async () => {
    const stub = makeStubV1();
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    const r = report.results[0]!;
    expect('readiness' in r).toBe(false);
  });

  it('handles multiple providers in input order without throwing', async () => {
    const healthy = makeStubV1({
      identity: {
        providerId: 'p-healthy',
        backendFamily: 'b',
        model: 'm',
        transport: 't',
      },
    });
    const degraded = makeStubV1({
      identity: {
        providerId: 'p-degraded',
        backendFamily: 'b',
        model: 'm',
        transport: 't',
      },
      health: jest.fn(async () => ({ ok: false, reason: 'cold' })) as HealthMock,
    });
    const broken = makeStubV1({
      identity: {
        providerId: 'p-broken',
        backendFamily: 'b',
        model: 'm',
        transport: 't',
      },
      health: jest.fn(async () => {
        throw new Error('nope');
      }) as HealthMock,
    });
    const report = await runShadowProbe({
      env: envOf(),
      providers: [healthy, degraded, broken],
    });
    expect(report.enabled).toBe(true);
    expect(report.results).toHaveLength(3);
    expect(report.results[0]!.providerId).toBe('p-healthy');
    expect(report.results[0]!.outcome).toBe('ok');
    expect(report.results[1]!.providerId).toBe('p-degraded');
    expect(report.results[1]!.outcome).toBe('degraded');
    expect(report.results[2]!.providerId).toBe('p-broken');
    expect(report.results[2]!.outcome).toBe('unavailable');
  });
});

describe('runShadowProbe — logger', () => {
  it('emits at least one event per stage per provider', async () => {
    const events: ShadowProbeLogEvent[] = [];
    const logger = (e: ShadowProbeLogEvent) => {
      events.push(e);
    };
    const stub = makeStubV1();
    await runShadowProbe({ env: envOf(), providers: [stub], logger });
    const stages = new Set(events.map((e) => e.stage));
    expect(stages.has('identity')).toBe(true);
    expect(stages.has('capabilities')).toBe(true);
    expect(stages.has('health')).toBe(true);
    for (const e of events) {
      expect(e.providerId).toBe('stub');
    }
  });
});

describe('runShadowProbe — identity & capabilities pass-through', () => {
  it('mirrors identity and capability subset onto the result', async () => {
    const identity = {
      providerId: 'mirror-id',
      backendFamily: 'fam',
      model: 'modelX',
      transport: 'http',
    };
    const capabilities: ProviderCapabilities = Object.freeze({
      ...DEFAULT_CAPS,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsRerank: true,
      privacyClass: ProviderPrivacyClass.SelfHosted,
    });
    const stub = makeStubV1({ identity, capabilities });
    const report = await runShadowProbe({ env: envOf(), providers: [stub] });
    const r = report.results[0]!;
    expect(r.identity).toEqual(identity);
    expect(r.capabilities).toEqual({
      supportsCancellation: true,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsRerank: true,
      privacyClass: 'self-hosted',
    });
  });
});

describe('runShadowProbe — never throws', () => {
  it('captures errors when identity getter throws (Proxy)', async () => {
    const target = makeStubV1();
    const proxied = new Proxy(target, {
      get(t, prop, recv) {
        if (prop === 'identity') {
          throw new Error('identity blew up');
        }
        return Reflect.get(t, prop, recv);
      },
    }) as ProviderContractV1;
    const report = await runShadowProbe({ env: envOf(), providers: [proxied] });
    expect(report.enabled).toBe(true);
    expect(report.results).toHaveLength(1);
    const r = report.results[0]!;
    expect(r.outcome).toBe('unavailable');
    expect(r.errors.some((e) => e.includes('identity blew up'))).toBe(true);
  });
});

describe('runShadowProbe — safety scan', () => {
  it('shadowProbe.ts source contains no generate/embed/rerank call sites', async () => {
    const sourcePath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'ai',
      'providers',
      'shadowProbe.ts',
    );
    const text = await fs.readFile(sourcePath, 'utf8');
    expect(text).not.toContain('.generate(');
    expect(text).not.toContain('.embed(');
    expect(text).not.toContain('.rerank(');
  });
});
