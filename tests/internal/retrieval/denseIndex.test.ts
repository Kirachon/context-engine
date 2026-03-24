import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHashEmbeddingRuntime } from '../../../src/internal/retrieval/embeddingRuntime.js';
import { createWorkspaceDenseRetriever } from '../../../src/internal/retrieval/denseIndex.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

describe('createWorkspaceDenseRetriever', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CE_DENSE_REFRESH_MAX_DOCS;
    delete process.env.CE_DENSE_EMBED_BATCH_SIZE;
  });

  it('builds and incrementally refreshes persisted dense index using index state hashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-dense-index-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    const fileB = path.join(tmp, 'src', 'b.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    fs.writeFileSync(fileB, 'export const beta = "database schema";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const denseIndexPath = path.join(tmp, '.context-engine-dense-index.json');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
        'src/b.ts': { hash: 'h2', indexed_at: new Date().toISOString() },
      },
    });

    const retriever = createWorkspaceDenseRetriever({
      workspacePath: tmp,
      indexStatePath,
      denseIndexPath,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    const first = await retriever.search('auth', 5);
    expect(first.length).toBeGreaterThan(0);
    expect(fs.existsSync(denseIndexPath)).toBe(true);

    const firstIndex = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      docs: Record<string, { hash: string }>;
    };
    expect(Object.keys(firstIndex.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(firstIndex.docs['src/a.ts'].hash).toBe('h1');
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

    const secondIndex = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      docs: Record<string, { hash: string; content: string }>;
    };
    expect(Object.keys(secondIndex.docs)).toEqual(['src/a.ts']);
    expect(secondIndex.docs['src/a.ts'].hash).toBe('h1b');
    expect(secondIndex.docs['src/a.ts'].content).toContain('updated');
    expect(secondIndex.embedding_model_id).toBe('hash-32');
    expect(secondIndex.vector_dimension).toBe(32);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('respects refresh-doc cap and embedding batch size', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-dense-index-cap-'));
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const denseIndexPath = path.join(tmp, '.context-engine-dense-index.json');
    const files: Record<string, { hash: string; indexed_at: string }> = {};

    for (let i = 0; i < 5; i += 1) {
      const relative = `src/file-${i}.ts`;
      const absolute = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `export const file${i} = "dense ${i}";`, 'utf8');
      files[relative] = { hash: `h${i}`, indexed_at: new Date().toISOString() };
    }
    writeJson(indexStatePath, { files });

    process.env.CE_DENSE_REFRESH_MAX_DOCS = '2';
    process.env.CE_DENSE_EMBED_BATCH_SIZE = '1';

    const embeddingProvider = {
      id: 'test-provider',
      embedQuery: jest.fn(async () => [1, 0, 0]),
      embedDocuments: jest.fn(async (documents: string[]) => documents.map(() => [1, 0, 0])),
    };

    const retriever = createWorkspaceDenseRetriever({
      workspacePath: tmp,
      indexStatePath,
      denseIndexPath,
      embeddingRuntime: {
        ...embeddingProvider,
        modelId: 'test-model',
        vectorDimension: 3,
      },
    });

    const results = await retriever.search('dense', 10);
    expect(results.length).toBe(2);
    expect(embeddingProvider.embedDocuments).toHaveBeenCalledTimes(2);
    expect(embeddingProvider.embedDocuments).toHaveBeenNthCalledWith(1, [expect.stringContaining('file0')]);
    expect(embeddingProvider.embedDocuments).toHaveBeenNthCalledWith(2, [expect.stringContaining('file1')]);

    const denseFile = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      docs: Record<string, unknown>;
    };
    expect(Object.keys(denseFile.docs).length).toBe(2);
    expect(Object.keys(denseFile.docs).sort()).toEqual(['src/file-0.ts', 'src/file-1.ts']);
    expect(denseFile.embedding_model_id).toBe('test-model');
    expect(denseFile.vector_dimension).toBe(3);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers from a corrupt dense sidecar file on first load', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-dense-recover-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');

    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const denseIndexPath = path.join(tmp, '.context-engine-dense-index.json');

    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });
    fs.writeFileSync(denseIndexPath, 'corrupt-dense-json', 'utf8');

    const retriever = createWorkspaceDenseRetriever({
      workspacePath: tmp,
      indexStatePath,
      denseIndexPath,
      embeddingRuntime: createHashEmbeddingRuntime(32),
    });

    const results = await retriever.search('auth', 5);
    expect(results.length).toBeGreaterThan(0);
    const denseFile = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as {
      embedding_model_id: string;
      vector_dimension: number;
      docs: Record<string, unknown>;
    };
    expect(Object.keys(denseFile.docs)).toEqual(['src/a.ts']);
    expect(denseFile.embedding_model_id).toBe('hash-32');
    expect(denseFile.vector_dimension).toBe(32);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
