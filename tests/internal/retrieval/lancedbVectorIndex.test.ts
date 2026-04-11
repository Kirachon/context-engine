import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import {
  createInternalEmbeddingReuse,
  setInternalEmbeddingReuse,
} from '../../../src/internal/handlers/performance.js';
import { createWorkspaceLanceDbVectorRetriever } from '../../../src/internal/retrieval/lancedbVectorIndex.js';
import { createConfiguredEmbeddingRuntime, createHashEmbeddingRuntime } from '../../../src/internal/retrieval/embeddingRuntime.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

describe('createWorkspaceLanceDbVectorRetriever', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CE_DENSE_REFRESH_MAX_DOCS;
    delete process.env.CE_DENSE_EMBED_BATCH_SIZE;
    setInternalEmbeddingReuse(undefined);
  });

  it('builds and incrementally refreshes a persisted LanceDB vector index using index state hashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-index-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    const fileB = path.join(tmp, 'src', 'b.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    fs.writeFileSync(fileB, 'export const beta = "database schema";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
        'src/b.ts': { hash: 'h2', indexed_at: new Date().toISOString() },
      },
    });

    const retriever = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    const first = await retriever.search('auth', 5);
    expect(first.length).toBeGreaterThan(0);
    expect(fs.existsSync(vectorIndexPath)).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.context-engine-lancedb'))).toBe(true);

    const firstIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      doc_count: number;
      vector_index_ready: boolean;
      docs: Record<string, { hash: string }>;
    };
    expect(Object.keys(firstIndex.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(firstIndex.embedding_model_id).toBe('hash-32');
    expect(firstIndex.vector_dimension).toBe(32);
    expect(firstIndex.doc_count).toBe(2);
    expect(firstIndex.vector_index_ready).toBe(true);

    fs.writeFileSync(fileA, 'export const alpha = "auth login updated";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1b', indexed_at: new Date().toISOString() },
      },
    });

    const second = await retriever.search('updated auth', 5);
    expect(second.length).toBeGreaterThan(0);

    const secondIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      doc_count: number;
      vector_index_ready: boolean;
      docs: Record<string, { hash: string; indexed_at: string }>;
    };
    expect(Object.keys(secondIndex.docs)).toEqual(['src/a.ts']);
    expect(secondIndex.docs['src/a.ts'].hash).toBe('h1b');
    expect(secondIndex.embedding_model_id).toBe('hash-32');
    expect(secondIndex.vector_dimension).toBe(32);
    expect(secondIndex.doc_count).toBe(1);
    expect(secondIndex.vector_index_ready).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers from a corrupt LanceDB sidecar path on first load', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-recover-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });
    fs.writeFileSync(vectorDbPath, 'corrupt-vector-db-path', 'utf8');

    const retriever = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      vectorDbPath,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    const results = await retriever.search('auth', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(fs.existsSync(vectorIndexPath)).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reuses persisted embeddings across LanceDB rebuilds and invalidates on model or content change', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-embedding-reuse-'));
    const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const createRuntime = (modelId: string) => ({
      id: 'provider-a',
      modelId,
      vectorDimension: 2,
      embedQuery: jest.fn(async () => modelId === 'model-a' ? [1, 0] : [0, 1]),
      embedDocuments: jest.fn(async (docs: string[]) => docs.map(() => modelId === 'model-a' ? [1, 0] : [0, 1])),
    });
    const createRetriever = (runtime: ReturnType<typeof createRuntime>) => createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      vectorDbPath,
      embeddingRuntime: runtime as never,
    });

    setInternalEmbeddingReuse(createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 128,
      maxPersistedBytes: 512 * 1024,
    }));
    const runtimeA1 = createRuntime('model-a');
    await createRetriever(runtimeA1).search('auth', 5);
    expect(runtimeA1.embedDocuments).toHaveBeenCalledTimes(1);
    expect(runtimeA1.embedQuery).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(vectorDbPath, { recursive: true, force: true });
    fs.rmSync(vectorIndexPath, { force: true });
    setInternalEmbeddingReuse(createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 128,
      maxPersistedBytes: 512 * 1024,
    }));
    const runtimeA2 = createRuntime('model-a');
    await createRetriever(runtimeA2).search('auth', 5);
    expect(runtimeA2.embedDocuments).toHaveBeenCalledTimes(0);
    expect(runtimeA2.embedQuery).toHaveBeenCalledTimes(0);

    setInternalEmbeddingReuse(createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 128,
      maxPersistedBytes: 512 * 1024,
    }));
    const runtimeB1 = createRuntime('model-b');
    await createRetriever(runtimeB1).search('auth', 5);
    expect(runtimeB1.embedDocuments).toHaveBeenCalledTimes(1);
    expect(runtimeB1.embedQuery).toHaveBeenCalledTimes(1);

    const modelUpdatedIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      doc_count: number;
      docs: Record<string, { hash: string }>;
    };
    expect(modelUpdatedIndex.embedding_model_id).toBe('model-b');
    expect(modelUpdatedIndex.vector_dimension).toBe(2);
    expect(modelUpdatedIndex.doc_count).toBe(1);
    expect(modelUpdatedIndex.docs['src/a.ts']?.hash).toBe('h1');

    fs.writeFileSync(fileA, 'export const alpha = "auth changed";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h2', indexed_at: new Date().toISOString() },
      },
    });
    setInternalEmbeddingReuse(createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 128,
      maxPersistedBytes: 512 * 1024,
    }));
    const runtimeB2 = createRuntime('model-b');
    await createRetriever(runtimeB2).search('auth', 5);
    expect(runtimeB2.embedDocuments).toHaveBeenCalledTimes(1);
    expect(runtimeB2.embedQuery).toHaveBeenCalledTimes(0);

    const contentUpdatedIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      docs: Record<string, { hash: string }>;
    };
    expect(contentUpdatedIndex.embedding_model_id).toBe('model-b');
    expect(contentUpdatedIndex.docs['src/a.ts']?.hash).toBe('h2');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('repairs persisted vector index metadata when doc_count is inconsistent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-integrity-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const retriever = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    expect((await retriever.search('auth', 5)).length).toBeGreaterThan(0);

    const tampered = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      doc_count: number;
      vector_index_ready: boolean;
      docs: Record<string, { hash: string; indexed_at: string }>;
    };
    tampered.doc_count = 99;
    tampered.vector_index_ready = true;
    writeJson(vectorIndexPath, tampered);

    const repaired = await retriever.search('auth', 5);
    expect(repaired.length).toBeGreaterThan(0);

    const repairedIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      doc_count: number;
      vector_index_ready: boolean;
      docs: Record<string, { hash: string; indexed_at: string }>;
    };
    expect(repairedIndex.doc_count).toBe(1);
    expect(repairedIndex.vector_index_ready).toBe(true);
    expect(Object.keys(repairedIndex.docs)).toEqual(['src/a.ts']);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records transformer embedding metadata when the transformer runtime is available', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-transformer-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const runtime = createConfiguredEmbeddingRuntime({
      preferTransformers: true,
      transformerModelId: 'Xenova/all-MiniLM-L6-v2',
      transformerVectorDimension: 16,
      loadTransformersModule: async () => ({
        env: { localModelPath: '' },
        pipeline: async () => async (texts: string | string[]) => {
          const values = Array.isArray(texts) ? texts : [texts];
          return {
            tolist: () => values.map((text) => [
              text.length,
              ...Array.from({ length: 15 }, (_, index) => index === 0 ? 1 : 0),
            ]),
          };
        },
      }) as never,
    });

    const retriever = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      embeddingRuntime: runtime,
    });

    const results = await retriever.search('auth', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(fs.existsSync(vectorIndexPath)).toBe(true);

    const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      doc_count: number;
      docs: Record<string, { hash: string }>;
    };
    expect(vectorIndex.embedding_model_id).toBe('Xenova/all-MiniLM-L6-v2');
    expect(vectorIndex.vector_dimension).toBe(16);
    expect(vectorIndex.doc_count).toBe(1);
    expect(Object.keys(vectorIndex.docs)).toEqual(['src/a.ts']);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('embeds bounded subchunks so both early and late file content reach the embedding runtime', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-subchunks-'));
    const lateFile = path.join(tmp, 'src', 'z-late.ts');
    const noiseFile = path.join(tmp, 'src', 'a-noise.ts');
    fs.mkdirSync(path.dirname(lateFile), { recursive: true });
    fs.writeFileSync(
      lateFile,
      [
        ...Array.from({ length: 40 }, (_, index) => `// filler line ${index} moves the real symbol later in the file`),
        '',
        'export const lateNeedle = "late needle";',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(noiseFile, 'export const noise = "no late match here";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    writeJson(indexStatePath, {
      files: {
        'src/z-late.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
        'src/a-noise.ts': { hash: 'h2', indexed_at: new Date().toISOString() },
      },
    });

    const embedDocuments = jest.fn(async (docs: string[]) => docs.map((doc) => {
      const visible = doc.slice(0, 180).toLowerCase();
      return visible.includes('late needle') ? [1, 0] : [0, 1];
    }));
    const retriever = createWorkspaceLanceDbVectorRetriever({
      workspacePath: tmp,
      indexStatePath,
      embeddingRuntime: {
        id: 'short-context-runtime',
        modelId: 'short-context-runtime',
        vectorDimension: 2,
        embedQuery: async (query: string) => query.toLowerCase().includes('late needle') ? [1, 0] : [0, 1],
        embedDocuments,
      } as never,
    });

    const results = await retriever.search('late needle', 5);
    const embeddedDocs = embedDocuments.mock.calls.flatMap(([docs]) => docs as string[]);

    expect(results.length).toBeGreaterThan(0);
    expect(embeddedDocs.length).toBeGreaterThan(2);
    expect(embeddedDocs.some((doc) => doc.includes('lateNeedle'))).toBe(true);
    expect(embeddedDocs.some((doc) => doc.includes('filler line 0'))).toBe(true);
    expect(embeddedDocs.every((doc) => doc.length <= 900)).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
