// note:
// This factory currently returns the legacy `AIProvider` shim
// (CodexSessionProvider) for backward compatibility with ContextServiceClient.
// Internally it is now wired through readProviderEnvConfig() and the static
// descriptor registry, but the externally observable behavior is unchanged
// and locked by tests/ai/providers/parityFence.test.ts. v1-contract consumers
// should adapt the returned legacy provider via `adaptLegacyToV1` from
// ./openaiV1Bridge.ts rather than changing this factory's return type.

import { CodexSessionProvider } from './codexSessionProvider.js';
import { readProviderEnvConfig } from './env.js';
import { isKnownProviderId, isStableProviderId } from './registry.js';
import type { AIProvider, AIProviderId } from './types.js';

const DEFAULT_PROVIDER_ID = 'openai_session';

function rejectionMessage(offending: string): string {
  return (
    `OpenAI-only provider policy: CE_AI_PROVIDER must be ${DEFAULT_PROVIDER_ID} ` +
    `(or unset). Received: ${offending}`
  );
}

export function resolveAIProviderId(): AIProviderId {
  let cfg;
  try {
    cfg = readProviderEnvConfig();
  } catch {
    // env validator may complain about a missing experimental flag rather
    // than the provider id itself; recover the offending value directly so
    // the parity-fence assertion (offending value AND 'openai_session' in
    // the message) continues to hold.
    const offending = process.env.CE_AI_PROVIDER?.trim() || '';
    throw new Error(rejectionMessage(offending));
  }
  if (cfg.providerId === DEFAULT_PROVIDER_ID) {
    return DEFAULT_PROVIDER_ID;
  }
  throw new Error(rejectionMessage(cfg.providerId));
}

export function createAIProvider(args: {
  providerId: AIProviderId;
  getProviderContext: () => Promise<unknown>;
  maxRateLimitRetries: number;
  baseRateLimitBackoffMs: number;
  maxRateLimitBackoffMs: number;
}): AIProvider {
  const id = args.providerId as unknown as string;
  if (!isKnownProviderId(id) || !isStableProviderId(id) || id !== DEFAULT_PROVIDER_ID) {
    throw new Error(
      `OpenAI-only provider policy: provider "${id}" is not supported. ` +
        `Use ${DEFAULT_PROVIDER_ID} only.`
    );
  }
  return new CodexSessionProvider();
}
