import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR,
  buildGraphCanonicalPathSet,
  filterToGraphCanonicalPathSet,
  isGraphDiscoveryManifestDisabled,
  resolveGraphCanonicalManifest,
} from '../../../src/internal/graph/discoveryAdapter.js';
import { produceDiscoveryManifest } from '../../../src/internal/discovery/discoveryManifest.js';

describe('graph discoveryAdapter (R3b3)', () => {
  const tempDirs: string[] = [];

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-graph-discovery-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeFile(workspacePath: string, relativePath: string, contents: string): void {
    const fullPath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents, 'utf-8');
  }

  afterEach(() => {
    delete process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
  });

  it('rollback lever: defaults to enabled and honors CE_GRAPH_DISCOVERY_MANIFEST_DISABLED', () => {
    delete process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
    expect(isGraphDiscoveryManifestDisabled()).toBe(false);

    process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';
    expect(isGraphDiscoveryManifestDisabled()).toBe(true);
  });

  it('produces a manifest matching produceDiscoveryManifest exactly (path-set and fingerprint parity)', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    writeFile(workspacePath, 'node_modules/pkg/index.js', 'module.exports = {};\n');

    const resolved = await resolveGraphCanonicalManifest({ workspacePath });
    const full = await produceDiscoveryManifest({ workspacePath });

    expect(resolved).not.toBeNull();
    const { generated_at: _a, ...resolvedRest } = resolved!;
    const { generated_at: _b, ...fullRest } = full;
    expect(resolvedRest).toEqual(fullRest);
    expect(resolved!.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('returns null (never scans) when the rollback lever is set', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');

    process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';

    expect(await resolveGraphCanonicalManifest({ workspacePath })).toBeNull();
  });

  it('buildGraphCanonicalPathSet mirrors the manifest file list exactly', async () => {
    const workspacePath = createTempWorkspace();
    writeFile(workspacePath, 'src/a.ts', 'export const a = 1;\n');
    writeFile(workspacePath, 'src/b.py', 'x = 1\n');

    const manifest = await resolveGraphCanonicalManifest({ workspacePath });
    const pathSet = buildGraphCanonicalPathSet(manifest!);

    expect([...pathSet].sort()).toEqual(['src/a.ts', 'src/b.py']);
  });

  it('filterToGraphCanonicalPathSet drops entries outside the canonical set without adding any', () => {
    const canonicalPaths = new Set(['src/a.ts', 'src/b.ts']);

    const filtered = filterToGraphCanonicalPathSet(
      {
        'src/a.ts': { hash: 'hash-a' },
        'node_modules/pkg/index.js': { hash: 'hash-vendor' },
        'does/not/exist.ts': { hash: 'hash-missing' },
      },
      canonicalPaths
    );

    expect(Object.keys(filtered)).toEqual(['src/a.ts']);
    expect(filtered['src/a.ts']).toEqual({ hash: 'hash-a' });
  });

  it('filterToGraphCanonicalPathSet normalizes backslash separators before matching', () => {
    const canonicalPaths = new Set(['src/nested/a.ts']);

    const filtered = filterToGraphCanonicalPathSet(
      {
        'src\\nested\\a.ts': { hash: 'hash-a' },
      },
      canonicalPaths
    );

    expect(Object.keys(filtered)).toEqual(['src/nested/a.ts']);
  });
});
