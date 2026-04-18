import type { ProviderCapabilities } from './capabilities.js';
import type {
  ProviderContractV1,
  ProviderGenerateRequest,
  ProviderGenerateResponse,
  ProviderHealthStatus,
  ProviderIdentity,
  ProviderOperationOptions,
} from './contract.js';
import { AIProviderError } from './errors.js';
import type {
  AIProvider,
  AIProviderId,
  AIProviderRequest,
  AIProviderResponse,
} from './types.js';

export interface LegacyToV1Options {
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function computeTimeoutMs(
  options: ProviderOperationOptions | undefined,
  bridgeOptions: LegacyToV1Options | undefined,
  providerId: string
): number {
  const deadlineMs = options?.deadlineMs;
  if (typeof deadlineMs === 'number' && Number.isFinite(deadlineMs)) {
    const remaining = Math.floor(deadlineMs - Date.now());
    if (remaining <= 0) {
      throw new AIProviderError({
        code: 'provider_timeout',
        provider: providerId,
        message: 'request deadline already elapsed',
        retryable: true,
      });
    }
    return Math.max(1, remaining);
  }
  if (typeof bridgeOptions?.defaultTimeoutMs === 'number') {
    return bridgeOptions.defaultTimeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

export function adaptLegacyToV1(
  legacy: AIProvider,
  identity: ProviderIdentity,
  capabilities: ProviderCapabilities,
  options?: LegacyToV1Options
): ProviderContractV1 {
  const frozenIdentity = Object.freeze(identity);
  const frozenCapabilities = Object.freeze(capabilities);

  const generate = async (
    request: ProviderGenerateRequest,
    opOptions?: ProviderOperationOptions
  ): Promise<ProviderGenerateResponse> => {
    const timeoutMs = computeTimeoutMs(opOptions, options, identity.providerId);
    const legacyReq: AIProviderRequest = {
      searchQuery: request.searchQuery ?? '',
      prompt: request.prompt,
      timeoutMs,
      workspacePath: request.workspacePath ?? process.cwd(),
      signal: opOptions?.signal,
      deadlineMs: opOptions?.deadlineMs,
    };
    const legacyResp = await legacy.call(legacyReq);

    const mapped: ProviderGenerateResponse = {
      text: legacyResp.text,
      model: legacyResp.model,
      finishReason: legacyResp.finishReason,
      latencyMs: legacyResp.latencyMs,
      ...(legacyResp.warnings
        ? {
            warnings: legacyResp.warnings.map((w) => ({
              code: 'legacy_warning',
              message: w,
            })),
          }
        : {}),
      privacyClass: legacyResp.privacyClass ?? frozenCapabilities.privacyClass,
    };
    return mapped;
  };

  const health = (_opOptions?: ProviderOperationOptions): Promise<ProviderHealthStatus> => {
    if (typeof legacy.health === 'function') {
      return legacy.health();
    }
    return Promise.resolve({ ok: true });
  };

  const v1: ProviderContractV1 = {
    contractVersion: 'v1',
    identity: frozenIdentity,
    capabilities: frozenCapabilities,
    generate,
    health,
  };
  return v1;
}

export function adaptV1ToLegacy(v1: ProviderContractV1): AIProvider {
  const legacy: AIProvider = {
    // adapter: legacy id is type-narrowed by callers
    id: v1.identity.providerId as AIProviderId,
    modelLabel: v1.identity.model,
    capabilities: v1.capabilities,
    async call(request: AIProviderRequest): Promise<AIProviderResponse> {
      const v1Req: ProviderGenerateRequest = {
        prompt: request.prompt ?? request.searchQuery,
        searchQuery: request.searchQuery,
        workspacePath: request.workspacePath,
      };
      const opts: ProviderOperationOptions = {
        signal: request.signal,
        deadlineMs: request.deadlineMs,
      };
      const v1Resp = await v1.generate(v1Req, opts);
      const finishReason: AIProviderResponse['finishReason'] =
        v1Resp.finishReason === 'tool_calls' ? 'error' : v1Resp.finishReason;
      const resp: AIProviderResponse = {
        text: v1Resp.text ?? '',
        model: v1Resp.model,
        finishReason,
        latencyMs: v1Resp.latencyMs,
        warnings: v1Resp.warnings?.map((w) => w.message),
        privacyClass: v1Resp.privacyClass,
      };
      return resp;
    },
    health(): Promise<ProviderHealthStatus> {
      return v1.health();
    },
  };
  return legacy;
}
