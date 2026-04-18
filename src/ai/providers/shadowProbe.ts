// Shadow control-plane probe.
//
// Safety invariant: this module only inspects provider control-plane surface
// (identity, capabilities, health, readiness). It MUST NEVER call generate(),
// embed(), or rerank(); MUST NEVER access user prompts; and MUST NEVER
// influence routing of real requests.

import type { ProviderContractV1 } from './contract.js';
import type { ProviderEnvConfig } from './env.js';

export type ShadowCheckOutcome = 'ok' | 'degraded' | 'unavailable' | 'skipped';

export interface ShadowProbeResult {
  readonly providerId: string;
  readonly outcome: ShadowCheckOutcome;
  readonly identity: {
    providerId: string;
    backendFamily: string;
    model: string;
    transport: string;
  };
  readonly capabilities: {
    supportsCancellation: boolean;
    supportsStreaming: boolean;
    supportsEmbeddings: boolean;
    supportsRerank: boolean;
    privacyClass: string;
  };
  readonly health?: { ok: boolean; reason?: string };
  readonly readiness?: { ok: boolean; reason?: string };
  readonly errors: readonly string[];
  readonly latencyMs: { health?: number; readiness?: number };
}

export interface ShadowProbeReport {
  readonly enabled: boolean;
  readonly skippedReason?: 'flags_disabled' | 'no_providers';
  readonly results: readonly ShadowProbeResult[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ShadowProbeLogEvent {
  readonly providerId: string;
  readonly stage: 'identity' | 'capabilities' | 'health' | 'readiness';
  readonly outcome: 'ok' | 'error' | 'timeout' | 'skipped';
  readonly message?: string;
}

export interface ShadowProbeOptions {
  readonly env: ProviderEnvConfig;
  readonly providers: readonly ProviderContractV1[];
  readonly perCheckTimeoutMs?: number;
  readonly logger?: (event: ShadowProbeLogEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const UNKNOWN_PROVIDER_ID = '<unknown>';

function safeLog(
  logger: ((event: ShadowProbeLogEvent) => void) | undefined,
  event: ShadowProbeLogEvent,
): void {
  if (!logger) return;
  try {
    logger(event);
  } catch {
    // Logger failures must never affect probe outcome.
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

interface TimedOutcome {
  readonly status: 'resolved' | 'rejected' | 'timeout';
  readonly value?: { ok: boolean; reason?: string };
  readonly error?: string;
  readonly latencyMs: number;
}

async function runWithTimeout(
  fn: () => Promise<{ ok: boolean; reason?: string }>,
  timeoutMs: number,
): Promise<TimedOutcome> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<TimedOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: 'timeout',
          error: `probe timed out after ${timeoutMs}ms`,
          latencyMs: Date.now() - start,
        });
      }, timeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });

