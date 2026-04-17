import type { ProviderCapabilities, ProviderPrivacyClass } from './capabilities.js';

export interface ProviderOperationOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly authHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderHealthStatus {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface ProviderIdentity {
  readonly providerId: string;
  readonly backendFamily: string;
  readonly model: string;
  readonly transport: string;
}

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderWarning {
  readonly code: string;
  readonly message: string;
}

export interface ProviderToolCall {
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ProviderGenerateRequest {
  readonly prompt: string;
  readonly searchQuery?: string;
  readonly model?: string;
  readonly workspacePath?: string;
  readonly responseMode?: 'text' | 'json' | 'tools';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderGenerateResponse {
  readonly text?: string;
  readonly json?: unknown;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly model: string;
  readonly finishReason?: 'stop' | 'length' | 'tool_calls' | 'timeout' | 'cancelled' | 'error';
  readonly usage?: ProviderUsage;
  readonly latencyMs?: number;
  readonly warnings?: readonly ProviderWarning[];
  readonly privacyClass: ProviderPrivacyClass;
}

export interface ProviderEmbeddingRequest {
  readonly inputs: readonly string[];
  readonly model?: string;
  readonly inputType?: 'document' | 'query';
}

export interface ProviderEmbeddingResponse {
  readonly vectors: readonly number[][];
  readonly model: string;
  readonly dimensions: number;
  readonly warnings?: readonly ProviderWarning[];
  readonly privacyClass: ProviderPrivacyClass;
}

export interface ProviderRerankRequest {
  readonly query: string;
  readonly candidates: readonly string[];
  readonly model?: string;
}

export interface ProviderRerankResult {
  readonly index: number;
  readonly score: number;
}

export interface ProviderRerankResponse {
  readonly results: readonly ProviderRerankResult[];
  readonly model: string;
  readonly warnings?: readonly ProviderWarning[];
  readonly privacyClass: ProviderPrivacyClass;
}

/**
 * Frozen v1 provider contract for future adapters. Existing `AIProvider`
 * implementations remain supported as a backward-compatibility shim while the
 * repo migrates to this richer shape.
 */
export interface ProviderContractV1 {
  readonly contractVersion: 'v1';
  readonly identity: ProviderIdentity;
  readonly capabilities: ProviderCapabilities;
  generate(
    request: ProviderGenerateRequest,
    options?: ProviderOperationOptions
  ): Promise<ProviderGenerateResponse>;
  embed?(
    request: ProviderEmbeddingRequest,
    options?: ProviderOperationOptions
  ): Promise<ProviderEmbeddingResponse>;
  rerank?(
    request: ProviderRerankRequest,
    options?: ProviderOperationOptions
  ): Promise<ProviderRerankResponse>;
  health(options?: ProviderOperationOptions): Promise<ProviderHealthStatus>;
  readiness?(options?: ProviderOperationOptions): Promise<ProviderHealthStatus>;
  dispose?(): Promise<void> | void;
}
