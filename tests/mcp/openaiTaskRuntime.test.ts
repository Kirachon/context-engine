import { describe, expect, it, jest } from '@jest/globals';
import {
  createOpenAITaskRuntime,
  getOpenAITaskRuntimeMetadata,
  OpenAITaskRuntimeValidationError,
} from '../../src/mcp/openaiTaskRuntime.js';

describe('OpenAITaskRuntime', () => {
  it('retries retryable upstream failures up to the frozen max-attempt budget', async () => {
    const searchAndAsk = jest.fn<(
      searchQuery: string,
      prompt?: string,
      options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
    ) => Promise<string>>();
    searchAndAsk.mockRejectedValueOnce(new Error('SEARCH_QUEUE_FULL: queue saturated retry_after_ms=1'));
    searchAndAsk.mockResolvedValueOnce('<enhanced-prompt>ok</enhanced-prompt>');
    const runtime = createOpenAITaskRuntime({
      searchAndAsk,
      getActiveAIModelLabel: () => 'test-model',
    });

    const result = await runtime.executeTask<string>({
      taskName: 'enhance_prompt',
      promptVersion: 'enhance.v1',
      searchQuery: 'tighten auth',
      prompt: '<prompt>tighten auth</prompt>',
      timeoutMs: 5_000,
      responseSchemaVersion: 'response.v1',
      validateResponse: (text) => ({ parsed: text, parseStatus: 'parsed' }),
    });

    expect(searchAndAsk).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.model).toBe('test-model');
    expect(result.parse_status).toBe('parsed');
    expect(result.execution_outcome).toBe('success');
    expect(result.parse_outcome).toBe('success');
    expect(result.consumer_outcome).toBe('usable');
  });

  it('does not retry non-retryable failures and preserves task metadata', async () => {
    const searchAndAsk = jest.fn<(
      searchQuery: string,
      prompt?: string,
      options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
    ) => Promise<string>>();
    searchAndAsk.mockRejectedValue(new Error('authentication required'));
    const runtime = createOpenAITaskRuntime({
      searchAndAsk,
      getActiveAIModelLabel: () => 'test-model',
    });

    const failure = runtime.executeTask<string>({
      taskName: 'enhance_prompt',
      promptVersion: 'enhance.v1',
      searchQuery: 'tighten auth',
      prompt: '<prompt>tighten auth</prompt>',
      timeoutMs: 5_000,
      responseSchemaVersion: 'response.v1',
      validateResponse: (text) => ({ parsed: text, parseStatus: 'parsed' }),
    });

    await expect(failure).rejects.toThrow('authentication required');
    const metadata = getOpenAITaskRuntimeMetadata(await failure.catch((error) => error));
    expect(metadata).toMatchObject({
      task_name: 'enhance_prompt',
      attempts: 1,
      execution_outcome: 'error',
      consumer_outcome: 'degraded',
      failure: {
        category: 'non_retryable_upstream',
      },
    });
  });

  it('collapses identical in-flight work but isolates dedupe across task families', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const searchAndAsk = jest.fn<(
      searchQuery: string,
      prompt?: string,
      options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
    ) => Promise<string>>(async () => {
      await gate;
      return '{"findings":[]}';
    });
    const runtime = createOpenAITaskRuntime({
      searchAndAsk,
      getActiveAIModelLabel: () => 'test-model',
    });

    const sharedRequest = {
      promptVersion: 'review.v1',
      searchQuery: 'Enterprise code review (structural)',
      prompt: 'review this diff',
      timeoutMs: 10_000,
      responseSchemaVersion: 'enterprise_review.findings.v1',
      validateResponse: (text: string) => ({ parsed: text, parseStatus: 'json_extracted' }),
    };

    const first = runtime.executeTask<string>({
      taskName: 'review_diff_llm_synthesis',
      ...sharedRequest,
    });
    const second = runtime.executeTask<string>({
      taskName: 'review_diff_llm_synthesis',
      ...sharedRequest,
    });
    const isolated = runtime.executeTask<string>({
      taskName: 'enhance_prompt',
      ...sharedRequest,
    });
    release?.();

    const [firstResult, secondResult, isolatedResult] = await Promise.all([first, second, isolated]);
    expect(searchAndAsk).toHaveBeenCalledTimes(2);
    expect(firstResult.cache_status).toBe('miss');
    expect(secondResult.cache_status).toBe('deduped');
    expect(isolatedResult.cache_status).toBe('miss');
  });

  it('returns a soft validation failure result when requested', async () => {
    const searchAndAsk = jest.fn<(
      searchQuery: string,
      prompt?: string,
      options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
    ) => Promise<string>>();
    searchAndAsk.mockResolvedValue('not json');
    const runtime = createOpenAITaskRuntime({
      searchAndAsk,
      getActiveAIModelLabel: () => 'test-model',
    });

    const result = await runtime.executeTask<string>({
      taskName: 'review_diff_llm_synthesis',
      promptVersion: 'review.v1',
      searchQuery: 'Enterprise code review (structural)',
      prompt: 'review this diff',
      timeoutMs: 10_000,
      responseSchemaVersion: 'enterprise_review.findings.v1',
      allowValidationFailureResult: true,
      validateResponse: (text) => {
        throw new OpenAITaskRuntimeValidationError('missing json', 'json_missing', text);
      },
    });

    expect(result.failure).toMatchObject({
      category: 'validation',
      reason: 'missing json',
    });
    expect(result.parse_status).toBe('json_missing');
    expect(result.execution_outcome).toBe('success');
    expect(result.parse_outcome).toBe('validation_failed');
    expect(result.consumer_outcome).toBe('degraded');
    expect(result.attempts).toBe(1);
  });

  it('honors policy-owned degraded validation outcome when provided by the caller', async () => {
    const searchAndAsk = jest.fn<(
      searchQuery: string,
      prompt?: string,
      options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
    ) => Promise<string>>();
    searchAndAsk.mockResolvedValue('not json');
    const runtime = createOpenAITaskRuntime({
      searchAndAsk,
      getActiveAIModelLabel: () => 'test-model',
    });

    const result = await runtime.executeTask<string>({
      taskName: 'review_diff_llm_synthesis',
      promptVersion: 'review.v1',
      searchQuery: 'Enterprise code review (structural)',
      prompt: 'review this diff',
      timeoutMs: 10_000,
      responseSchemaVersion: 'enterprise_review.findings.v1',
      allowValidationFailureResult: true,
      degradedModeOnValidationFailure: 'degraded',
      validateResponse: (text) => {
        throw new OpenAITaskRuntimeValidationError('missing json', 'json_missing', text);
      },
    });

    expect(result.consumer_outcome).toBe('degraded');
  });
});
