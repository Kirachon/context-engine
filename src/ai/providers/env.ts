/**
 * Fail-closed environment configuration for the multi-provider framework.
 *
 * Pure module: no I/O, no mutation of the input env. Other slices will consume
 * this to decide which provider to construct and whether shadow/canary lanes
 * are eligible. CE_AI_PROVIDER alone is intentionally insufficient to activate
 * any experimental behavior; the experimental gate must be set independently.
 */

const DEFAULT_PROVIDER_ID = 'openai_session';
const EXPERIMENTAL_FLAG = 'CE_AI_ENABLE_EXPERIMENTAL_PROVIDERS';
const SHADOW_FLAG = 'CE_AI_ENABLE_SHADOW';
const CANARY_FLAG = 'CE_AI_ENABLE_CANARY';
const PROVIDER_KEY = 'CE_AI_PROVIDER';

export interface ProviderEnvConfig {
  readonly providerId: 'openai_session' | string;
  readonly experimentalEnabled: boolean;
  readonly shadowEnabled: boolean;
  readonly canaryEnabled: boolean;
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readBool(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = readTrimmed(env, key);
  if (v === undefined) return false;
  const lower = v.toLowerCase();
  return lower === '1' || lower === 'true';
}

export function readProviderEnvConfig(env: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const experimentalEnabled = readBool(env, EXPERIMENTAL_FLAG);

  const rawProvider = readTrimmed(env, PROVIDER_KEY);
  const providerId = rawProvider ?? DEFAULT_PROVIDER_ID;

  if (providerId !== DEFAULT_PROVIDER_ID && !experimentalEnabled) {
    throw new Error(
      `Provider '${providerId}' requires ${EXPERIMENTAL_FLAG}=1 to be enabled. ` +
        `CE_AI_PROVIDER alone cannot activate non-${DEFAULT_PROVIDER_ID} providers.`,
    );
  }

  const shadowRequested = readBool(env, SHADOW_FLAG);
  if (shadowRequested && !experimentalEnabled) {
    throw new Error(
      `${SHADOW_FLAG} requires ${EXPERIMENTAL_FLAG}=1 to be enabled separately.`,
    );
  }
  const shadowEnabled = shadowRequested && experimentalEnabled;

  const canaryRequested = readBool(env, CANARY_FLAG);
  if (canaryRequested && !experimentalEnabled) {
    throw new Error(
      `${CANARY_FLAG} requires ${EXPERIMENTAL_FLAG}=1 to be enabled separately.`,
    );
  }
  const canaryEnabled = canaryRequested && experimentalEnabled;

  return Object.freeze({
    providerId,
    experimentalEnabled,
    shadowEnabled,
    canaryEnabled,
  });
}
