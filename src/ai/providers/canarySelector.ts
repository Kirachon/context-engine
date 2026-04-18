// Manual canary selector.
//
// Safety invariant: this module ONLY decides which provider id a caller
// SHOULD use; it never invokes providers, never retries on failure, and
// never auto-falls-back from canary to rollback after an error. The caller
// is responsible for executing the request and for any explicit fallback
// behavior. openai_session is always the rollback target.

import type { ProviderEnvConfig } from './env.js';
import { isKnownProviderId } from './registry.js';

export type CanaryDecisionMode =
  | 'rollback_default'
  | 'canary_selected'
  | 'disabled'
  | 'invalid_target';

export interface CanaryDecisionInput {
  readonly env: ProviderEnvConfig;
  readonly canaryTargetId?: string;
  readonly canarySamplePercent?: number;
  readonly requestKey?: string;
  readonly randomSeed?: () => number;
  readonly isKnownIdOverride?: (id: string) => boolean;
}

export interface CanaryDecision {
  readonly mode: CanaryDecisionMode;
  readonly providerId: 'openai_session' | string;
  readonly rollbackProviderId: 'openai_session';
  readonly reason: string;
}

const ROLLBACK: 'openai_session' = 'openai_session';

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function clampPercent(raw: number | undefined): number {
  const v = raw ?? 100;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

export function selectCanaryProvider(input: CanaryDecisionInput): CanaryDecision {
  const { env } = input;

  if (!env.experimentalEnabled || !env.canaryEnabled) {
    return {
      mode: 'disabled',
      providerId: ROLLBACK,
      rollbackProviderId: ROLLBACK,
      reason: 'canary disabled by env flags',
    };
  }

  const rawTarget = input.canaryTargetId;
  const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
  if (target.length === 0 || target === ROLLBACK) {
    return {
      mode: 'rollback_default',
      providerId: ROLLBACK,
      rollbackProviderId: ROLLBACK,
      reason: 'no canary target specified, falling back to openai_session',
    };
  }

  const knownCheck = input.isKnownIdOverride ?? isKnownProviderId;
  if (!knownCheck(target)) {
    return {
      mode: 'invalid_target',
      providerId: ROLLBACK,
      rollbackProviderId: ROLLBACK,
      reason: `canary target "${target}" not in registry; using rollback openai_session`,
    };
  }

  const pct = clampPercent(input.canarySamplePercent);

  if (pct === 0) {
    return {
      mode: 'rollback_default',
      providerId: ROLLBACK,
      rollbackProviderId: ROLLBACK,
      reason: 'canary sample rate is 0%; using rollback',
    };
  }

  if (pct === 100) {
    return {
      mode: 'canary_selected',
      providerId: target,
      rollbackProviderId: ROLLBACK,
      reason: `canary at 100% sample, routing to ${target}`,
    };
  }

  let selected: boolean;
  if (typeof input.requestKey === 'string' && input.requestKey.length > 0) {
    const bucket = fnv1a(input.requestKey) % 10000;
    selected = bucket < pct * 100;
  } else {
    const rand = input.randomSeed ?? Math.random;
    selected = rand() * 100 < pct;
  }

  if (selected) {
    return {
      mode: 'canary_selected',
      providerId: target,
      rollbackProviderId: ROLLBACK,
      reason: `canary sampled in at ${pct}%`,
    };
  }
  return {
    mode: 'rollback_default',
    providerId: ROLLBACK,
    rollbackProviderId: ROLLBACK,
    reason: `canary sampled out at ${pct}%`,
  };
}
