import { createHashEmbeddingRuntime } from '../../../src/internal/retrieval/embeddingRuntime.js';

describe('createHashEmbeddingRuntime', () => {
  it('exposes model metadata and deterministic embeddings', async () => {
    const runtime = createHashEmbeddingRuntime(32);

    expect(runtime.id).toBe('hash-32');
    expect(runtime.modelId).toBe('hash-32');
    expect(runtime.vectorDimension).toBe(32);

    const query = await runtime.embedQuery('auth login');
    const docs = await runtime.embedDocuments(['auth login', 'database schema']);

    expect(query).toHaveLength(32);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toHaveLength(32);
    expect(docs[1]).toHaveLength(32);
    expect(docs[0]).toEqual(query);
  });
});
