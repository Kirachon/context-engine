import type { ProviderCapabilities, ProviderPrivacyClass } from './capabilities.js';
import type { ProviderHealthStatus } from './contract.js';

export { AIProviderError } from './errors.js';
export type { AIProviderErrorCode } from './errors.js';
export {
  ProviderAbortedError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderCircuitOpenError,
  ProviderTimeoutError,
} from './errors.js';
export * from './capabilities.js';
export * from './contract.js';

export type AIProviderId = 'openai_session';

/**
 * Legacy compatibility request shape for the current `openai_session`
 * implementation. New adapters should use `ProviderContractV1` +
 * `ProviderOperationOptions` instead.
 */
export interface AIProviderRequest {
  searchQuery: string;
  prompt?: string;
  timeoutMs: number;
  workspacePath: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface AIProviderResponse {
  text: string;
  model: string;
  finishReason?: 'stop' | 'length' | 'timeout' | 'cancelled' | 'error';
  latencyMs?: number;
  warnings?: readonly string[];
  privacyClass?: ProviderPrivacyClass;
}

/**
 * Backward-compatible runtime shim while the repo migrates to
 * `ProviderContractV1`. Existing adapters may implement this smaller surface;
 * future adapters should expose `capabilities` and `health`.
 */
export interface AIProvider {
  readonly id: AIProviderId;
  readonly modelLabel: string;
  readonly capabilities?: ProviderCapabilities;
  call(request: AIProviderRequest): Promise<AIProviderResponse>;
  health?(): Promise<ProviderHealthStatus>;
}
