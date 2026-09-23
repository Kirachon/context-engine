import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from '@jest/globals';
import { FEATURE_FLAGS } from '../../../src/config/features.js';
import { hashIndexStateContent } from '../../../src/mcp/indexStateStore.js';
import {
  createWorkspaceSqliteLexicalIndex,
  type WorkspaceSqliteLexicalIndex,
} from '../../../src/internal/retrieval/sqliteLexicalIndex.js';
import { RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR } from '../../../src/internal/retrieval/discoveryAdapter.js';

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

const hasNodeSqlite = (() => {
  try {
    const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function';
  } catch {
    return false;
  }
})();

// The SQLite backend is an optional runtime capability. Keep the supported
// Node 18/20 compatibility lanes green while the Node 22 lane exercises it.
const describeSqlite = hasNodeSqlite ? describe : describe.skip;

describeSqlite('sqlite lexical index', () => {
  let workspacePath = '';
  let activeIndex: WorkspaceSqliteLexicalIndex | null = null;

  afterEach(() => {
    FEATURE_FLAGS.hash_normalize_eol = false;
    delete process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
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
      'src/z-high-frequency.ts',
      `${'needle '.repeat(40)}\nconst highFrequency = true;`
    );
    writeWorkspaceFile(
      workspacePath,
      'src/a-low-frequency.ts',
      `needle ${'padding '.repeat(40)}\nconst lowFrequency = true;`
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('needle', 5);
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].path).toBe('src/z-high-frequency.ts');
  });

  it('prioritizes distinct paths before additional chunks from one file', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'docs/R4_WEEKLY_TREND_CONTRACT.md',
      Array.from({ length: 240 }, (_, index) => `needle repeated contract detail ${index}`).join('\n')
    );
    writeWorkspaceFile(
      workspacePath,
      'scripts/ci/generate-weekly-retrieval-trend-report.ts',
      'export const reportNeedle = "needle";'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('needle', 2);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.path)).toEqual([
      'docs/R4_WEEKLY_TREND_CONTRACT.md',
      'scripts/ci/generate-weekly-retrieval-trend-report.ts',
    ]);
    expect(new Set(results.map((result) => result.path)).size).toBe(results.length);

    const repeatedChunks = await index.search('contract', 2);
    expect(repeatedChunks).toHaveLength(2);
    expect(repeatedChunks.every((result) => result.path === 'docs/R4_WEEKLY_TREND_CONTRACT.md')).toBe(true);
    expect(new Set(repeatedChunks.map((result) => result.chunkId)).size).toBe(2);
  });

  it('matches punctuation in holdout queries as lexical terms', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'scripts/ci/generate-retrieval-quality-report.ts',
      [
        'export const calibration = true;',
        'export const gate_rules = true;',
        'export const reproducibility_lock = true;',
      ].join('\n')
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search(
      'generate-retrieval-quality-report calibration gate_rules reproducibility_lock',
      10
    );

    expect(results[0]?.path).toBe('scripts/ci/generate-retrieval-quality-report.ts');
  });

  it('excludes generated artifacts for pure code-intent queries', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(
      workspacePath,
      'src/compute_total.ts',
      'export function compute_total(items: number[]) { return items.reduce((sum, item) => sum + item, 0); }'
    );
    writeWorkspaceFile(
      workspacePath,
      'artifacts/bench/retrieval-quality-report.json',
      '{"query":"python compute_total items price qty sum", "path":"src/compute_total.ts"}'
    );

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('python compute_total items price qty sum', 10, {
      codeIntent: true,
      opsEvidenceIntent: false,
    });

    expect(results.some((result) => result.path === 'src/compute_total.ts')).toBe(true);
    expect(results.some((result) => result.path.startsWith('artifacts/'))).toBe(false);
  });

  it('excludes artifacts before limiting SQL candidates', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/target.ts', 'export const needle = true;');
    for (let index = 0; index < 30; index += 1) {
      writeWorkspaceFile(workspacePath, `artifacts/bench/report-${index}.json`, '{"value":"needle"}');
    }

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('needle', 1, { codeIntent: true, opsEvidenceIntent: false });
    expect(results.map((result) => result.path)).toEqual(['src/target.ts']);
  });

  it('ranks chunks containing every query term ahead of partial matches', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/combined.ts', 'authentication middleware');
    writeWorkspaceFile(workspacePath, 'src/authentication.ts', 'authentication authentication authentication');
    writeWorkspaceFile(workspacePath, 'src/middleware.ts', 'middleware middleware middleware');

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();

    const results = await index.search('authentication middleware', 3);
    expect(results[0]?.path).toBe('src/combined.ts');
    expect(results).toHaveLength(3);
  });

  it('does not rebuild the database after an FTS query error', async () => {
    workspacePath = createTempWorkspace();
    writeWorkspaceFile(workspacePath, 'src/alpha.ts', 'export const needle = true;');

    const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
    activeIndex = index;
    await index.refresh();
    const dbPath = index.getSnapshot().dbPath;
    const snapshot = index.getSnapshot();

    const sqlite = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: {
        prototype: {
          exec: (sql: string) => void;
          prepare: (sql: string) => unknown;
        };
      };
    };
    const databasePrototype = sqlite.DatabaseSync.prototype;
    const originalExec = databasePrototype.exec;
    const originalPrepare = databasePrototype.prepare;
    let schemaInitializationCount = 0;

    databasePrototype.exec = function (sql: string): void {
      if (sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS lexical_fts')) {
        schemaInitializationCount += 1;
      }
      originalExec.call(this, sql);
    };
    databasePrototype.prepare = function (sql: string): unknown {
      if (sql.includes('WHERE lexical_fts MATCH ?')) {
        throw Object.assign(new Error('no such column: retrieval'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 1,
          errstr: 'SQL logic error',
        });
      }
      return originalPrepare.call(this, sql);
    };

    try {
      await expect(index.search('a query with syntax trouble', 5)).resolves.toEqual([]);
      expect(schemaInitializationCount).toBe(0);
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(index.getSnapshot()).toEqual(snapshot);
    } finally {
      databasePrototype.exec = originalExec;
      databasePrototype.prepare = originalPrepare;
    }
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

  describe('R3b2: canonical discovery manifest binding', () => {
    it('never indexes a path outside the canonical source set via the empty-state fallback walk', async () => {
      workspacePath = createTempWorkspace();
      writeWorkspaceFile(workspacePath, 'src/real.ts', 'export const real = "needle target";');
      // Eligible extension, present on disk, but under a hard-excluded
      // canonical directory name that this store's own (narrower) ad hoc
      // fallback walk does not know about. No index-state file exists, so
      // this exercises the fallback-discovery branch of resolveWorkspaceFiles.
      writeWorkspaceFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = "needle target";');

      const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
      activeIndex = index;
      const stats = await index.refresh();

      expect(stats.totalFiles).toBe(1);

      const results = await index.search('needle', 5);
      expect(results.some((result) => result.path === 'vendor/pkg.ts')).toBe(false);
      expect(results.some((result) => result.path === 'src/real.ts')).toBe(true);
    });

    it('never indexes a path outside the canonical source set when index-state claims it', async () => {
      workspacePath = createTempWorkspace();
      writeWorkspaceFile(workspacePath, 'src/real.ts', 'export const real = "needle target";');
      writeWorkspaceFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = "needle target";');
      writeIndexState(workspacePath, {
        'src/real.ts': { hash: hashIndexStateContent('export const real = "needle target";'), indexed_at: '2026-03-21T00:00:00.000Z' },
        'vendor/pkg.ts': { hash: hashIndexStateContent('export const vendored = "needle target";'), indexed_at: '2026-03-21T00:00:00.000Z' },
      });

      const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
      activeIndex = index;
      const stats = await index.refresh();

      expect(stats.totalFiles).toBe(1);

      const results = await index.search('needle', 5);
      expect(results.some((result) => result.path === 'vendor/pkg.ts')).toBe(false);
    });

    it('never applies an incremental add/change outside the canonical source set', async () => {
      workspacePath = createTempWorkspace();
      writeWorkspaceFile(workspacePath, 'src/real.ts', 'export const real = "needle one";');

      const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
      activeIndex = index;
      await index.refresh();

      writeWorkspaceFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = "needle two";');
      const stats = await index.applyWorkspaceChanges?.([{ type: 'add', path: 'vendor/pkg.ts' }]);

      expect(stats?.refreshedFiles).toBe(0);
      const results = await index.search('needle', 5);
      expect(results.some((result) => result.path === 'vendor/pkg.ts')).toBe(false);
    });

    it('rollback lever: CE_RETRIEVAL_DISCOVERY_MANIFEST_DISABLED restores pre-R3b2 behavior', async () => {
      workspacePath = createTempWorkspace();
      writeWorkspaceFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = "needle target";');

      process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';

      const index = createWorkspaceSqliteLexicalIndex({ workspacePath });
      activeIndex = index;
      const stats = await index.refresh();

      expect(stats.totalFiles).toBe(1);
      const results = await index.search('needle', 5);
      expect(results.some((result) => result.path === 'vendor/pkg.ts')).toBe(true);
    });
  });
});
