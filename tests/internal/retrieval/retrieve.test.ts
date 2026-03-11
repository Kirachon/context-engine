import { retrieve } from '../../../src/internal/retrieval/retrieve.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('retrieve internal pipeline', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
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

  it('uses default workspace dense retriever when enableDense is true and no provider is supplied', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-retrieve-dense-default-'));
    const sampleFile = path.join(tmp, 'src', 'dense.ts');
    fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
    fs.writeFileSync(sampleFile, 'export const dense = "vector retrieval";', 'utf8');
    fs.writeFileSync(path.join(tmp, '.augment-index-state.json'), JSON.stringify({
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
    expect(fs.existsSync(path.join(tmp, '.augment-dense-index.json'))).toBe(true);

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
});
