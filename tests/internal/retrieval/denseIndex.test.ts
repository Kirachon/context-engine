import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHashEmbeddingProvider } from '../../../src/internal/retrieval/embeddingProvider.js';
import { createWorkspaceDenseRetriever } from '../../../src/internal/retrieval/denseIndex.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

describe('createWorkspaceDenseRetriever', () => {
  it('builds and incrementally refreshes persisted dense index using index state hashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-dense-index-'));
    const fileA = path.join(tmp, 'src', 'a.ts');
    const fileB = path.join(tmp, 'src', 'b.ts');
    fs.mkdirSync(path.dirname(fileA), { recursive: true });
    fs.writeFileSync(fileA, 'export const alpha = "auth login";', 'utf8');
    fs.writeFileSync(fileB, 'export const beta = "database schema";', 'utf8');

    const indexStatePath = path.join(tmp, '.augment-index-state.json');
    const denseIndexPath = path.join(tmp, '.augment-dense-index.json');

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
      embeddingProvider: createHashEmbeddingProvider(32),
    });

    const first = await retriever.search('auth', 5);
    expect(first.length).toBeGreaterThan(0);
    expect(fs.existsSync(denseIndexPath)).toBe(true);

    const firstIndex = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as { docs: Record<string, { hash: string }> };
    expect(Object.keys(firstIndex.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(firstIndex.docs['src/a.ts'].hash).toBe('h1');

    fs.writeFileSync(fileA, 'export const alpha = "auth login updated";', 'utf8');
    writeJson(indexStatePath, {
      files: {
        'src/a.ts': { hash: 'h1b', indexed_at: new Date().toISOString() },
      },
    });

    const second = await retriever.search('updated auth', 5);
    expect(second.length).toBeGreaterThan(0);

    const secondIndex = JSON.parse(fs.readFileSync(denseIndexPath, 'utf8')) as { docs: Record<string, { hash: string; content: string }> };
    expect(Object.keys(secondIndex.docs)).toEqual(['src/a.ts']);
    expect(secondIndex.docs['src/a.ts'].hash).toBe('h1b');
    expect(secondIndex.docs['src/a.ts'].content).toContain('updated');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

