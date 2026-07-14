import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createWatcherDiscoveryAdapter,
  isWatcherDiscoveryManifestDisabled,
  WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR,
} from '../../src/watcher/discoveryAdapter.js';
import { produceDiscoveryManifest, type DiscoveryManifest } from '../../src/internal/discovery/discoveryManifest.js';
import type { FileChange } from '../../src/watcher/types.js';

describe('createWatcherDiscoveryAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-watcher-discovery-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeFile(workspacePath: string, relativePath: string, contents: string): void {
    const fullPath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents, 'utf-8');
  }

  function change(type: FileChange['type'], relativePath: string): FileChange {
    return { type, path: relativePath, timestamp: Date.now() };
  }

  function stripGeneratedAt(manifest: DiscoveryManifest): Omit<DiscoveryManifest, 'generated_at'> {
    const { generated_at: _generatedAt, ...rest } = manifest;
    return rest;
  }

  it('rollback lever: defaults to enabled and honors CE_WATCHER_DISCOVERY_MANIFEST_DISABLED', () => {
    const previous = process.env[WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
    try {
      delete process.env[WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
      expect(isWatcherDiscoveryManifestDisabled()).toBe(false);

      process.env[WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';
      expect(isWatcherDiscoveryManifestDisabled()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
      } else {
        process.env[WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = previous;
      }
    }
  });

  it('builds chokidar ignore patterns from only the non-negatable hard directory gate', async () => {
    const workspacePath = createTempWorkspace();
    const adapterA = await createWatcherDiscoveryAdapter(workspacePath);
    const adapterB = await createWatcherDiscoveryAdapter(workspacePath);

    expect(adapterA.chokidarIgnored).toContain('**/node_modules/**');
    expect(adapterA.chokidarIgnored).toContain('**/.git/**');
    // Deterministic: two independent adapters over the same (default) rules
    // produce the exact same ordered pattern list.
    expect(adapterA.chokidarIgnored).toEqual(adapterB.chokidarIgnored);
  });

  it('seeds the manifest with a full discovery pass matching produceDiscoveryManifest', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    writeFile(workspacePath, 'node_modules/pkg/index.js', 'module.exports = {};\n');

    const adapter = await createWatcherDiscoveryAdapter(workspacePath);
    const full = await produceDiscoveryManifest({ workspacePath });

    expect(stripGeneratedAt(adapter.getManifest())).toEqual(stripGeneratedAt(full));
  });

  it('marks an eligible add as eligible and folds it into the manifest', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    writeFile(workspacePath, 'src/b.md', 'b\n');
    const result = await adapter.applyBatch([change('add', 'src/b.md')]);

    expect(result.eligibleChanges.map((c) => c.path)).toEqual(['src/b.md']);
    expect(result.manifest.files.map((f) => f.path)).toContain('src/b.md');

    const full = await produceDiscoveryManifest({ workspacePath });
    expect(stripGeneratedAt(result.manifest)).toEqual(stripGeneratedAt(full));
  });

  it('drops an ineligible add rather than forwarding it or including it in the manifest', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    writeFile(workspacePath, 'dist/build.md', 'build\n');
    const result = await adapter.applyBatch([change('add', 'dist/build.md')]);

    expect(result.eligibleChanges).toEqual([]);
    expect(result.manifest.files.map((f) => f.path)).not.toContain('dist/build.md');
  });

  it('preserves a negated-back-in file: eligible add, ineligible sibling stays dropped', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.gitignore', ['*.md', '!keep.md'].join('\n'));
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    writeFile(workspacePath, 'keep.md', 'keep\n');
    writeFile(workspacePath, 'debug.md', 'debug\n');
    const result = await adapter.applyBatch([change('add', 'keep.md'), change('add', 'debug.md')]);

    expect(result.eligibleChanges.map((c) => c.path)).toEqual(['keep.md']);
    expect(result.manifest.files.map((f) => f.path)).toContain('keep.md');
    expect(result.manifest.files.map((f) => f.path)).not.toContain('debug.md');
  });

  it('marks unlink of a previously known path as eligible', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    writeFile(workspacePath, 'src/b.md', 'b\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    fs.rmSync(path.join(workspacePath, 'src', 'b.md'));
    const result = await adapter.applyBatch([change('unlink', 'src/b.md')]);

    expect(result.eligibleChanges.map((c) => c.path)).toEqual(['src/b.md']);
    expect(result.manifest.files.map((f) => f.path)).not.toContain('src/b.md');
  });

  it('drops an unlink for a path that was never tracked in the manifest', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    // node_modules content was never eligible in the first place, so its
    // removal should not be forwarded as a real index change either.
    const result = await adapter.applyBatch([change('unlink', 'node_modules/pkg/index.js')]);

    expect(result.eligibleChanges).toEqual([]);
  });

  it('handles a mutate (change) event and keeps parity with a fresh full discovery', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'original\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);
    const before = adapter.getManifest();

    writeFile(workspacePath, 'src/a.md', 'mutated content\n');
    const result = await adapter.applyBatch([change('change', 'src/a.md')]);

    expect(result.eligibleChanges.map((c) => c.path)).toEqual(['src/a.md']);
    expect(result.manifest.generation_fingerprint).not.toBe(before.generation_fingerprint);

    const full = await produceDiscoveryManifest({ workspacePath });
    expect(stripGeneratedAt(result.manifest)).toEqual(stripGeneratedAt(full));
  });

  it('refreshes the manifest when the batch edits .gitignore itself, re-evaluating existing files against the new rules', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, '.gitignore', '*.md\n');
    writeFile(workspacePath, 'debug.md', 'debug\n');
    writeFile(workspacePath, 'keep.md', 'keep\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);
    expect(adapter.getManifest().files.map((f) => f.path)).not.toContain('keep.md');

    fs.writeFileSync(path.join(workspacePath, '.gitignore'), ['*.md', '!keep.md'].join('\n'), 'utf-8');
    const result = await adapter.applyBatch([change('change', '.gitignore')]);

    expect(result.refreshed).toBe(true);
    expect(result.manifest.files.map((f) => f.path)).toContain('keep.md');
    expect(result.manifest.files.map((f) => f.path)).not.toContain('debug.md');

    const full = await produceDiscoveryManifest({ workspacePath });
    expect(stripGeneratedAt(result.manifest)).toEqual(stripGeneratedAt(full));
  });

  it('keeps exact path-set and generation-fingerprint parity across a mixed add/change/unlink batch', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.md', 'a\n');
    writeFile(workspacePath, 'src/b.md', 'b\n');
    const adapter = await createWatcherDiscoveryAdapter(workspacePath);

    writeFile(workspacePath, 'src/a.md', 'a mutated\n');
    fs.rmSync(path.join(workspacePath, 'src', 'b.md'));
    writeFile(workspacePath, 'src/c.md', 'c\n');

    const result = await adapter.applyBatch([
      change('change', 'src/a.md'),
      change('unlink', 'src/b.md'),
      change('add', 'src/c.md'),
    ]);

    expect(result.eligibleChanges.map((c) => c.path).sort()).toEqual(['src/a.md', 'src/b.md', 'src/c.md']);

    const full = await produceDiscoveryManifest({ workspacePath });
    expect(stripGeneratedAt(result.manifest)).toEqual(stripGeneratedAt(full));
  });
});
