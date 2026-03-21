import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  createWorkspaceSqliteLexicalIndex,
  type WorkspaceSqliteLexicalIndex,
} from '../../../src/internal/retrieval/sqliteLexicalIndex.js';

function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-lexical-index-'));
}

function writeWorkspaceFile(workspace: string, relativePath: string, content: string): void {
  const fullPath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function removeWorkspace(workspace: string): void {
  fs.rmSync(workspace, { recursive: true, force: true });
}

describe('sqlite lexical index', () => {
  let workspacePath = '';
  let activeIndex: WorkspaceSqliteLexicalIndex | null = null;

  afterEach(() => {
    activeIndex?.clearCache?.();
    activeIndex = null;
    if (workspacePath) {
      removeWorkspace(workspacePath);
    }
    workspacePath = '';
  });

  it('refreshes and returns lexical hits with snippets', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'src/alpha.ts',
      'export const alpha = "needle one";\nexport const beta = "needle two";'
    );
    writeWorkspaceFile(
      workspacePath,
      'src/beta.ts',
      'export const gamma = "needle three";'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    const stats = await index.refresh();
    expect(stats.totalFiles).toBeGreaterThan(0);

    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toMatch(/src\/alpha\.ts|src\/beta\.ts/);
    expect(results[0].content.toLowerCase()).toContain('needle');
    expect(results[0].chunkId).toContain('#L');
  });

  it('orders results by lexical relevance', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'src/alpha.ts',
      'needle needle needle needle\nconst alpha = true;'
    );
    writeWorkspaceFile(
      workspacePath,
      'src/beta.ts',
      'const beta = true;\nneedle'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].path).toBe('src/alpha.ts');
  });

  it('applies incremental workspace changes without rebuilding the whole index', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'src/alpha.ts',
      'export const alpha = "needle one";'
    );
    writeWorkspaceFile(
      workspacePath,
      'src/beta.ts',
      'export const beta = "needle two";'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    writeWorkspaceFile(
      workspacePath,
      'src/alpha.ts',
      'export const alpha = "needle updated";'
    );
    writeWorkspaceFile(
      workspacePath,
      'src/gamma.ts',
      'export const gamma = "needle three";'
    );

    const stats = await index.applyWorkspaceChanges?.([
      { type: 'change', path: 'src/alpha.ts' },
      { type: 'add', path: 'src/gamma.ts' },
      { type: 'unlink', path: 'src/beta.ts' },
    ]);

    expect(stats).toBeTruthy();
    expect(stats?.refreshedFiles).toBe(2);
    expect(stats?.removedFiles).toBe(1);

    const results = await index.search('needle', 5);
    const alphaResult = results.find((result) => result.path === 'src/alpha.ts');
    expect(alphaResult?.content.toLowerCase()).toContain('needle updated');
    expect(results.some((result) => result.path === 'src/gamma.ts')).toBe(true);
    expect(results.some((result) => result.path === 'src/beta.ts')).toBe(false);
  });

  it('returns empty results for empty queries', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', 'const alpha = 1;');

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('   ', 5);
    expect(results).toEqual([]);
  });

  it('recreates the sqlite file after cache reset', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', 'const alpha = "needle";');

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();
    const dbPath = index.getSnapshot().dbPath;
    expect(fs.existsSync(dbPath)).toBe(true);

    index.clearCache?.();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    await index.refresh();
    expect(fs.existsSync(dbPath)).toBe(true);
    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(0);
  });
});
