import { RetrievalProviderError, type RetrievalProviderId } from './types.js';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface RetrievalProviderEnv {
  providerId: RetrievalProviderId;
  forceLegacy: boolean;
  shadowCompareEnabled: boolean;
  shadowSampleRate: number;
}

type AugmentLegacySelectionSource = 'CE_RETRIEVAL_PROVIDER' | 'CE_RETRIEVAL_FORCE_LEGACY' | 'providerId';

export function resolveRetrievalProviderId(
  env: NodeJS.ProcessEnv = process.env
): RetrievalProviderId {
  return resolveRetrievalProviderEnv(env).providerId;
}

export function resolveRetrievalProviderEnv(env: NodeJS.ProcessEnv = process.env): RetrievalProviderEnv {
  const configuredProvider = parseProviderId(env.CE_RETRIEVAL_PROVIDER);
  const forceLegacy = parseBooleanEnv(env.CE_RETRIEVAL_FORCE_LEGACY, false, 'CE_RETRIEVAL_FORCE_LEGACY');
  const shadowCompareEnabled = parseBooleanEnv(
    env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED,
    false,
    'CE_RETRIEVAL_SHADOW_COMPARE_ENABLED'
  );
  const shadowSampleRate = parseSampleRate(env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE);
  const providerId = forceLegacy ? 'augment_legacy' : configuredProvider ?? 'local_native';

  if (providerId === 'augment_legacy' && (forceLegacy || configuredProvider === 'augment_legacy')) {
    validateAugmentLegacyAuthConfig(env, {
      selectionSource: forceLegacy ? 'CE_RETRIEVAL_FORCE_LEGACY' : 'CE_RETRIEVAL_PROVIDER',
    });
  }

  return {
    providerId,
    forceLegacy,
    shadowCompareEnabled,
    shadowSampleRate,
  };
}

export function validateAugmentLegacyAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { selectionSource?: AugmentLegacySelectionSource } = {}
): void {
  const source = options.selectionSource ?? 'providerId';
  const sourceLabel = describeSelectionSource(source);
  const token = env.AUGMENT_API_TOKEN?.trim();
  if (!token) {
    throw new RetrievalProviderError({
      code: 'provider_auth_missing',
      provider: 'augment_legacy',
      envVar: 'AUGMENT_API_TOKEN',
      message: `Retrieval provider "augment_legacy" selected via ${sourceLabel} requires AUGMENT_API_TOKEN to be set.`,
    });
  }

  const rawApiUrl = env.AUGMENT_API_URL?.trim();
  if (!rawApiUrl) {
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawApiUrl);
  } catch (cause) {
    throw new RetrievalProviderError({
      code: 'provider_auth_invalid',
      provider: 'augment_legacy',
      envVar: 'AUGMENT_API_URL',
      message: `Retrieval provider "augment_legacy" selected via ${sourceLabel} requires AUGMENT_API_URL to be a valid URL when set.`,
      cause,
    });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new RetrievalProviderError({
      code: 'provider_auth_invalid',
      provider: 'augment_legacy',
      envVar: 'AUGMENT_API_URL',
      message: `Retrieval provider "augment_legacy" selected via ${sourceLabel} requires AUGMENT_API_URL to use http or https when set.`,
    });
  }
}

function describeSelectionSource(source: AugmentLegacySelectionSource): string {
  if (source === 'providerId') {
    return 'createRetrievalProvider providerId override';
  }
  return source;
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
  if (normalized === 'augment' || normalized === 'augment_legacy') {
    return 'augment_legacy';
  }
  if (normalized === 'local_native') {
    return 'local_native';
  }
  throw new RetrievalProviderError({
    code: 'provider_config_invalid',
    envVar: 'CE_RETRIEVAL_PROVIDER',
    message: `Invalid CE_RETRIEVAL_PROVIDER value "${raw}". Allowed values: augment_legacy, local_native`,
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
