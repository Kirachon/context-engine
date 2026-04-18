import { ProviderPrivacyClass, type ProviderCapabilities } from './capabilities.js';
import type { ProviderIdentity } from './contract.js';

/**
 * Frozen identity descriptor for the OpenAI Codex Session provider, suitable
 * for constructing a `ProviderContractV1` facade over the existing
 * `CodexSessionProvider` legacy implementation.
 */
export const OPENAI_SESSION_IDENTITY: ProviderIdentity = Object.freeze({
  providerId: 'openai_session',
  backendFamily: 'openai',
  model: 'codex-session',
  transport: 'subprocess',
});

/**
 * Conservative capability descriptor that reflects the actual subprocess-backed
 * behavior of the Codex Session CLI: cancellation via `signal`, no streaming,
 * hosted through OpenAI Codex CLI, and a single in-flight request to avoid
 * CLI race conditions. Future slices may refine these values.
 */
export const OPENAI_SESSION_CAPABILITIES: ProviderCapabilities = Object.freeze({
  supportsCancellation: true,
  supportsStreaming: false,
  supportsEmbeddings: false,
  supportsRerank: false,
  maxInFlight: 1,
  maxContextTokens: 200_000,
  privacyClass: ProviderPrivacyClass.Hosted,
  requestIsolation: Object.freeze({
    authHeadersPerRequest: true,
    noSharedMutableAuthState: true,
    modelSelectionPerRequest: false,
  }),
});