    const work: Promise<TimedOutcome> = (async () => {
      try {
        const value = await fn();
        return {
          status: 'resolved',
          value: { ok: !!value?.ok, reason: value?.reason },
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        return {
          status: 'rejected',
          error: errorMessage(err),
          latencyMs: Date.now() - start,
        };
      }
    })();

    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeOne(
  provider: ProviderContractV1,
  timeoutMs: number,
  logger: ((event: ShadowProbeLogEvent) => void) | undefined,
): Promise<ShadowProbeResult> {
  const errors: string[] = [];
  const latencyMs: { health?: number; readiness?: number } = {};

  let identity: ShadowProbeResult['identity'] = {
    providerId: UNKNOWN_PROVIDER_ID,
    backendFamily: '<unknown>',
    model: '<unknown>',
    transport: '<unknown>',
  };
  let identityOk = true;
  try {
    const id = provider.identity;
    identity = {
      providerId: String(id.providerId),
      backendFamily: String(id.backendFamily),
      model: String(id.model),
      transport: String(id.transport),
    };
    safeLog(logger, { providerId: identity.providerId, stage: 'identity', outcome: 'ok' });
  } catch (err) {
    identityOk = false;
    const msg = errorMessage(err);
    errors.push(`identity: ${msg}`);
    safeLog(logger, {
      providerId: UNKNOWN_PROVIDER_ID,
      stage: 'identity',
      outcome: 'error',
      message: msg,
    });
  }

  let capabilities: ShadowProbeResult['capabilities'] = {
    supportsCancellation: false,
    supportsStreaming: false,
    supportsEmbeddings: false,
    supportsRerank: false,
    privacyClass: '<unknown>',
  };
  let capabilitiesOk = true;
  try {
    const c = provider.capabilities;
    capabilities = {
      supportsCancellation: !!c.supportsCancellation,
      supportsStreaming: !!c.supportsStreaming,
      supportsEmbeddings: !!c.supportsEmbeddings,
      supportsRerank: !!c.supportsRerank,
      privacyClass: String(c.privacyClass),
    };
    safeLog(logger, { providerId: identity.providerId, stage: 'capabilities', outcome: 'ok' });
  } catch (err) {
    capabilitiesOk = false;
    const msg = errorMessage(err);
    errors.push(`capabilities: ${msg}`);
    safeLog(logger, {
      providerId: identity.providerId,
      stage: 'capabilities',
      outcome: 'error',
      message: msg,
    });
  }

  let health: { ok: boolean; reason?: string } | undefined;
  let healthThrewOrTimedOut = false;
  let healthCallable = true;
  try {
    const fn = provider.health.bind(provider);
    const outcome = await runWithTimeout(() => fn(), timeoutMs);
    latencyMs.health = outcome.latencyMs;
    if (outcome.status === 'resolved' && outcome.value) {
      health = outcome.value;
      safeLog(logger, {
        providerId: identity.providerId,
        stage: 'health',
        outcome: outcome.value.ok ? 'ok' : 'error',
        message: outcome.value.ok ? undefined : outcome.value.reason,
      });
    } else if (outcome.status === 'timeout') {
      healthThrewOrTimedOut = true;
      const reason = `health ${outcome.error}`;
      health = { ok: false, reason };
      errors.push(reason);
      safeLog(logger, {
        providerId: identity.providerId,
        stage: 'health',
        outcome: 'timeout',
        message: reason,
      });
    } else {
      healthThrewOrTimedOut = true;
      const reason = outcome.error ?? 'unknown error';
      health = { ok: false, reason };
      errors.push(reason);
      safeLog(logger, {
        providerId: identity.providerId,
        stage: 'health',
        outcome: 'error',
        message: reason,
      });
    }
  } catch (err) {
    healthThrewOrTimedOut = true;
    healthCallable = false;
    const msg = errorMessage(err);
    health = { ok: false, reason: msg };
    errors.push(msg);
    safeLog(logger, {
      providerId: identity.providerId,
      stage: 'health',
      outcome: 'error',
      message: msg,
    });
  }
  void healthCallable;

  let readiness: { ok: boolean; reason?: string } | undefined;
  let readinessPresent = false;
  let readinessThrewOrTimedOut = false;
  try {
    readinessPresent = typeof provider.readiness === 'function';
  } catch {
    readinessPresent = false;
  }

  if (readinessPresent) {
    try {
      const readinessFn = provider.readiness!.bind(provider);
      const outcome = await runWithTimeout(() => readinessFn(), timeoutMs);
      latencyMs.readiness = outcome.latencyMs;
      if (outcome.status === 'resolved' && outcome.value) {
        readiness = outcome.value;
        safeLog(logger, {
          providerId: identity.providerId,
          stage: 'readiness',
          outcome: outcome.value.ok ? 'ok' : 'error',
          message: outcome.value.ok ? undefined : outcome.value.reason,
        });
      } else if (outcome.status === 'timeout') {
        readinessThrewOrTimedOut = true;
        const reason = `readiness ${outcome.error}`;
        readiness = { ok: false, reason };
        errors.push(reason);
        safeLog(logger, {
          providerId: identity.providerId,
          stage: 'readiness',
          outcome: 'timeout',
          message: reason,
        });
      } else {
        readinessThrewOrTimedOut = true;
        const reason = outcome.error ?? 'unknown error';
        readiness = { ok: false, reason };
        errors.push(reason);
        safeLog(logger, {
          providerId: identity.providerId,
          stage: 'readiness',
          outcome: 'error',
          message: reason,
        });
      }
    } catch (err) {
      readinessThrewOrTimedOut = true;
      const msg = errorMessage(err);
      readiness = { ok: false, reason: msg };
      errors.push(msg);
      safeLog(logger, {
        providerId: identity.providerId,
        stage: 'readiness',
        outcome: 'error',
        message: msg,
      });
    }
  }

  const threw =
    !identityOk ||
    !capabilitiesOk ||
    healthThrewOrTimedOut ||
    readinessThrewOrTimedOut;
  const negative =
    (health !== undefined && health.ok === false) ||
    (readiness !== undefined && readiness.ok === false);

  let outcome: ShadowCheckOutcome;
  if (threw) {
    outcome = 'unavailable';
  } else if (negative) {
    outcome = 'degraded';
  } else {
    outcome = 'ok';
  }

  const result: ShadowProbeResult = {
    providerId: identity.providerId,
    outcome,
    identity,
    capabilities,
    ...(health !== undefined ? { health } : {}),
    ...(readinessPresent && readiness !== undefined ? { readiness } : {}),
    errors: Object.freeze([...errors]),
    latencyMs: Object.freeze({ ...latencyMs }),
  };

  return Object.freeze(result);
}

export async function runShadowProbe(
  options: ShadowProbeOptions,
): Promise<ShadowProbeReport> {
  const startedAt = new Date().toISOString();
  try {
    const env = options.env;
    if (!env || env.shadowEnabled !== true || env.experimentalEnabled !== true) {
      const finishedAt = new Date().toISOString();
      return Object.freeze({
        enabled: false,
        skippedReason: 'flags_disabled' as const,
        results: Object.freeze([] as readonly ShadowProbeResult[]),
        startedAt,
        finishedAt,
      });
    }

    const providers = options.providers ?? [];
    if (providers.length === 0) {
      const finishedAt = new Date().toISOString();
      return Object.freeze({
        enabled: true,
        skippedReason: 'no_providers' as const,
        results: Object.freeze([] as readonly ShadowProbeResult[]),
        startedAt,
        finishedAt,
      });
    }

    const timeoutMs =
      typeof options.perCheckTimeoutMs === 'number' && options.perCheckTimeoutMs > 0
        ? options.perCheckTimeoutMs
        : DEFAULT_TIMEOUT_MS;

    const results: ShadowProbeResult[] = [];
    for (const provider of providers) {
      try {
        results.push(await probeOne(provider, timeoutMs, options.logger));
      } catch (err) {
        const msg = errorMessage(err);
        results.push(
          Object.freeze({
            providerId: UNKNOWN_PROVIDER_ID,
            outcome: 'unavailable' as const,
            identity: {
              providerId: UNKNOWN_PROVIDER_ID,
              backendFamily: '<unknown>',
              model: '<unknown>',
              transport: '<unknown>',
            },
            capabilities: {
              supportsCancellation: false,
              supportsStreaming: false,
              supportsEmbeddings: false,
              supportsRerank: false,
              privacyClass: '<unknown>',
            },
            errors: Object.freeze([msg]),
            latencyMs: Object.freeze({}),
          }) as ShadowProbeResult,
        );
      }
    }

    const finishedAt = new Date().toISOString();
    return Object.freeze({
      enabled: true,
      results: Object.freeze(results.slice()),
      startedAt,
      finishedAt,
    });
  } catch {
    const finishedAt = new Date().toISOString();
    return Object.freeze({
      enabled: false,
      skippedReason: 'flags_disabled' as const,
      results: Object.freeze([] as readonly ShadowProbeResult[]),
      startedAt,
      finishedAt,
    });
  }
}
