import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function createMockEmbeddingRuntime() {
  return {
    id: 'mock-runtime',
    modelId: 'mock-model',
    vectorDimension: 2,
    embedQuery: jest.fn(async () => [0.5, 0.25]),
    embedDocuments: jest.fn(async (docs: string[]) => docs.map((_, index) => [index + 1, 1])),
  };
}

async function loadRetriever(connectMock: jest.Mock, ivfFlatMock = jest.fn(() => ({ type: 'ivf-flat' }))) {
  jest.unstable_mockModule('@lancedb/lancedb', () => ({
    connect: connectMock,
    Index: {
      ivfFlat: ivfFlatMock,
    },
  }));

  return import('../../src/internal/retrieval/lancedbVectorIndex.js');
}

describe('LanceDB vector guardrails', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CE_DENSE_EMBED_BATCH_SIZE;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('retries transient query failures without deleting vector artifacts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-retry-'));
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const fileA = path.join(tmp, 'src', 'a.ts');
    const runtime = createMockEmbeddingRuntime();

    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });
    writeJson(vectorIndexPath, {
      version: 1,
      embedding_provider: runtime.id,
      embedding_model_id: runtime.modelId,
      vector_dimension: runtime.vectorDimension,
      updated_at: new Date().toISOString(),
      doc_count: 1,
      vector_index_ready: true,
      docs: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const toArrayMock = jest.fn(async (): Promise<Array<Record<string, unknown>>> => [])
      .mockRejectedValueOnce(new Error('temporary vector search failure'))
      .mockResolvedValueOnce([
        {
          path: 'src/a.ts',
          content: 'export const alpha = "auth login";',
          lines: 'export const alpha = "auth login";',
          _distance: 0.1,
        },
      ]);
    const table = {
      countRows: jest.fn(async (_filter?: string) => 1),
      delete: jest.fn(async (_predicate: string) => undefined),
      add: jest.fn(async (_rows: unknown[]) => undefined),
      listIndices: jest.fn(async () => [{ name: 'vector_idx' }]),
      createIndex: jest.fn(async () => undefined),
      waitForIndex: jest.fn(async () => undefined),
      vectorSearch: jest.fn(() => ({
        limit: jest.fn(() => ({
          toArray: toArrayMock,
        })),
      })),
    };
    const connection = {
      tableNames: jest.fn(async () => ['retrieval_vectors']),
      openTable: jest.fn(async () => table),
      createTable: jest.fn(async () => table),
      dropTable: jest.fn(async () => undefined),
    };
    const connectMock = jest.fn(async () => connection);
    const rmSpy = jest.spyOn(fs, 'rmSync');

    try {
      const { createWorkspaceLanceDbVectorRetriever } = await loadRetriever(connectMock);
      const retriever = createWorkspaceLanceDbVectorRetriever({
        workspacePath: tmp,
        indexStatePath,
        vectorDbPath,
        embeddingRuntime: runtime as never,
      });

      const results = await retriever.search('auth', 5);
      expect(results).toHaveLength(1);
      expect(toArrayMock).toHaveBeenCalledTimes(2);
      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(rmSpy.mock.calls.some(([target]) => target === vectorDbPath)).toBe(false);
    } finally {
      rmSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persists verified index state so repeated searches skip redundant index checks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-ready-'));
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const fileA = path.join(tmp, 'src', 'a.ts');
    const runtime = createMockEmbeddingRuntime();

    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });
    writeJson(vectorIndexPath, {
      version: 1,
      embedding_provider: runtime.id,
      embedding_model_id: runtime.modelId,
      vector_dimension: runtime.vectorDimension,
      updated_at: new Date().toISOString(),
      doc_count: 1,
      docs: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const table = {
      countRows: jest.fn(async (_filter?: string) => 1),
      delete: jest.fn(async (_predicate: string) => undefined),
      add: jest.fn(async (_rows: unknown[]) => undefined),
      listIndices: jest.fn(async () => [{ name: 'vector_idx' }]),
      createIndex: jest.fn(async () => undefined),
      waitForIndex: jest.fn(async () => undefined),
      vectorSearch: jest.fn(() => ({
        limit: jest.fn(() => ({
          toArray: jest.fn(async (): Promise<Array<Record<string, unknown>>> => [
            {
              path: 'src/a.ts',
              content: 'export const alpha = "auth login";',
              lines: 'export const alpha = "auth login";',
              _distance: 0.1,
            },
          ]),
        })),
      })),
    };
    const connection = {
      tableNames: jest.fn(async () => ['retrieval_vectors']),
      openTable: jest.fn(async () => table),
      createTable: jest.fn(async () => table),
      dropTable: jest.fn(async () => undefined),
    };
    const connectMock = jest.fn(async () => connection);

    try {
      const { createWorkspaceLanceDbVectorRetriever } = await loadRetriever(connectMock);
      const retriever = createWorkspaceLanceDbVectorRetriever({
        workspacePath: tmp,
        indexStatePath,
        vectorDbPath,
        embeddingRuntime: runtime as never,
      });

      expect((await retriever.search('auth', 5)).length).toBeGreaterThan(0);
      expect((await retriever.search('auth', 5)).length).toBeGreaterThan(0);

      expect(table.listIndices).toHaveBeenCalledTimes(1);
      const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
        doc_count: number;
        vector_index_ready: boolean;
      };
      expect(vectorIndex.doc_count).toBe(1);
      expect(vectorIndex.vector_index_ready).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('chunks incremental table.add writes into bounded batches', async () => {
    process.env.CE_DENSE_EMBED_BATCH_SIZE = '2';

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-batch-'));
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const runtime = createMockEmbeddingRuntime();

    const docs: Record<string, { hash: string; indexed_at: string }> = {};
    const stateFiles: Record<string, { hash: string; indexed_at: string }> = {};
    for (let index = 0; index < 5; index += 1) {
      const relativePath = `src/file-${index}.ts`;
      const absolutePath = path.join(tmp, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `export const value${index} = "doc ${index}";`, 'utf8');
      docs[relativePath] = { hash: `old-${index}`, indexed_at: new Date().toISOString() };
      stateFiles[relativePath] = { hash: `new-${index}`, indexed_at: new Date().toISOString() };
    }

    writeJson(indexStatePath, { files: stateFiles });
    writeJson(vectorIndexPath, {
      version: 1,
      embedding_provider: runtime.id,
      embedding_model_id: runtime.modelId,
      vector_dimension: runtime.vectorDimension,
      updated_at: new Date().toISOString(),
      doc_count: 5,
      vector_index_ready: true,
      docs,
    });

    const table = {
      countRows: jest.fn(async (_filter?: string) => 5),
      delete: jest.fn(async (_predicate: string) => undefined),
      add: jest.fn(async (_rows: unknown[]) => undefined),
      listIndices: jest.fn(async () => [{ name: 'vector_idx' }]),
      createIndex: jest.fn(async () => undefined),
      waitForIndex: jest.fn(async () => undefined),
      vectorSearch: jest.fn(() => ({
        limit: jest.fn(() => ({
          toArray: jest.fn(async (): Promise<Array<Record<string, unknown>>> => []),
        })),
      })),
    };
    const connection = {
      tableNames: jest.fn(async () => ['retrieval_vectors']),
      openTable: jest.fn(async () => table),
      createTable: jest.fn(async () => table),
      dropTable: jest.fn(async () => undefined),
    };
    const connectMock = jest.fn(async () => connection);

    try {
      const { createWorkspaceLanceDbVectorRetriever } = await loadRetriever(connectMock);
      const retriever = createWorkspaceLanceDbVectorRetriever({
        workspacePath: tmp,
        indexStatePath,
        vectorDbPath,
        embeddingRuntime: runtime as never,
      });

      await retriever.search('doc', 5);

      expect(table.delete).toHaveBeenCalledTimes(1);
      expect(table.add.mock.calls.map((args) => args[0].length)).toEqual([2, 2, 1]);

      const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
        doc_count: number;
        vector_index_ready: boolean;
        docs: Record<string, { hash: string }>;
      };
      expect(vectorIndex.doc_count).toBe(5);
      expect(vectorIndex.vector_index_ready).toBe(true);
      expect(Object.values(vectorIndex.docs).map((entry) => entry.hash).sort()).toEqual([
        'new-0',
        'new-1',
        'new-2',
        'new-3',
        'new-4',
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('drops the table when incremental refresh removes all materializable documents', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-lancedb-empty-refresh-'));
    const vectorDbPath = path.join(tmp, '.context-engine-lancedb');
    const indexStatePath = path.join(tmp, '.context-engine-index-state.json');
    const vectorIndexPath = path.join(tmp, '.context-engine-lancedb-index.json');
    const fileA = path.join(tmp, 'src', 'a.ts');
    const runtime = createMockEmbeddingRuntime();

    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/missing.ts': { hash: 'h2', indexed_at: new Date().toISOString() },
      },
    });
    writeJson(vectorIndexPath, {
      version: 1,
      embedding_provider: runtime.id,
      embedding_model_id: runtime.modelId,
      vector_dimension: runtime.vectorDimension,
      updated_at: new Date().toISOString(),
      doc_count: 1,
      vector_index_ready: true,
      docs: {
        'src/a.ts': { hash: 'h1', indexed_at: new Date().toISOString() },
      },
    });

    const table = {
      countRows: jest.fn(async (_filter?: string) => 1),
      delete: jest.fn(async (_predicate: string) => undefined),
      add: jest.fn(async (_rows: unknown[]) => undefined),
      listIndices: jest.fn(async () => [{ name: 'vector_idx' }]),
      createIndex: jest.fn(async () => undefined),
      waitForIndex: jest.fn(async () => undefined),
      vectorSearch: jest.fn(() => ({
        limit: jest.fn(() => ({
          toArray: jest.fn(async (): Promise<Array<Record<string, unknown>>> => []),
        })),
      })),
    };
    const tableNamesMock = jest.fn(async () => ['retrieval_vectors'])
      .mockResolvedValueOnce(['retrieval_vectors'])
      .mockResolvedValueOnce([]);
    const connection = {
      tableNames: tableNamesMock,
      openTable: jest.fn(async () => table),
      createTable: jest.fn(async () => table),
      dropTable: jest.fn(async () => undefined),
    };
    const connectMock = jest.fn(async () => connection);

    try {
      const { createWorkspaceLanceDbVectorRetriever } = await loadRetriever(connectMock);
      const retriever = createWorkspaceLanceDbVectorRetriever({
        workspacePath: tmp,
        indexStatePath,
        vectorDbPath,
        embeddingRuntime: runtime as never,
      });

      const results = await retriever.search('auth', 5);
      expect(results).toEqual([]);
      expect(connection.dropTable).toHaveBeenCalledWith('retrieval_vectors');
      expect(table.vectorSearch).not.toHaveBeenCalled();

      const vectorIndex = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8')) as {
        doc_count: number;
        vector_index_ready: boolean;
        docs: Record<string, { hash: string; indexed_at: string }>;
      };
      expect(vectorIndex.doc_count).toBe(0);
      expect(vectorIndex.vector_index_ready).toBe(false);
      expect(vectorIndex.docs).toEqual({});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
