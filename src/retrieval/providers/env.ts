import { RetrievalProviderError, type RetrievalProviderId } from './types.js';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface RetrievalProviderEnv {
  providerId: RetrievalProviderId;
  shadowCompareEnabled: boolean;
  shadowSampleRate: number;
}

export function resolveRetrievalProviderId(
  env: NodeJS.ProcessEnv = process.env
): RetrievalProviderId {
  return resolveRetrievalProviderEnv(env).providerId;
}

export function resolveRetrievalProviderEnv(env: NodeJS.ProcessEnv = process.env): RetrievalProviderEnv {
  const configuredProvider = parseProviderId(env.CE_RETRIEVAL_PROVIDER);
  const shadowCompareEnabled = parseBooleanEnv(
    env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED,
    false,
    'CE_RETRIEVAL_SHADOW_COMPARE_ENABLED'
  );
  const shadowSampleRate = parseSampleRate(env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE);
  return {
    providerId: configuredProvider ?? 'local_native',
    shadowCompareEnabled,
    shadowSampleRate,
  };
}

export function shouldRunShadowCompare(
  config: Pick<RetrievalProviderEnv, 'shadowCompareEnabled' | 'shadowSampleRate'>,
  randomValue: number = Math.random()
): boolean {
  if (!config.shadowCompareEnabled) {
    return false;
  }
  if (config.shadowSampleRate <= 0) {
    return false;
  }
  if (config.shadowSampleRate >= 1) {
    return true;
  }
  return randomValue < config.shadowSampleRate;
}

function parseProviderId(raw: string | undefined): RetrievalProviderId | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'local_native' || normalized === 'local_native_v2') {
    if (normalized === 'local_native_v2') {
      return 'local_native_v2';
    }
    return 'local_native';
  }
  throw new RetrievalProviderError({
    code: 'provider_config_invalid',
    envVar: 'CE_RETRIEVAL_PROVIDER',
    message: `Invalid CE_RETRIEVAL_PROVIDER value "${raw}". Allowed values: local_native, local_native_v2`,
  });
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }
  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    `Invalid ${name} value "${raw}". Allowed values: 1, true, yes, on, 0, false, no, off`
  );
}

function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Invalid CE_RETRIEVAL_SHADOW_SAMPLE_RATE value "${raw}". Expected a number between 0 and 1 (inclusive).`
    );
  }
  return parsed;
}
