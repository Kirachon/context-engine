import { createHash } from 'crypto';
import { incCounter, observeDurationMs } from '../metrics/metrics.js';
import { getRequestContext } from '../telemetry/requestContext.js';
import { runWithObservabilitySpan } from '../observability/otel.js';

type SearchAndAskPriority = 'interactive' | 'background';

export type OpenAITaskCacheStatus = 'miss' | 'deduped' | 'bypass';
export type OpenAITaskExecutionOutcome = 'success' | 'error';
export type OpenAITaskParseOutcome = 'not_requested' | 'success' | 'validation_failed';
export type OpenAITaskConsumerOutcome = 'usable' | 'degraded';

export interface OpenAITaskFailureMetadata {
  category: 'retryable_upstream' | 'non_retryable_upstream' | 'validation' | 'aborted';
  reason: string;
  retry_after_ms?: number;
}

export interface OpenAITaskResult<TParsed = unknown> {
  text: string;
  parsed?: TParsed;
  model: string;
  attempts: number;
  cache_status: OpenAITaskCacheStatus;
  latency_ms: number;
  parse_status: string;
  execution_outcome: OpenAITaskExecutionOutcome;
  parse_outcome: OpenAITaskParseOutcome;
  consumer_outcome: OpenAITaskConsumerOutcome;
  failure?: OpenAITaskFailureMetadata;
}

export class OpenAITaskRuntimeValidationError extends Error {
  constructor(
    message: string,
    public readonly parseStatus: string,
    public readonly rawText: string
  ) {
    super(message);
    this.name = 'OpenAITaskRuntimeValidationError';
  }
}

export interface RetryPolicy {
  maxAttempts: number;
}

export interface OpenAITaskRequest<TParsed = unknown> {
  taskName: string;
  promptVersion: string;
  searchQuery: string;
  prompt: string;
  timeoutMs: number;
  responseSchemaVersion: string;
  signal?: AbortSignal;
  priority?: SearchAndAskPriority;
  dedupeContext?: string;
  bypassDedupe?: boolean;
  allowValidationFailureResult?: boolean;
  degradedModeOnValidationFailure?: OpenAITaskConsumerOutcome;
  retryPolicy?: RetryPolicy;
  validateResponse?: (text: string) => { parsed: TParsed; parseStatus: string };
  prepareRetry?: (args: { attempt: number; error: Error; searchQuery: string; prompt: string }) => {
    searchQuery?: string;
    prompt?: string;
  };
  retryBackoffMs?: (args: { attempt: number; error: Error }) => number;
}

type SearchAndAskAdapter = {
  searchAndAsk: (
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number; priority?: SearchAndAskPriority; signal?: AbortSignal }
  ) => Promise<string>;
  getActiveAIModelLabel?: () => string;
  getActiveAIProviderId?: () => string;
};

type TaskErrorWithMetadata = Error & {
  openaiTaskRuntime?: {
    task_name: string;
    attempts: number;
    parse_status: string;
    execution_outcome: OpenAITaskExecutionOutcome;
    parse_outcome: OpenAITaskParseOutcome;
    consumer_outcome: OpenAITaskConsumerOutcome;
    failure: OpenAITaskFailureMetadata;
  };
};

const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2 };
const inFlightTasks = new Map<string, Promise<OpenAITaskResult<unknown>>>();

