import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR,
  clearCanonicalWorkspaceManifestCache,
  filterIndexStateFilesToCanonicalManifest,
  isRetrievalDiscoveryManifestDisabled,
  resolveCanonicalWorkspaceManifest,
  resolveCanonicalWorkspacePathSet,
} from '../../../src/internal/retrieval/discoveryAdapter.js';
import { produceDiscoveryManifest } from '../../../src/internal/discovery/discoveryManifest.js';

describe('retrieval discoveryAdapter (R3b2)', () => {
  const tempDirs: string[] = [];

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-retrieval-discovery-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeFile(workspacePath: string, relativePath: string, contents: string): void {
    const fullPath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents, 'utf-8');
  }

  afterEach(() => {
    delete process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
    clearCanonicalWorkspaceManifestCache();
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  it('rollback lever: defaults to enabled and honors CE_RETRIEVAL_DISCOVERY_MANIFEST_DISABLED', () => {
    delete process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
    expect(isRetrievalDiscoveryManifestDisabled()).toBe(false);

    process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';
    expect(isRetrievalDiscoveryManifestDisabled()).toBe(true);
  });

  it('produces a manifest matching produceDiscoveryManifest exactly (path-set and fingerprint parity)', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    writeFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = true;\n');

    const resolved = await resolveCanonicalWorkspaceManifest({ workspacePath });
    const full = await produceDiscoveryManifest({ workspacePath });

    const { generated_at: _a, ...resolvedRest } = resolved;
    const { generated_at: _b, ...fullRest } = full;
    expect(resolvedRest).toEqual(fullRest);
    expect(resolved.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('reflects an add without staleness on the next resolution (no default TTL)', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');

    const before = await resolveCanonicalWorkspacePathSet({ workspacePath });
    expect(before && [...before].sort()).toEqual(['src/a.ts']);

    writeFile(workspacePath, 'src/b.ts', 'export const b = 2;\n');
    const afterAdd = await resolveCanonicalWorkspacePathSet({ workspacePath });
    expect(afterAdd && [...afterAdd].sort()).toEqual(['src/a.ts', 'src/b.ts']);

    fs.rmSync(path.join(workspacePath, 'src', 'a.ts'));
    const afterDelete = await resolveCanonicalWorkspacePathSet({ workspacePath });
    expect(afterDelete && [...afterDelete].sort()).toEqual(['src/b.ts']);
  });

  it('filterIndexStateFilesToCanonicalManifest drops a stale entry outside the canonical source set', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    // Eligible extension, but under a hard-excluded canonical directory
    // name that a narrower/legacy exclusion list might not know about.
    writeFile(workspacePath, 'vendor/pkg.ts', 'export const vendored = true;\n');

    const filtered = await filterIndexStateFilesToCanonicalManifest(workspacePath, {
      'src/a.ts': { hash: 'hash-a' },
      'vendor/pkg.ts': { hash: 'hash-vendor' },
      'does/not/exist.ts': { hash: 'hash-missing' },
    });

    expect(Object.keys(filtered).sort()).toEqual(['src/a.ts']);
    expect(filtered['src/a.ts']).toEqual({ hash: 'hash-a' });
  });

  it('filterIndexStateFilesToCanonicalManifest never expands beyond the caller-supplied entries', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    writeFile(workspacePath, 'src/b.ts', 'export const b = 2;\n');

    // Caller only claims src/a.ts; src/b.ts is canonically eligible too but
    // must never be added by the filter -- it only narrows, never widens.
    const filtered = await filterIndexStateFilesToCanonicalManifest(workspacePath, {
      'src/a.ts': { hash: 'hash-a' },
    });

    expect(Object.keys(filtered)).toEqual(['src/a.ts']);
  });

  it('rollback lever leaves the caller-supplied entries untouched (stale-artifact equality)', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');

    process.env[RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';

    const staleFiles = {
      'vendor/pkg.ts': { hash: 'hash-vendor' },
      'does/not/exist.ts': { hash: 'hash-missing' },
    };
    const filtered = await filterIndexStateFilesToCanonicalManifest(workspacePath, staleFiles);

    expect(filtered).toEqual(staleFiles);
    expect(await resolveCanonicalWorkspacePathSet({ workspacePath })).toBeNull();
  });

  it('de-duplicates concurrent in-flight resolutions into a single discovery pass', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');

    const [first, second, third] = await Promise.all([
      resolveCanonicalWorkspaceManifest({ workspacePath }),
      resolveCanonicalWorkspaceManifest({ workspacePath }),
      resolveCanonicalWorkspaceManifest({ workspacePath }),
    ]);

    expect(first.generation_fingerprint).toBe(second.generation_fingerprint);
    expect(first.generation_fingerprint).toBe(third.generation_fingerprint);
    expect(first.generated_at).toBe(second.generated_at);
    expect(first.generated_at).toBe(third.generated_at);
  });
});
