export type AIProviderId = 'openai_session';

export interface AIProviderRequest {
  searchQuery: string;
  prompt?: string;
  timeoutMs: number;
  workspacePath: string;
}

export interface AIProviderResponse {
  text: string;
  model: string;
}

export type AIProviderErrorCode =
  | 'provider_auth'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_exec_error'
  | 'provider_parse_error';

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly provider: AIProviderId;
  readonly retryable: boolean;

  constructor(args: {
    code: AIProviderErrorCode;
    provider: AIProviderId;
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

export interface AIProvider {
  readonly id: AIProviderId;
  readonly modelLabel: string;
  call(request: AIProviderRequest): Promise<AIProviderResponse>;
}
