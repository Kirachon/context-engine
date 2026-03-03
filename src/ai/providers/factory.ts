import { CodexSessionProvider } from './codexSessionProvider.js';
import type { AIProvider, AIProviderId } from './types.js';

export function resolveAIProviderId(): AIProviderId {
  const configured = process.env.CE_AI_PROVIDER?.trim();
  if (!configured || configured === 'openai_session') {
    return 'openai_session';
  }
  throw new Error(
    `OpenAI-only provider policy: CE_AI_PROVIDER must be openai_session (or unset). Received: ${configured}`
  );
}

export function createAIProvider(args: {
  providerId: AIProviderId;
  getAugmentContext: () => Promise<unknown>;
  maxRateLimitRetries: number;
  baseRateLimitBackoffMs: number;
  maxRateLimitBackoffMs: number;
}): AIProvider {
  if (args.providerId !== 'openai_session') {
    throw new Error(
      `OpenAI-only provider policy: provider "${args.providerId}" is not supported. Use openai_session only.`
    );
  }
  return new CodexSessionProvider();
}
