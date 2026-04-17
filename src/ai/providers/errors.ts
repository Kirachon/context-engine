export type AIProviderErrorCode =
  | 'provider_auth'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_exec_error'
  | 'provider_parse_error'
  | 'provider_aborted'
  | 'provider_capability'
  | 'provider_circuit_open';

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(args: {
    code: AIProviderErrorCode;
    provider: string;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'AIProviderError';
    this.code = args.code;
    this.provider = args.provider;
    this.retryable = args.retryable ?? false;
    if (args.cause !== undefined) {
      this.cause = args.cause;
    }
  }
}

type ProviderErrorArgs = {
  provider: string;
  message?: string;
  retryable?: boolean;
  cause?: unknown;
};

export class ProviderAbortedError extends AIProviderError {
  constructor(args: ProviderErrorArgs) {
    super({
      code: 'provider_aborted',
      provider: args.provider,
      message: args.message ?? 'Provider request was aborted.',
      retryable: args.retryable ?? false,
      cause: args.cause,
    });
    this.name = 'ProviderAbortedError';
  }
}

export class ProviderTimeoutError extends AIProviderError {
  constructor(args: ProviderErrorArgs) {
    super({
      code: 'provider_timeout',
      provider: args.provider,
      message: args.message ?? 'Provider request timed out before completing.',
      retryable: args.retryable ?? true,
      cause: args.cause,
    });
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderCapabilityError extends AIProviderError {
  constructor(args: ProviderErrorArgs) {
    super({
      code: 'provider_capability',
      provider: args.provider,
      message: args.message ?? 'Provider does not support the requested capability.',
      retryable: args.retryable ?? false,
      cause: args.cause,
    });
    this.name = 'ProviderCapabilityError';
  }
}

export class ProviderCircuitOpenError extends AIProviderError {
  constructor(args: ProviderErrorArgs) {
    super({
      code: 'provider_circuit_open',
      provider: args.provider,
      message: args.message ?? 'Provider circuit is open and temporarily rejecting new work.',
      retryable: args.retryable ?? true,
      cause: args.cause,
    });
    this.name = 'ProviderCircuitOpenError';
  }
}

export class ProviderAuthError extends AIProviderError {
  constructor(args: ProviderErrorArgs) {
    super({
      code: 'provider_auth',
      provider: args.provider,
      message: args.message ?? 'Provider authentication failed.',
      retryable: args.retryable ?? false,
      cause: args.cause,
    });
    this.name = 'ProviderAuthError';
  }
}