function normalizeForHash(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

function hashNormalized(value: string | undefined): string {
  return createHash('sha256').update(normalizeForHash(value)).digest('hex');
}

function buildTaskKey(request: OpenAITaskRequest<unknown>): string {
  return [
    request.taskName,
    request.promptVersion,
    hashNormalized(request.prompt),
    hashNormalized(request.dedupeContext),
    String(request.timeoutMs),
    request.responseSchemaVersion,
  ].join(':');
}

function extractRetryAfterMs(message: string): number | undefined {
  const exact = message.match(/retry_after_ms\s*=\s*(\d+)/i);
  if (exact) {
    const value = Number.parseInt(exact[1] ?? '', 10);
    return Number.isFinite(value) ? value : undefined;
  }

  const seconds = message.match(/retry after\s+(\d+)\s*s(?:ec(?:ond)?s?)?/i);
  if (seconds) {
    const value = Number.parseInt(seconds[1] ?? '', 10);
    return Number.isFinite(value) ? value * 1000 : undefined;
  }

  return undefined;
}

function classifyFailure(error: Error): OpenAITaskFailureMetadata {
  const message = error.message ?? String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('cancelled') || normalized.includes('aborted')) {
    return { category: 'aborted', reason: 'aborted' };
  }

  if (
    normalized.includes('timed out')
    || normalized.includes('timeout')
    || normalized.includes('search_queue_full')
    || normalized.includes('search_queue_pressure_timeout')
    || normalized.includes('rate limit')
    || normalized.includes('429')
    || normalized.includes('temporarily unavailable')
    || normalized.includes('econnreset')
    || normalized.includes('eai_again')
    || normalized.includes('socket hang up')
  ) {
    return {
      category: 'retryable_upstream',
      reason: 'retryable_upstream',
      retry_after_ms: extractRetryAfterMs(message),
    };
  }

  return { category: 'non_retryable_upstream', reason: 'non_retryable_upstream' };
}

