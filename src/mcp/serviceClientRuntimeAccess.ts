import { envInt, envMs } from '../config/env.js';
import { createAIProvider } from '../ai/providers/factory.js';
import type { AIProvider, AIProviderId } from '../ai/providers/types.js';
import { incCounter, observeDurationMs, setGauge } from '../metrics/metrics.js';
import { formatRequestLogPrefix } from '../telemetry/requestContext.js';

const DEFAULT_RATE_LIMIT_MAX_RETRIES = 2;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000;
const MIN_RATE_LIMIT_BACKOFF_MS = 100;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_API_TIMEOUT_MS = 180_000;
const MIN_API_TIMEOUT_MS = 1_000;
const MAX_API_TIMEOUT_MS = 30 * 60 * 1000;
const SEARCH_AND_ASK_TOTAL_DURATION_METRIC = 'context_engine_search_and_ask_duration_seconds';
const SEARCH_AND_ASK_QUEUE_WAIT_METRIC = 'context_engine_search_and_ask_queue_wait_seconds';
const SEARCH_AND_ASK_EXECUTION_METRIC = 'context_engine_search_and_ask_execution_seconds';
const SEARCH_QUEUE_TIMEOUT_ADMISSION_DEPTH_THRESHOLD = 2;
const SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS = 2_000;
const SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS = 5_000;

function formatScopedLog(message: string): string {
  return `${formatRequestLogPrefix()} ${message}`;
}

type SearchAndAskPriority = 'interactive' | 'background';

export interface RuntimeSearchQueueLike {
  readonly length: number;
  readonly depth: number;
  enqueue(
    fn: () => Promise<string>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<string>;
}

export class SearchQueuePressureTimeoutError extends Error {
  readonly code = 'SEARCH_QUEUE_PRESSURE_TIMEOUT';

  constructor(timeoutMs: number, queueDepth: number, minimumBudgetMs: number, lane: SearchAndAskPriority) {
    super(
      `searchAndAsk timeout budget (${timeoutMs}ms) is too small for ${lane} lane queue depth (${queueDepth}). `
      + `Estimated minimum budget: ${minimumBudgetMs}ms. Retry with a larger timeout or when queue pressure is lower.`
    );
    this.name = 'SearchQueuePressureTimeoutError';
  }
}

export interface ServiceClientSearchAndAskOptions {
  searchQuery: string;
  prompt?: string;
  timeoutMs?: number;
  priority?: SearchAndAskPriority;
  signal?: AbortSignal;
  searchQueues: Record<SearchAndAskPriority, RuntimeSearchQueueLike>;
}

function publishSearchQueueDepthMetrics(searchQueues: Record<SearchAndAskPriority, RuntimeSearchQueueLike>): void {
  const interactiveDepth = searchQueues.interactive.depth;
  const backgroundDepth = searchQueues.background.depth;
  const helpText = 'Number of searchAndAsk requests in-flight or waiting in the queue.';

  setGauge('context_engine_search_and_ask_queue_depth', undefined, interactiveDepth + backgroundDepth, helpText);
  setGauge('context_engine_search_and_ask_queue_depth', { lane: 'interactive' }, interactiveDepth, helpText);
  setGauge('context_engine_search_and_ask_queue_depth', { lane: 'background' }, backgroundDepth, helpText);
}

function isQueueFullError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'SEARCH_QUEUE_FULL'
  );
}

export interface ServiceClientRuntimeAccessOptions {
  workspacePath: string;
  getAIProviderId: () => AIProviderId;
  getCachedProvider: () => AIProvider | null;
  setCachedProvider: (provider: AIProvider) => void;
}

export class ServiceClientRuntimeAccess {
  constructor(private readonly options: ServiceClientRuntimeAccessOptions) {}

  getActiveAIProviderId(): AIProviderId {
    return this.options.getAIProviderId();
  }

  getActiveAIModelLabel(): string {
    return this.getProvider().modelLabel;
  }

