import fs from 'fs';
import os from 'os';
import path from 'path';
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
  });

  it('builds and incrementally refreshes a persisted LanceDB vector index using index state hashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-index-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    const fileB = path.join(tmp, 'src', 'b.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    fs.writeFileSync(fileB, 'export const beta = "database schema";', 'utf8');

    const indexStatePath = path.join(tmp, '.augment-index-state.json');
    const vectorIndexPath = path.join(tmp, '.augment-lancedb-index.json');

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
    expect(fs.existsSync(path.join(tmp, '.augment-lancedb'))).toBe(true);

    const firstIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      docs: Record<string, { hash: string }>;
    };
    expect(Object.keys(firstIndex.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(firstIndex.embedding_model_id).toBe('hash-32');
    expect(firstIndex.vector_dimension).toBe(32);

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
      docs: Record<string, { hash: string; indexed_at: string }>;
    };
    expect(Object.keys(secondIndex.docs)).toEqual(['src/a.ts']);
    expect(secondIndex.docs['src/a.ts'].hash).toBe('h1b');
    expect(secondIndex.embedding_model_id).toBe('hash-32');
    expect(secondIndex.vector_dimension).toBe(32);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers from a corrupt LanceDB sidecar path on first load', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-recover-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.augment-index-state.json');
    const vectorIndexPath = path.join(tmp, '.augment-lancedb-index.json');
    const vectorDbPath = path.join(tmp, '.augment-lancedb');

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

  it('records transformer embedding metadata when the transformer runtime is available', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-transformer-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.augment-index-state.json');
    const vectorIndexPath = path.join(tmp, '.augment-lancedb-index.json');

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
            tolist: () => values.map((text) => [text.length, 1]),
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
      docs: Record<string, { hash: string }>;
    };
    expect(vectorIndex.embedding_model_id).toBe('Xenova/all-MiniLM-L6-v2');
    expect(vectorIndex.vector_dimension).toBe(16);
    expect(Object.keys(vectorIndex.docs)).toEqual(['src/a.ts']);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