function attachTaskMetadata(
  error: Error,
  taskName: string,
  attempts: number,
  parseStatus: string,
  executionOutcome: OpenAITaskExecutionOutcome,
  parseOutcome: OpenAITaskParseOutcome,
  consumerOutcome: OpenAITaskConsumerOutcome,
  failure: OpenAITaskFailureMetadata
): TaskErrorWithMetadata {
  const typedError = error as TaskErrorWithMetadata;
  Object.defineProperty(typedError, 'openaiTaskRuntime', {
    value: {
      task_name: taskName,
      attempts,
      parse_status: parseStatus,
      execution_outcome: executionOutcome,
      parse_outcome: parseOutcome,
      consumer_outcome: consumerOutcome,
      failure,
    },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return typedError;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('OpenAI task runtime aborted.'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function emitAttemptMetrics(args: {
  taskName: string;
  outcome: 'success' | 'error';
  cacheStatus: OpenAITaskCacheStatus;
  parseStatus: string;
  parseOutcome: OpenAITaskParseOutcome;
  consumerOutcome: OpenAITaskConsumerOutcome;
  latencyMs: number;
}): void {
  observeDurationMs(
    'context_engine_openai_task_runtime_duration_seconds',
    {
      task_name: args.taskName,
      outcome: args.outcome,
      cache_status: args.cacheStatus,
      parse_status: args.parseStatus,
      parse_outcome: args.parseOutcome,
      consumer_outcome: args.consumerOutcome,
    },
    args.latencyMs,
    { help: 'OpenAI task runtime end-to-end duration in seconds.' }
  );
}

export function getOpenAITaskRuntimeMetadata(error: unknown):
  | TaskErrorWithMetadata['openaiTaskRuntime']
  | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as TaskErrorWithMetadata).openaiTaskRuntime;
}

export function createOpenAITaskRuntime(adapter: SearchAndAskAdapter) {
  async function executeTask<TParsed>(request: OpenAITaskRequest<TParsed>): Promise<OpenAITaskResult<TParsed>> {
    const retryPolicy = request.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const maxAttempts = Math.max(1, Math.min(2, Math.floor(retryPolicy.maxAttempts || DEFAULT_RETRY_POLICY.maxAttempts)));
    const modelLabel = adapter.getActiveAIModelLabel?.() ?? adapter.getActiveAIProviderId?.() ?? 'unknown';
    const taskKey = buildTaskKey(request as OpenAITaskRequest<unknown>);

    const run = async (): Promise<OpenAITaskResult<TParsed>> => {
      const requestContext = getRequestContext();
      return await runWithObservabilitySpan(
        'openai.runtime.execute',
        {
          attributes: {
            'context_engine.request_id': requestContext?.requestId,
            'context_engine.transport': requestContext?.transport,
            'context_engine.backend': 'openai',
            'context_engine.operation': request.taskName,
          },
        },
        async (span) => {
          const startedAt = Date.now();
          let attempts = 0;
          let currentPrompt = request.prompt;
          let currentSearchQuery = request.searchQuery;
          let parseStatus = 'not_validated';
          let parseOutcome: OpenAITaskParseOutcome = 'not_requested';

          while (attempts < maxAttempts) {
            attempts += 1;
            span?.setAttribute('context_engine.retry_count', attempts - 1);
            try {
              const text = await adapter.searchAndAsk(currentSearchQuery, currentPrompt, {
                timeoutMs: request.timeoutMs,
                priority: request.priority,
                signal: request.signal,
              });

              let parsed: TParsed | undefined;
              if (request.validateResponse) {
                try {
                  const validated = request.validateResponse(text);
                  parsed = validated.parsed;
                  parseStatus = validated.parseStatus;
                  parseOutcome = 'success';
                } catch (error) {
                  if (error instanceof OpenAITaskRuntimeValidationError) {
                    parseStatus = error.parseStatus;
                    parseOutcome = 'validation_failed';
                    if (request.allowValidationFailureResult) {
                      const degradedConsumerOutcome = request.degradedModeOnValidationFailure ?? 'degraded';
                      const result: OpenAITaskResult<TParsed> = {
                        text,
                        model: modelLabel,
                        attempts,
                        cache_status: request.bypassDedupe ? 'bypass' : 'miss',
                        latency_ms: Date.now() - startedAt,
                        parse_status: parseStatus,
                        execution_outcome: 'success',
                        parse_outcome: parseOutcome,
                        consumer_outcome: degradedConsumerOutcome,
                        failure: {
                          category: 'validation',
                          reason: error.message,
                        },
                      };
                      span?.setAttribute('context_engine.execution_outcome', result.execution_outcome);
                      span?.setAttribute('context_engine.parse_outcome', result.parse_outcome);
                      span?.setAttribute('context_engine.consumer_outcome', result.consumer_outcome);
                      span?.setAttribute('context_engine.degraded', true);
                      emitAttemptMetrics({
                        taskName: request.taskName,
                        outcome: 'success',
                        cacheStatus: result.cache_status,
                        parseStatus,
                        parseOutcome,
                        consumerOutcome: result.consumer_outcome,
                        latencyMs: result.latency_ms,
                      });
                      return result;
                    }
                    throw error;
                  }
                  throw error;
                }
              } else {
                parseStatus = 'not_requested';
                parseOutcome = 'not_requested';
              }

              const result: OpenAITaskResult<TParsed> = {
                text,
                parsed,
                model: modelLabel,
                attempts,
                cache_status: request.bypassDedupe ? 'bypass' : 'miss',
                latency_ms: Date.now() - startedAt,
                parse_status: parseStatus,
                execution_outcome: 'success',
                parse_outcome: parseOutcome,
                consumer_outcome: 'usable',
              };
              span?.setAttribute('context_engine.execution_outcome', result.execution_outcome);
              span?.setAttribute('context_engine.parse_outcome', result.parse_outcome);
              span?.setAttribute('context_engine.consumer_outcome', result.consumer_outcome);
              span?.setAttribute('context_engine.outcome', 'success');
              incCounter(
                'context_engine_openai_task_runtime_total',
                { task_name: request.taskName, outcome: 'success' },
                1,
                'OpenAI task runtime task executions.'
              );
              emitAttemptMetrics({
                taskName: request.taskName,
                outcome: 'success',
                cacheStatus: result.cache_status,
                parseStatus,
                parseOutcome,
                consumerOutcome: result.consumer_outcome,
                latencyMs: result.latency_ms,
              });
              console.error(
                `[openai_task_runtime] task=${request.taskName} outcome=success attempts=${attempts} cache_status=${result.cache_status} parse_status=${parseStatus} latency_ms=${result.latency_ms}`
              );
              return result;
            } catch (error) {
              const typedError = error instanceof Error ? error : new Error(String(error));
              if (typedError instanceof OpenAITaskRuntimeValidationError) {
                parseStatus = typedError.parseStatus;
                const failure: OpenAITaskFailureMetadata = {
                  category: 'validation',
                  reason: typedError.message,
                };
                span?.setAttribute('context_engine.execution_outcome', 'error');
                span?.setAttribute('context_engine.parse_outcome', parseOutcome);
                span?.setAttribute('context_engine.consumer_outcome', 'degraded');
                span?.setAttribute('context_engine.outcome', 'error');
                incCounter(
                  'context_engine_openai_task_runtime_total',
                  { task_name: request.taskName, outcome: 'validation_error' },
                  1,
                  'OpenAI task runtime task executions.'
                );
                emitAttemptMetrics({
                  taskName: request.taskName,
                  outcome: 'error',
                  cacheStatus: request.bypassDedupe ? 'bypass' : 'miss',
                  parseStatus,
                  parseOutcome,
                  consumerOutcome: 'degraded',
                  latencyMs: Date.now() - startedAt,
                });
                throw attachTaskMetadata(
                  typedError,
                  request.taskName,
                  attempts,
                  parseStatus,
                  'error',
                  parseOutcome,
                  'degraded',
                  failure
                );
              }

              const failure = classifyFailure(typedError);
              const canRetry = failure.category === 'retryable_upstream' && attempts < maxAttempts;
              if (!canRetry) {
                span?.setAttribute('context_engine.execution_outcome', 'error');
                span?.setAttribute('context_engine.parse_outcome', parseOutcome);
                span?.setAttribute('context_engine.consumer_outcome', 'degraded');
                span?.setAttribute('context_engine.outcome', 'error');
                incCounter(
                  'context_engine_openai_task_runtime_total',
                  { task_name: request.taskName, outcome: 'error' },
                  1,
                  'OpenAI task runtime task executions.'
                );
                emitAttemptMetrics({
                  taskName: request.taskName,
                  outcome: 'error',
                  cacheStatus: request.bypassDedupe ? 'bypass' : 'miss',
                  parseStatus,
                  parseOutcome,
                  consumerOutcome: 'degraded',
                  latencyMs: Date.now() - startedAt,
                });
                throw attachTaskMetadata(
                  typedError,
                  request.taskName,
                  attempts,
                  parseStatus,
                  'error',
                  parseOutcome,
                  'degraded',
                  failure
                );
              }

              incCounter(
                'context_engine_openai_task_runtime_retry_total',
                { task_name: request.taskName, reason: failure.reason },
                1,
                'OpenAI task runtime retries.'
              );

              const retryUpdate = request.prepareRetry?.({
                attempt: attempts,
                error: typedError,
                searchQuery: currentSearchQuery,
                prompt: currentPrompt,
              });
              currentPrompt = retryUpdate?.prompt ?? currentPrompt;
              currentSearchQuery = retryUpdate?.searchQuery ?? currentSearchQuery;
              const requestedBackoffMs = request.retryBackoffMs?.({ attempt: attempts, error: typedError }) ?? 0;
              const backoffMs = Math.max(failure.retry_after_ms ?? 0, requestedBackoffMs);
              await sleepWithSignal(backoffMs, request.signal);
            }
          }

          throw new Error(`OpenAI task runtime exhausted attempts for ${request.taskName}.`);
        }
      );
    };

    if (request.bypassDedupe) {
      return executeWithoutDedupe(run);
    }

    const existing = inFlightTasks.get(taskKey);
    if (existing) {
      incCounter(
        'context_engine_openai_task_runtime_dedupe_total',
        { task_name: request.taskName },
        1,
        'OpenAI task runtime in-flight dedupe collapses.'
      );
      const deduped = await existing as OpenAITaskResult<TParsed>;
      return { ...deduped, cache_status: 'deduped' };
    }

    const inFlight = executeWithoutDedupe(run) as Promise<OpenAITaskResult<unknown>>;
    inFlightTasks.set(taskKey, inFlight);
    try {
      return await inFlight as OpenAITaskResult<TParsed>;
    } finally {
      if (inFlightTasks.get(taskKey) === inFlight) {
        inFlightTasks.delete(taskKey);
      }
    }
  }

  return { executeTask };
}

async function executeWithoutDedupe<T>(run: () => Promise<T>): Promise<T> {
  return run();
}