  getProvider(): AIProvider {
    const cached = this.options.getCachedProvider();
    if (cached) {
      return cached;
    }

    const providerId = this.options.getAIProviderId();
    try {
      const provider = createAIProvider({
        providerId,
        getProviderContext: async () => {
          throw new Error('OpenAI-only provider policy: legacy retrieval runtime path is disabled.');
        },
        maxRateLimitRetries: envInt('CE_AI_RATE_LIMIT_MAX_RETRIES', DEFAULT_RATE_LIMIT_MAX_RETRIES, {
          min: 0,
          max: 10,
        }),
        baseRateLimitBackoffMs: envMs('CE_AI_RATE_LIMIT_BACKOFF_MS', DEFAULT_RATE_LIMIT_BACKOFF_MS, {
          min: MIN_RATE_LIMIT_BACKOFF_MS,
          max: MAX_RATE_LIMIT_BACKOFF_MS,
        }),
        maxRateLimitBackoffMs: MAX_RATE_LIMIT_BACKOFF_MS,
      });
      this.options.setCachedProvider(provider);
      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        formatScopedLog(
          `[ContextServiceClient] Failed to initialize AI provider (${providerId}): ${message}`
        )
      );
      throw new Error(`AI provider initialization failed (${providerId}): ${message}`);
    }
  }

  isOfflineMode(): boolean {
    const flag = process.env.CONTEXT_ENGINE_OFFLINE_ONLY;
    if (!flag) {
      return false;
    }

    const normalized = flag.toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  async searchAndAsk(options: ServiceClientSearchAndAskOptions): Promise<string> {
    const metricsStart = Date.now();
    const providerId = this.getActiveAIProviderId();
    const priority: SearchAndAskPriority = options.priority === 'background' ? 'background' : 'interactive';
    const searchQueue = options.searchQueues[priority];

    if (this.isOfflineMode()) {
      throw new Error(
        'Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1) does not allow CE_AI_PROVIDER=openai_session. Disable offline mode to use openai_session.'
      );
    }

    publishSearchQueueDepthMetrics(options.searchQueues);
    incCounter('context_engine_search_and_ask_total', undefined, 1, 'Total searchAndAsk calls.');

    const defaultTimeoutMs = envMs('CE_AI_REQUEST_TIMEOUT_MS', DEFAULT_API_TIMEOUT_MS, {
      min: MIN_API_TIMEOUT_MS,
      max: MAX_API_TIMEOUT_MS,
    });
    const timeoutCandidate = options.timeoutMs ?? defaultTimeoutMs;
    const requestedTimeoutMs = Number.isFinite(timeoutCandidate) ? timeoutCandidate : defaultTimeoutMs;
    const timeoutMs = Math.max(MIN_API_TIMEOUT_MS, Math.min(MAX_API_TIMEOUT_MS, requestedTimeoutMs));
    const deadlineMs = Date.now() + timeoutMs;

    try {
      const admissionTimeoutError = this.getQueueTimeoutAdmissionError(options.searchQueues, timeoutMs, priority);
      if (admissionTimeoutError) {
        throw admissionTimeoutError;
      }

      const queuedAt = Date.now();
      const response = await searchQueue.enqueue(async () => {
        const queueWaitMs = Date.now() - queuedAt;
        observeDurationMs(
          SEARCH_AND_ASK_QUEUE_WAIT_METRIC,
          { lane: priority },
          queueWaitMs,
          { help: 'searchAndAsk queue wait duration in seconds.' }
        );

        const providerExecutionStart = Date.now();
        try {
          const queueLength = searchQueue.length;
          console.error(
            formatScopedLog(
              `[searchAndAsk] Provider=${providerId}; lane=${priority}; query=${options.searchQuery}${queueLength > 0 ? ` (queue: ${queueLength} waiting)` : ''}`
            )
          );

          const provider = this.getProvider();
          const innerResponse = await provider.call({
            searchQuery: options.searchQuery,
            prompt: options.prompt,
            timeoutMs,
            workspacePath: this.options.workspacePath,
            signal: options.signal,
            deadlineMs,
          });
          if (!innerResponse || typeof innerResponse !== 'object' || typeof innerResponse.text !== 'string') {
            throw new Error(
              `AI provider (${provider.id}) returned invalid response: expected object with string text property`
            );
          }
          console.error(formatScopedLog(`[searchAndAsk] Response length: ${innerResponse.text.length}`));
          return innerResponse.text;
        } catch (error) {
          console.error(formatScopedLog('[searchAndAsk] Failed:'), error);
          throw error;
        } finally {
          observeDurationMs(
            SEARCH_AND_ASK_EXECUTION_METRIC,
            { lane: priority },
            Date.now() - providerExecutionStart,
            { help: 'searchAndAsk provider execution duration in seconds.' }
          );
        }
      }, timeoutMs, options.signal);

      observeDurationMs(
        SEARCH_AND_ASK_TOTAL_DURATION_METRIC,
        { result: 'success' },
        Date.now() - metricsStart,
        { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
      );
      return response;
    } catch (error) {
      const failureResult = error instanceof SearchQueuePressureTimeoutError
        ? 'queue_timeout_budget'
        : isQueueFullError(error)
          ? 'queue_full'
          : 'error';

      if (failureResult === 'error') {
        incCounter('context_engine_search_and_ask_errors_total', undefined, 1, 'Total searchAndAsk failures.');
      } else {
        incCounter(
          'context_engine_search_and_ask_rejected_total',
          { reason: failureResult },
          1,
          'Total searchAndAsk calls rejected before execution.'
        );
      }
      observeDurationMs(
        SEARCH_AND_ASK_TOTAL_DURATION_METRIC,
        { result: failureResult },
        Date.now() - metricsStart,
        { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
      );
      throw error;
    } finally {
      publishSearchQueueDepthMetrics(options.searchQueues);
    }
  }

  private getQueueTimeoutAdmissionError(
    searchQueues: Record<SearchAndAskPriority, RuntimeSearchQueueLike>,
    timeoutMs: number,
    priority: SearchAndAskPriority
  ): SearchQueuePressureTimeoutError | null {
    const queueDepth = searchQueues[priority].depth;
    if (queueDepth < SEARCH_QUEUE_TIMEOUT_ADMISSION_DEPTH_THRESHOLD) {
      return null;
    }

    const estimatedQueueDelayMs = Math.max(0, queueDepth - 1) * SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS;
    const minimumBudgetMs = estimatedQueueDelayMs + SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS;
    if (timeoutMs >= minimumBudgetMs) {
      return null;
    }

    return new SearchQueuePressureTimeoutError(timeoutMs, queueDepth, minimumBudgetMs, priority);
  }
}
