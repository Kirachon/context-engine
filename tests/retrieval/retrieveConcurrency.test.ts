import { expandQuery } from '../../src/internal/retrieval/expandQuery.js';
import { createRetrievalFlowContext } from '../../src/internal/retrieval/flow.js';
import { retrieve } from '../../src/internal/retrieval/retrieve.js';
import { FEATURE_FLAGS } from '../../src/config/features.js';
import { renderPrometheusMetrics } from '../../src/metrics/metrics.js';

async function flushFanoutScheduling(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('retrieve fanout concurrency guardrails', () => {
  const originalEnv = { ...process.env };
  const originalMetrics = FEATURE_FLAGS.metrics;

  afterEach(() => {
    process.env = { ...originalEnv };
    FEATURE_FLAGS.metrics = originalMetrics;
  });

  it('respects the env-configured fanout cap and records limiter diagnostics', async () => {
    FEATURE_FLAGS.metrics = true;
    process.env.CE_RETRIEVAL_FANOUT_CONCURRENCY = '2';

    let inFlight = 0;
    let maxInFlight = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const startSearch = async (source: string, query: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return [{ path: `${source}:${query}`, content: source, relevanceScore: 0.5, lines: '1-1' }];
    };

    const serviceClient = {
      semanticSearch: jest.fn((query: string) => startSearch('semantic', query)),
      localKeywordSearch: jest.fn((query: string) => startSearch('lexical', query)),
    } as any;
    const denseProvider = {
      id: 'dense:test',
      search: jest.fn((query: string) => startSearch('dense', query)),
    };
    const flow = createRetrievalFlowContext('auth login service flow');

    const pending = retrieve('auth login service flow', serviceClient, {
      enableExpansion: true,
      rewriteMode: 'v2',
      profile: 'rich',
      maxVariants: 4,
      enableLexical: true,
      enableDense: true,
      denseProvider,
      enableFusion: false,
      enableRerank: false,
      topK: 20,
      flow,
    });

    await flushFanoutScheduling();

    expect(maxInFlight).toBe(2);
    expect(flow.metadata).toMatchObject({
      fanoutConcurrencyCap: 2,
      fanoutVariantCount: 4,
      fanoutBackendCount: 3,
      fanoutPlannedTasks: 12,
      fanoutObservedMaxInFlight: 2,
    });
    expect(Number(flow.metadata.fanoutQueuedTasks)).toBeGreaterThan(0);
    expect(Number(flow.metadata.fanoutObservedMaxQueued)).toBeGreaterThan(0);

    releaseGate();
    const results = await pending;

    expect(results).toHaveLength(12);
    expect(flow.metadata).toMatchObject({
      stageDurationsMs: expect.objectContaining({
        expand_queries: expect.any(Number),
        fanout: expect.any(Number),
        collect_candidates: expect.any(Number),
      }),
    });
    expect(flow.stages).toEqual(expect.arrayContaining([
      'fanout:cap:2',
      'fanout:planned:12',
      'fanout:queued',
      'fanout:max_in_flight:2',
    ]));

    const metricsText = renderPrometheusMetrics();
    expect(metricsText).toMatch(/context_engine_retrieval_stage_duration_seconds_bucket\{[^}]*stage="fanout"[^}]*\}\s+\d+/);
    expect(metricsText).toMatch(/context_engine_retrieval_fanout_queue_wait_seconds_bucket\{[^}]*backend="semantic"[^}]*\}\s+\d+/);
    expect(metricsText).toMatch(/context_engine_retrieval_fanout_execution_seconds_bucket\{[^}]*backend="semantic"[^}]*\}\s+\d+/);
    expect(metricsText).toContain('context_engine_retrieval_fanout_observed_max_queue_depth');
    expect(metricsText).toContain('context_engine_retrieval_fanout_concurrency_limit');
  });

  it('keeps result ordering stable across different fanout caps', async () => {
    const query = 'auth login service flow';
    const variants = expandQuery(query, 4, { mode: 'v2', profile: 'rich' });
    const delayByVariant = new Map(variants.map((variant) => [variant.query, (variants.length - variant.index) * 5]));

    const createClient = (offset: number) => {
      const delayFor = async (value: string) => {
        await new Promise((resolve) => setTimeout(resolve, (delayByVariant.get(value) ?? 0) + offset));
      };

      const serviceClient = {
        semanticSearch: jest.fn(async (value: string) => {
          await delayFor(value);
          return [{ path: `semantic:${value}`, content: 'semantic', relevanceScore: 0.8, lines: '1-1' }];
        }),
        localKeywordSearch: jest.fn(async (value: string) => {
          await delayFor(value);
          return [{ path: `lexical:${value}`, content: 'lexical', relevanceScore: 0.7, lines: '1-1' }];
        }),
      } as any;
      const denseProvider = {
        id: `dense:${offset}`,
        search: jest.fn(async (value: string) => {
          await delayFor(value);
          return [{ path: `dense:${value}`, content: 'dense', relevanceScore: 0.6, lines: '1-1' }];
        }),
      };

      return { serviceClient, denseProvider };
    };

    const baseOptions = {
      enableExpansion: true,
      rewriteMode: 'v2' as const,
      profile: 'rich' as const,
      maxVariants: 4,
      enableLexical: true,
      enableDense: true,
      enableFusion: false,
      enableRerank: false,
      enableDedupe: false,
      topK: 20,
    };

    const serialRun = createClient(2);
    const serial = await retrieve(query, serialRun.serviceClient, {
      ...baseOptions,
      denseProvider: serialRun.denseProvider,
      fanoutConcurrency: 1,
    });

    const parallelRun = createClient(0);
    const parallel = await retrieve(query, parallelRun.serviceClient, {
      ...baseOptions,
      denseProvider: parallelRun.denseProvider,
      fanoutConcurrency: 12,
    });

    const expectedOrder = [
      ...variants.map((variant) => `semantic:${variant.query}`),
      ...variants.map((variant) => `lexical:${variant.query}`),
      ...variants.map((variant) => `dense:${variant.query}`),
    ];

    expect(serial.map((item) => item.path)).toEqual(expectedOrder);
    expect(parallel.map((item) => item.path)).toEqual(expectedOrder);
  });
});
