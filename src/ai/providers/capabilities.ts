/**
 * Privacy classes define the strongest privacy claim a provider can make and
 * therefore what operators may safely expose in telemetry and logs.
 */
export enum ProviderPrivacyClass {
  /**
   * Requests stay on the local machine or loopback boundary. Telemetry may log
   * provider identity and health state, but must still avoid prompt bodies and
   * auth material.
   */
  Local = 'local',
  /**
   * Requests stay on operator-managed infrastructure. Telemetry/logs must
   * treat endpoints, tenant routing, and auth details as sensitive.
   */
  SelfHosted = 'self-hosted',
  /**
   * Requests may leave the operator-controlled environment for a hosted
   * service. Telemetry/logs must assume external egress and never record raw
   * prompts, completions, or credentials.
   */
  Hosted = 'hosted',
  /**
   * Privacy or cancellation guarantees cannot be made. Exclude from default
   * configuration until the adapter satisfies the frozen contract.
   */
  Unsupported = 'unsupported',
}

export interface ProviderRequestIsolation {
  /** Authentication and headers are composed per request, never via shared mutable state. */
  readonly authHeadersPerRequest: boolean;
  /** Tenant-specific auth/config mutation is isolated between concurrent requests. */
  readonly noSharedMutableAuthState: boolean;
  /** Simultaneous requests can select different models without cross-request bleed. */
  readonly modelSelectionPerRequest: boolean;
}

export interface ProviderConnectionPoolLimits {
  /** Upper bound on concurrently open upstream connections. */
  readonly maxConnections: number;
  /** Optional cap for idle keep-alive connections retained by the adapter. */
  readonly maxIdleConnections?: number;
  /** Optional cap for sockets reused per origin/host. */
  readonly maxSocketsPerOrigin?: number;
  /** Whether the adapter intentionally reuses sockets between requests. */
  readonly reuseSockets: boolean;
}

export interface ProviderCircuitBreaker {
  readonly failureWindow: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface ProviderCapabilities {
  /**
   * True only when queued and in-flight work can be aborted end-to-end.
   *
   * Spawn-per-call or subprocess-backed providers MUST propagate kill-on-abort
   * and kill-on-shutdown. If they cannot, set `supportsCancellation = false`
   * and `privacyClass = ProviderPrivacyClass.Unsupported` so they are excluded
   * from default configuration instead of acting as a silent exception.
   */
  readonly supportsCancellation: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsEmbeddings: boolean;
  readonly supportsRerank: boolean;
  readonly maxInFlight: number;
  readonly maxContextTokens: number;
  readonly privacyClass: ProviderPrivacyClass;
  readonly requestIsolation: ProviderRequestIsolation;
  readonly connectionPool?: ProviderConnectionPoolLimits;
  readonly circuitBreaker?: ProviderCircuitBreaker;
  readonly backpressure?: 'queue' | 'reject' | 'caller_managed';
}
