import { retrieve } from '../../../src/internal/retrieval/retrieve.js';

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
});
