import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import { hashIndexStateContent } from '../../../src/mcp/indexStateStore.js';
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

function writeIndexState(
  workspace: string,
  files: Record<string, { hash: string; indexed_at: string }>
): void {
  fs.writeFileSync(
    path.join(workspace, '.context-engine-index-state.json'),
    JSON.stringify({
      version: 2,
      schema_version: 2,
      provider_id: 'local_native',
      updated_at: new Date().toISOString(),
      files,
    }),
    'utf8'
  );
}

describe('sqlite lexical index', () => {
  let workspacePath = '';
  let activeIndex: WorkspaceSqliteLexicalIndex | null = null;

  afterEach(() => {
    FEATURE_FLAGS.hash_normalize_eol = false;
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

  it('prefers exact identifier matches for camelCase queries', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'src/loginService.ts',
      'export function resolveAIProviderId() { return "match"; }'
    );
    writeWorkspaceFile(
      workspacePath,
      'src/noise.ts',
      'export function resolveAiProvider() { return "near-miss"; }'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('resolveAIProviderId', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('src/loginService.ts');
    expect(results[0].content).toContain('resolveAIProviderId');
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

  it('reuses unchanged files across refreshes when index-state hashes normalize line endings', async () => {
    FEATURE_FLAGS.hash_normalize_eol = true;
    workspacePath = createTempWorkspace();

    const alphaContent = 'export const alpha = "needle one";\r\nexport const beta = "needle two";\r\n';
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', alphaContent);
    writeIndexState(workspacePath, {
      'src/alpha.ts': {
        hash: hashIndexStateContent(alphaContent),
        indexed_at: '2026-03-21T00:00:00.000Z',
      },
    });

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;

    const first = await index.refresh();
    expect(first).toMatchObject({
      refreshedFiles: 1,
      reusedFiles: 0,
      removedFiles: 0,
      totalFiles: 1,
      wroteIndex: true,
    });

    const second = await index.refresh();
    expect(second).toMatchObject({
      refreshedFiles: 0,
      reusedFiles: 1,
      removedFiles: 0,
      totalFiles: 1,
      wroteIndex: false,
    });

    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('src/alpha.ts');
  });

  it('refreshes mutated content and removes deleted files from state-driven hash diffs', async () => {
    FEATURE_FLAGS.hash_normalize_eol = true;
    workspacePath = createTempWorkspace();

    const alphaV1 = 'export const alpha = "needle one";\r\n';
    const betaV1 = 'export const beta = "needle two";\r\n';
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', alphaV1);
    writeWorkspaceFile(workspacePath, 'src/beta.ts', betaV1);
    writeIndexState(workspacePath, {
      'src/alpha.ts': {
        hash: hashIndexStateContent(alphaV1),
        indexed_at: '2026-03-21T00:00:00.000Z',
      },
      'src/beta.ts': {
        hash: hashIndexStateContent(betaV1),
        indexed_at: '2026-03-21T00:00:00.000Z',
      },
    });

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const alphaV2 = 'export const alpha = "needle updated";\r\n';
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', alphaV2);
    fs.rmSync(path.join(workspacePath, 'src', 'beta.ts'));
    writeIndexState(workspacePath, {
      'src/alpha.ts': {
        hash: hashIndexStateContent(alphaV2),
        indexed_at: '2026-03-21T00:01:00.000Z',
      },
    });

    const stats = await index.refresh();
    expect(stats).toMatchObject({
      refreshedFiles: 1,
      reusedFiles: 0,
      removedFiles: 1,
      totalFiles: 1,
      wroteIndex: true,
    });

    const results = await index.search('needle', 5);
    const alphaResult = results.find((result) => result.path === 'src/alpha.ts');
    expect(alphaResult?.content.toLowerCase()).toContain('needle updated');
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

  it('recovers from a corrupt sqlite artifact on first load', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', 'const alpha = "needle";');

    const dbPath = path.join(workspacePath, '.context-engine-lexical-index.sqlite');

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;

    await index.refresh();
    index.clearCache?.();
    fs.writeFileSync(dbPath, 'not-a-sqlite-db', 'utf8');

    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
