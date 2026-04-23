import { retrieve } from '../../../src/internal/retrieval/retrieve.js';
import { internalRetrieveCode } from '../../../src/internal/handlers/retrieval.js';
import { setInternalCache } from '../../../src/internal/handlers/performance.js';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import { clearExpandQueryCacheForTests } from '../../../src/internal/retrieval/expandQuery.js';
import { createRetrievalFlowContext } from '../../../src/internal/retrieval/flow.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHashEmbeddingRuntime } from '../../../src/internal/retrieval/embeddingRuntime.js';
import { createWorkspaceLanceDbVectorRetriever } from '../../../src/internal/retrieval/lancedbVectorIndex.js';
import { createWorkspacePersistentGraphStore } from '../../../src/internal/graph/persistentGraphStore.js';

describe('retrieve internal pipeline', () => {
  const originalEnv = { ...process.env };
  const originalQualityGuard = FEATURE_FLAGS.retrieval_quality_guard_v1;
  const originalLanceDbFlag = FEATURE_FLAGS.retrieval_lancedb_v1;

  afterEach(() => {
    process.env = { ...originalEnv };
    FEATURE_FLAGS.retrieval_quality_guard_v1 = originalQualityGuard;
    FEATURE_FLAGS.retrieval_lancedb_v1 = originalLanceDbFlag;
    clearExpandQueryCacheForTests();
    setInternalCache(undefined);
  });

  it('preserves semantic-only behavior when lexical/fusion are off', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/semantic.ts', content: 'semantic', relevanceScore: 0.9, lines: '1-4' },
      ]),
      localKeywordSearch: jest.fn(async () => [
        { path: 'src/lexical.ts', content: 'lexical', relevanceScore: 0.9, lines: '1-4' },
      ]),
    } as any;

    const results = await retrieve('semantic query', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      topK: 5,
    });

    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(serviceClient.localKeywordSearch).toHaveBeenCalledTimes(0);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('src/semantic.ts');
  });

  it('includes lexical results and fuses candidates when enabled', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/auth/login.ts', content: 'login service', relevanceScore: 0.7, lines: '10-20' },
      ]),
      localKeywordSearch: jest.fn(async () => [
        { path: 'src/auth/login.ts', content: 'login service', relevanceScore: 0.9, lines: '10-20' },
      ]),
    } as any;

    const results = await retrieve('login service', serviceClient, {
      enableExpansion: false,
      enableLexical: true,
      enableFusion: true,
      topK: 5,
    });

    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(serviceClient.localKeywordSearch).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect((results[0] as any).retrievalSource).toBe('hybrid');
    expect((results[0] as any).combinedScore).toBeGreaterThan(0);
  });

  it('supports optional dense candidates behind enableDense flag', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/query.ts', content: 'semantic hit', relevanceScore: 0.4, lines: '5-9' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const denseProvider = {
      id: 'dense:test',
      search: jest.fn(async () => [
        { path: 'src/query.ts', content: 'semantic hit', relevanceScore: 0.95, lines: '5-9' },
      ]),
    };

    const results = await retrieve('query', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableDense: true,
      denseProvider,
      enableFusion: true,
      semanticWeight: 0.2,
      denseWeight: 0.8,
      topK: 5,
    });

    expect(denseProvider.search).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect((results[0] as any).retrievalSource).toBe('hybrid');
    expect((results[0] as any).denseScore).toBeGreaterThan(0);
  });

  it('leans lexical in fusion for identifier-like queries so source files outrank nearby tests', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        {
          path: 'tests/ci/generateRetrievalQualityReport.test.ts',
          content: 'test hit',
          relevanceScore: 0.95,
          lines: '1-2',
        },
      ]),
      localKeywordSearch: jest.fn(async () => [
        {
          path: 'tests/ci/generateRetrievalQualityReport.test.ts',
          content: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
          relevanceScore: 0.95,
          lines: '1-2',
        },
        {
          path: 'scripts/ci/generate-retrieval-quality-report.ts',
          content: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
          relevanceScore: 0.8,
          lines: '1-2',
        },
      ]),
    } as any;

    const results = await retrieve(
      'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
      serviceClient,
      {
        enableExpansion: false,
        enableLexical: true,
        enableFusion: true,
        topK: 5,
      }
    );

    expect(results[0].path).toBe('scripts/ci/generate-retrieval-quality-report.ts');
  });

  it('uses default workspace dense retriever when enableDense is true and no provider is supplied', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieve-dense-default-'));
    const sampleFile = path.join(tmp, 'src', 'dense.ts');
    fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
    fs.writeFileSync(sampleFile, 'export const dense = "vector retrieval";', 'utf8');
    fs.writeFileSync(path.join(tmp, '.context-engine-index-state.json'), JSON.stringify({
      files: {
        'src/dense.ts': { hash: 'hdense1', indexed_at: new Date().toISOString() },
      },
    }), 'utf8');

    const serviceClient = {
      workspacePath: tmp,
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const results = await retrieve('vector retrieval', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableDense: true,
      enableFusion: true,
      denseWeight: 1,
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as any).retrievalSource).toBe('dense');
    expect(fs.existsSync(path.join(tmp, '.context-engine-dense-index.json'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses LanceDB vector retriever when enableDense is true and the LanceDB flag is enabled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieve-lancedb-default-'));
    const sampleFile = path.join(tmp, 'src', 'vector.ts');
    const secondaryFile = path.join(tmp, 'src', 'schema.ts');
    fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
    fs.writeFileSync(sampleFile, 'export const vector = "vector retrieval";', 'utf8');
    fs.writeFileSync(secondaryFile, 'export const schema = "database schema";', 'utf8');
    fs.writeFileSync(path.join(tmp, '.context-engine-index-state.json'), JSON.stringify({
      files: {
        'src/vector.ts': { hash: 'hvector1', indexed_at: new Date().toISOString() },
        'src/schema.ts': { hash: 'hschema1', indexed_at: new Date().toISOString() },
      },
    }), 'utf8');

    FEATURE_FLAGS.retrieval_lancedb_v1 = true;

    const serviceClient = {
      workspacePath: tmp,
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;
    const denseProvider = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    const results = await retrieve('vector retrieval', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableDense: true,
      enableFusion: true,
      denseWeight: 1,
      denseProvider,
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as any).retrievalSource).toBe('dense');
    expect(fs.existsSync(path.join(tmp, '.context-engine-lancedb-index.json'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses rerankTopN and preserves tail ordering', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/a.ts', content: 'a', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/b.ts', content: 'b', relevanceScore: 0.8, lines: '1-2' },
        { path: 'src/c.ts', content: 'c', relevanceScore: 0.7, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const reranker = {
      id: 'mock-reranker',
      rerank: jest.fn(async (_query: string, candidates: any[]) => [candidates[1], candidates[0]]),
    };

    const results = await retrieve('abc', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker,
      rerankTopN: 2,
      topK: 5,
    });

    expect(reranker.rerank).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item.path)).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
  });

  it('clears timeout timers after a fast retrieval resolves', async () => {
    jest.useFakeTimers();
    try {
      const serviceClient = {
        semanticSearch: jest.fn(async () => [
          { path: 'src/fast.ts', content: 'fast', relevanceScore: 0.9, lines: '1-2' },
        ]),
        localKeywordSearch: jest.fn(async () => []),
      } as any;

      const results = await retrieve('fast query', serviceClient, {
        enableExpansion: false,
        enableLexical: false,
        enableFusion: false,
        timeoutMs: 50,
        topK: 5,
      });

      expect(results).toHaveLength(1);
      expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs expanded variants in parallel to reduce end-to-end latency', async () => {
    const deferred: Array<{ resolve: (value: any[]) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const serviceClient = {
      semanticSearch: jest.fn(() => new Promise<any[]>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        deferred.push({
          resolve: (value: any[]) => {
            inFlight -= 1;
            resolve(value);
          },
        });
      })),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const pending = retrieve('auth login service flow', serviceClient, {
      enableExpansion: true,
      enableLexical: false,
      enableFusion: false,
      enableRerank: false,
      profile: 'rich',
      rewriteMode: 'v2',
      maxVariants: 4,
      topK: 5,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(maxInFlight).toBeGreaterThan(1);

    for (const item of deferred) {
      item.resolve([]);
    }

    const results = await pending;
    expect(results).toEqual([]);
    expect(serviceClient.semanticSearch.mock.calls.length).toBeGreaterThan(1);
  });

  it('applies conservative memory-pressure guardrails before expensive fanout work', async () => {
    process.env.CE_MEMORY_PRESSURE_HEAP_CRITICAL_RATIO = '0';

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/pressure.ts', content: 'pressure', relevanceScore: 0.9, lines: '1-1' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;
    const reranker = {
      id: 'guarded-reranker',
      rerank: jest.fn(async (_query: string, candidates: any[]) => candidates),
    };
    const flow = createRetrievalFlowContext('auth login service flow');

    const results = await retrieve('auth login service flow', serviceClient, {
      enableExpansion: true,
      rewriteMode: 'v2',
      profile: 'rich',
      maxVariants: 4,
      fanoutConcurrency: 8,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker,
      topK: 5,
      flow,
    });

    expect(results).toHaveLength(1);
    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(flow.metadata).toMatchObject({
      memoryPressureLevel: 'critical',
      requestedFanoutConcurrency: 8,
      effectiveFanoutConcurrency: 1,
      requestedMaxVariants: 4,
      effectiveMaxVariants: 1,
      requestedRerankEnabled: true,
      effectiveRerankEnabled: false,
      memoryPressureGuardrails: {
        fanoutConcurrencyCap: 1,
        maxVariantsCap: 1,
        disableRerank: true,
      },
    });
    expect(flow.stages).toEqual(expect.arrayContaining([
      'memory_pressure:preflight:critical',
      'memory_guardrail:preflight:fanout_concurrency_cap:1',
      'memory_guardrail:preflight:max_variants_cap:1',
      'memory_guardrail:preflight:rerank_disabled',
    ]));
  });

  it('skips rerank when the rerank budget is already exhausted and preserves the current retrieval floor', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;
    const denseProvider = {
      id: 'dense:test',
      search: jest.fn(async () => [
        { path: 'src/dense-a.ts', content: 'dense a', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/dense-b.ts', content: 'dense b', relevanceScore: 0.8, lines: '1-2' },
      ]),
    };
    const reranker = {
      id: 'budgeted-reranker',
      rerank: jest.fn(async (_query: string, candidates: any[]) => [candidates[1], candidates[0]]),
    };
    const flow = createRetrievalFlowContext('dense budget query');
    flow.startedAtMs = Date.now() - 25;

    const results = await retrieve('dense budget query', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableDense: true,
      denseProvider,
      enableFusion: false,
      enableRerank: true,
      reranker,
      rerankBudgetMs: 10,
      rerankTimeoutMs: 100,
      topK: 5,
      flow,
    });

    expect(denseProvider.search).toHaveBeenCalledTimes(1);
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(results.map((item) => item.path)).toEqual(['src/dense-a.ts', 'src/dense-b.ts']);
    expect((results[0] as any).retrievalSource).toBe('dense');
    expect(flow.metadata).toMatchObject({
      degradationFloor: 'dense_retrieval',
      effectiveRerankEnabled: false,
      rerankBudgetExhausted: true,
      rerankBudgetMs: 10,
    });
    expect(flow.metadata.budgetGuardrails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'rerank',
        reason: 'skip',
        budgetMs: 10,
      }),
    ]));
    expect(flow.stages).toEqual(expect.arrayContaining([
      'budget_guardrail:rerank:skip',
      'rerank:skipped:budget',
    ]));
  });

  it('caps rerank timeout to the remaining rerank budget headroom', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/a.ts', content: 'a', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/b.ts', content: 'b', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;
    const reranker = {
      id: 'slow-budgeted-reranker',
      rerank: jest.fn(async (_query: string, candidates: any[]) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [candidates[1], candidates[0]];
      }),
    };
    const flow = createRetrievalFlowContext('budget headroom query');
    flow.startedAtMs = Date.now() - 45;

    const results = await retrieve('budget headroom query', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker,
      rerankBudgetMs: 50,
      rerankTimeoutMs: 100,
      topK: 5,
      flow,
    });

    expect(reranker.rerank).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(flow.metadata).toMatchObject({
      effectiveRerankTimeoutMs: expect.any(Number),
      rerankBudgetTimeoutCapped: true,
    });
    expect(Number(flow.metadata.effectiveRerankTimeoutMs)).toBeLessThan(100);
    expect(flow.metadata.budgetGuardrails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'rerank',
        reason: 'timeout_cap',
        budgetMs: 50,
      }),
    ]));
    expect(flow.stages).toEqual(expect.arrayContaining([
      'budget_guardrail:rerank:timeout_cap',
      'rerank:fail_open',
    ]));
  });

  it('fails open when reranker throws', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/x.ts', content: 'x', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/y.ts', content: 'y', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const reranker = {
      id: 'failing-reranker',
      rerank: jest.fn(async () => {
        throw new Error('boom');
      }),
    };

    const results = await retrieve('xy', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker,
      rerankTopN: 2,
      topK: 5,
    });

    expect(results.map((item) => item.path)).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('fails open when reranker times out', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/t1.ts', content: 't1', relevanceScore: 0.9, lines: '1-2' },
        { path: 'src/t2.ts', content: 't2', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const reranker = {
      id: 'slow-reranker',
      rerank: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [];
      }),
    };

    const results = await retrieve('tt', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      reranker,
      rerankTopN: 2,
      rerankTimeoutMs: 5,
      topK: 5,
    });

    expect(results.map((item) => item.path)).toEqual(['src/t1.ts', 'src/t2.ts']);
  });

  it('supports rankingMode=v2 deterministic prioritization for exact symbol matches', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/auth/loginHelper.ts', content: 'export function helper() {}', relevanceScore: 0.8, lines: '1-2' },
        { path: 'src/auth/loginService.ts', content: 'export function loginService() {}', relevanceScore: 0.8, lines: '1-2' },
        { path: 'src/auth/auth.ts', content: 'export function auth() {}', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const results = await retrieve('loginService', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      rankingMode: 'v2' as any,
      topK: 5,
    });

    expect(results[0]?.path).toContain('loginService.ts');
    expect(results.map((item) => item.path).length).toBe(3);
  });

  it('supports rankingMode=v3 with stronger path-tail prioritization', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/core/auth/loginService.ts', content: 'export function loginService() {}', relevanceScore: 0.8, lines: '1-2' },
        { path: 'src/core/auth/login.ts', content: 'export function login() {}', relevanceScore: 0.8, lines: '200-210' },
        { path: 'src/core/auth/helpers.ts', content: 'export function helper() {}', relevanceScore: 0.8, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const results = await retrieve('loginService', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      rankingMode: 'v3' as any,
      topK: 5,
    });

    expect(results[0]?.path).toContain('loginService.ts');
    expect(results.map((item) => item.path).length).toBe(3);
  });

  it('records skipped rerank gate diagnostics for easy fast-profile queries', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/clear.ts', content: 'clear', relevanceScore: 0.95, lines: '1-2', retrievalSource: 'semantic' },
        { path: 'src/medium.ts', content: 'medium', relevanceScore: 0.45, lines: '1-2', retrievalSource: 'semantic' },
        { path: 'src/low.ts', content: 'low', relevanceScore: 0.25, lines: '1-2', retrievalSource: 'semantic' },
        { path: 'src/lower.ts', content: 'lower', relevanceScore: 0.1, lines: '1-2', retrievalSource: 'semantic' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const response = await internalRetrieveCode('clear ranking', serviceClient, {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      rankingMode: 'v3' as any,
      profile: 'fast',
      topK: 5,
    });

    expect(response.rankingDiagnostics).toMatchObject({
      rankingMode: 'v3',
      rerankGateState: 'skipped',
      fallbackReason: 'none',
    });
    expect(response.flow?.metadata).toMatchObject({
      rankingDiagnostics: response.rankingDiagnostics,
    });
  });

  it('keeps rewrite v2 guardrails for code-like queries and profile-aware variant caps', async () => {
    const codeLikeClient = {
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    await retrieve('src/auth/loginService.ts', codeLikeClient, {
      enableExpansion: true,
      enableLexical: false,
      enableFusion: false,
      rewriteMode: 'v2',
      profile: 'rich',
      topK: 5,
    });

    expect(codeLikeClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(codeLikeClient.semanticSearch).toHaveBeenNthCalledWith(1, 'src/auth/loginService.ts', 5);

    const fastProfileClient = {
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;
    const richProfileClient = {
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const query = 'auth login service flow';
    await retrieve(query, fastProfileClient, {
      enableExpansion: true,
      enableLexical: false,
      enableFusion: false,
      rewriteMode: 'v2',
      profile: 'fast',
      topK: 5,
      maxVariants: 6,
    });
    await retrieve(query, richProfileClient, {
      enableExpansion: true,
      enableLexical: false,
      enableFusion: false,
      rewriteMode: 'v2',
      profile: 'rich',
      topK: 5,
      maxVariants: 6,
    });

    expect(fastProfileClient.semanticSearch).toHaveBeenCalledTimes(2);
    expect(richProfileClient.semanticSearch.mock.calls.length).toBeGreaterThan(2);
  });

  it('prioritizes the source script over nearby test files for identifier-like file queries', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        {
          path: 'tests/ci/lunarRankingOrchestrator.test.ts',
          content: 'assert checksum_guard drift_token',
          relevanceScore: 0.92,
          lines: '1-40',
        },
        {
          path: 'scripts/ci/lunar-ranking-orchestrator.ts',
          content: 'export function runOrchestrator() { return "checksum_guard drift_token"; }',
          relevanceScore: 0.86,
          lines: '1-40',
        },
      ]),
      localKeywordSearch: jest.fn(async () => [
        {
          path: 'tests/ci/lunarRankingOrchestrator.test.ts',
          content: 'assert checksum_guard drift_token',
          relevanceScore: 0.95,
          lines: '1-40',
        },
        {
          path: 'scripts/ci/lunar-ranking-orchestrator.ts',
          content: 'export function runOrchestrator() { return "checksum_guard drift_token"; }',
          relevanceScore: 0.88,
          lines: '1-40',
        },
      ]),
    } as any;

    const results = await retrieve(
      'lunar-ranking-orchestrator checksum_guard drift_token',
      serviceClient,
      {
        enableExpansion: true,
        enableLexical: true,
        enableFusion: true,
        enableRerank: true,
        rewriteMode: 'v2',
        rankingMode: 'v3' as any,
        profile: 'rich',
        topK: 5,
      }
    );

    expect(results[0]?.path).toBe('scripts/ci/lunar-ranking-orchestrator.ts');
    expect(serviceClient.semanticSearch.mock.calls.map((call: [string]) => call[0])).toEqual(
      expect.arrayContaining([
        'lunar-ranking-orchestrator',
        'lunar ranking orchestrator checksum guard drift token',
      ])
    );
  });

  it('keeps rankingMode=v2 ordering deterministic across identical runs', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/zeta.ts', content: 'export const zetaToken = 1;', relevanceScore: 0.8, lines: '1-1' },
        { path: 'src/alpha.ts', content: 'export const alpha = 1;', relevanceScore: 0.8, lines: '1-1' },
        { path: 'src/beta.ts', content: 'export const beta = 1;', relevanceScore: 0.8, lines: '1-1' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const options = {
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      rankingMode: 'v2' as any,
      topK: 5,
    };

    const runA = await retrieve('zeta token', serviceClient, options);
    const runB = await retrieve('zeta token', serviceClient, options);

    expect(runA.map((item) => item.path)).toEqual(runB.map((item) => item.path));
  });

  it('memoizes with stable v2 cache keys across option ordering', async () => {
    const backing = new Map<string, unknown>();
    const cache = {
      get: jest.fn((key: string) => backing.get(key)),
      set: jest.fn((key: string, value: unknown) => backing.set(key, value)),
    };
    setInternalCache(cache as any);

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/memo.ts', content: 'memo', relevanceScore: 0.9, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const first = await internalRetrieveCode(
      'memo query',
      serviceClient,
      { topK: 3, enableExpansion: false, rewriteMode: 'v2' as any } as any
    );
    const second = await internalRetrieveCode(
      'memo query',
      serviceClient,
      { rewriteMode: 'v2' as any, enableExpansion: false, topK: 3 } as any
    );

    expect(first.results.map((r) => r.path)).toEqual(second.results.map((r) => r.path));
    expect(first.flow?.stages).toContain('handler:complete');
    expect(first.flow?.metadata).toMatchObject({
      cacheHit: false,
      qualityGuardEnabled: false,
    });
    expect(second.flow?.stages).toContain('cache_hit');
    expect(second.flow?.metadata).toMatchObject({
      cacheHit: true,
      cacheKeyVersion: 'v2',
    });
    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalled();
    const firstSetKey = String((cache.set as jest.Mock).mock.calls[0]?.[0] ?? '');
    expect(firstSetKey).toContain('retrieve:v2:');
  });

  it('skips internal memoization when bypassCache=true for request safety', async () => {
    const backing = new Map<string, unknown>();
    const cache = {
      get: jest.fn((key: string) => backing.get(key)),
      set: jest.fn((key: string, value: unknown) => backing.set(key, value)),
    };
    setInternalCache(cache as any);

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/no-cache.ts', content: 'fresh', relevanceScore: 0.9, lines: '1-2' },
      ]),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    const request = {
      bypassCache: true,
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
    } as any;
    await internalRetrieveCode('fresh query', serviceClient, request);
    await internalRetrieveCode('fresh query', serviceClient, request);

    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('activates quality guard blend fallback when top scores are weak', async () => {
    FEATURE_FLAGS.retrieval_quality_guard_v1 = true;

    const serviceClient = {
      semanticSearch: jest.fn(async () => [
        { path: 'src/weak.ts', content: 'weak result', relevanceScore: 0.05, lines: '1-2', matchType: 'semantic' },
      ]),
      localKeywordSearch: jest.fn(async () => [
        { path: 'src/fallback.ts', content: 'fallback result', relevanceScore: 0.91, lines: '1-2', matchType: 'keyword' },
      ]),
    } as any;

    const response = await internalRetrieveCode('weak query', serviceClient, {
      topK: 3,
      enableExpansion: false,
      enableLexical: false,
      enableFusion: false,
      enableRerank: true,
      rankingMode: 'v3' as any,
    });

    expect(response.qualityGuardState).toBe('enabled');
    expect(response.fallbackState).toBe('active');
    expect(response.results.some((item) => item.path === 'src/fallback.ts')).toBe(true);
    expect(response.flow?.stages).toEqual(expect.arrayContaining(['start', 'expanded_queries:1', 'handler:complete']));
    expect(serviceClient.semanticSearch).toHaveBeenCalledTimes(1);
    expect(serviceClient.localKeywordSearch).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before retrieval work starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const serviceClient = {
      semanticSearch: jest.fn(async () => []),
      localKeywordSearch: jest.fn(async () => []),
    } as any;

    await expect(
      retrieve('cancel me', serviceClient, {
        signal: controller.signal,
        enableExpansion: false,
        enableLexical: false,
        enableFusion: false,
        topK: 5,
      } as any)
    ).rejects.toThrow(/aborted/i);

    expect(serviceClient.semanticSearch).not.toHaveBeenCalled();
  });

  it('adds graph-aware query variants and provenance receipts when persisted graph artifacts are available', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieve-graph-aware-'));
    const loginPath = path.join(workspacePath, 'src', 'auth', 'loginService.ts');
    const helperPath = path.join(workspacePath, 'src', 'auth', 'helper.ts');
    fs.mkdirSync(path.dirname(loginPath), { recursive: true });
    fs.writeFileSync(
      loginPath,
      [
        'export function loginService() {',
        '  return helper();',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      helperPath,
      [
        'export function helper() {',
        '  return true;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(workspacePath, '.context-engine-index-state.json'),
      JSON.stringify({
        files: {
          'src/auth/loginService.ts': { hash: 'h-login', indexed_at: new Date().toISOString() },
          'src/auth/helper.ts': { hash: 'h-helper', indexed_at: new Date().toISOString() },
        },
      }),
      'utf8'
    );
    const graphStore = createWorkspacePersistentGraphStore({ workspacePath });
    await graphStore.refresh();

    try {
      const serviceClient = {
        workspacePath,
        semanticSearch: jest.fn(async (searchQuery: string) => {
          if (searchQuery === 'login service') {
            return [
              { path: 'src/other.ts', content: 'other result', relevanceScore: 0.88, lines: '1-2' },
            ];
          }
          if (searchQuery === 'loginService') {
            return [
              { path: 'src/auth/loginService.ts', content: 'login service body', relevanceScore: 0.71, lines: '1-3' },
            ];
          }
          return [];
        }),
        localKeywordSearch: jest.fn(async () => []),
      } as any;

      const results = await retrieve('login service', serviceClient, {
        enableExpansion: true,
        enableLexical: false,
        enableFusion: false,
        enableRerank: true,
        rankingMode: 'v3',
        rewriteMode: 'v2',
        topK: 5,
      });

      expect(serviceClient.semanticSearch.mock.calls.map((call: [string]) => call[0])).toEqual(
        expect.arrayContaining(['login service', 'loginService'])
      );
      expect(results[0]?.path).toBe('src/auth/loginService.ts');
      expect((results[0] as any).provenance).toEqual(
        expect.objectContaining({
          graphStatus: 'ready',
          seedSymbols: expect.arrayContaining(['loginService']),
          selectionBasis: expect.arrayContaining([
            expect.stringContaining('graph seed symbol'),
          ]),
        })
      );
      expect((results[0] as any).explainability).toEqual(
        expect.objectContaining({
          selectedBecause: expect.arrayContaining([
            expect.stringContaining('graph seed symbol'),
          ]),
          scoreBreakdown: expect.objectContaining({
            graphScore: expect.any(Number),
            combinedScore: expect.any(Number),
          }),
        })
      );
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
