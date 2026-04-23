import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const runWithObservabilitySpan = jest.fn();
const withObservabilitySpanContext = jest.fn();
const setActiveSpanAttributes = jest.fn();

jest.unstable_mockModule('../../../src/observability/otel.js', () => ({
  runWithObservabilitySpan,
  withObservabilitySpanContext,
  setActiveSpanAttributes,
}));

const { retrieve } = await import('../../../src/internal/retrieval/retrieve.js');
const { createRetrievalFlowContext } = await import('../../../src/internal/retrieval/flow.js');

describe('retrieve observability tracing', () => {
  const originalEnv = { ...process.env };
  const invokeAsyncSpan = async (
    fn: (span: unknown) => Promise<unknown> | unknown,
    span: unknown
  ): Promise<unknown> => await fn(span);
  const invokeSyncSpan = (
    fn: (span: unknown) => unknown,
    span: unknown
  ): unknown => fn(span);

  beforeAll(() => {
    runWithObservabilitySpan.mockImplementation(async (_name, _options, fn: unknown) => await invokeAsyncSpan(fn as (span: unknown) => Promise<unknown> | unknown, undefined));
    withObservabilitySpanContext.mockImplementation((_name, _options, fn: unknown) => invokeSyncSpan(fn as (span: unknown) => unknown, undefined));
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    runWithObservabilitySpan.mockClear();
    withObservabilitySpanContext.mockClear();
    setActiveSpanAttributes.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('emits additive pipeline, stage, and fanout span hooks for retrieval work', async () => {
    const observedSpanAttributes: Array<[string, string | number | boolean | undefined]> = [];
    const span = {
      setAttribute: jest.fn((name: string, value: string | number | boolean | undefined) => {
        observedSpanAttributes.push([name, value]);
      }),
    };
    runWithObservabilitySpan.mockImplementation(async (_name, _options, fn: unknown) => await invokeAsyncSpan(fn as (span: unknown) => Promise<unknown> | unknown, span));
    withObservabilitySpanContext.mockImplementation((_name, _options, fn: unknown) => invokeSyncSpan(fn as (span: unknown) => unknown, span));

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/auth/login.ts', content: 'login service', relevanceScore: 0.8, lines: '1-4' },
      ]),
      localKeywordSearch: jest.fn(async () => [
        { path: 'src/auth/login.ts', content: 'login service', relevanceScore: 0.9, lines: '1-4' },
      ]),
    } as any;
    const flow = createRetrievalFlowContext('login service');

    const results = await retrieve('login service', serviceClient, {
      enableExpansion: false,
      enableLexical: true,
      enableFusion: true,
      enableRerank: false,
      topK: 5,
      flow,
    });

    expect(results).toHaveLength(1);
    expect(runWithObservabilitySpan.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      'retrieval.pipeline',
      'retrieval.stage',
      'retrieval.fanout_backend',
    ]));
    expect(withObservabilitySpanContext.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      'retrieval.stage',
    ]));
    expect(setActiveSpanAttributes).toHaveBeenCalledWith(expect.objectContaining({
      'retrieval.expanded_query_count': 1,
    }));
    expect(setActiveSpanAttributes).toHaveBeenCalledWith(expect.objectContaining({
      'retrieval.semantic_candidate_count': 1,
      'retrieval.lexical_candidate_count': 1,
      'retrieval.dense_candidate_count': 0,
    }));
    expect(setActiveSpanAttributes).toHaveBeenCalledWith(expect.objectContaining({
      'retrieval.result_count': 1,
      'retrieval.effective_rerank_enabled': false,
    }));
    expect(observedSpanAttributes).toEqual(expect.arrayContaining([
      ['retrieval.result_count', 1],
    ]));
  });

  it('remains additive when observability hooks degrade to no-op callbacks', async () => {
    runWithObservabilitySpan.mockImplementation(async (_name, _options, fn: unknown) => await invokeAsyncSpan(fn as (span: unknown) => Promise<unknown> | unknown, undefined));
    withObservabilitySpanContext.mockImplementation((_name, _options, fn: unknown) => invokeSyncSpan(fn as (span: unknown) => unknown, undefined));

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/noop.ts', content: 'noop', relevanceScore: 0.9, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const results = await retrieve('noop', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: false,
      topK: 5,
    });

    expect(results.map((item) => item.path)).toEqual(['src/noop.ts']);
    expect(runWithObservabilitySpan).toHaveBeenCalled();
    expect(withObservabilitySpanContext).toHaveBeenCalled();
  });
});
