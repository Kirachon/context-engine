import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createDiscoveryManifestStore,
  DISCOVERY_MANIFEST_FILE_NAME,
  DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR,
  produceAndPersistDiscoveryManifest,
} from '../../../src/internal/discovery/discoveryManifestStore.js';
import { produceDiscoveryManifest } from '../../../src/internal/discovery/discoveryManifest.js';

describe('discoveryManifestStore', () => {
  const tempDirs: string[] = [];
  const originalEnvValue = process.env[DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR];

  beforeEach(() => {
    delete process.env[DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR];
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) fs.rmSync(next, { recursive: true, force: true });
    }
    if (originalEnvValue === undefined) {
      delete process.env[DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR];
    } else {
      process.env[DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR] = originalEnvValue;
    }
  });

  function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-discovery-store-'));
    tempDirs.push(dir);
    return dir;
  }

  it('returns null when no manifest has been persisted', () => {
    const workspacePath = createTempWorkspace();
    const store = createDiscoveryManifestStore(workspacePath);

    expect(store.load()).toBeNull();
  });

  it('round-trips a manifest through save/load', async () => {
    const workspacePath = createTempWorkspace();
    fs.mkdirSync(path.join(workspacePath, 'src'));
    fs.writeFileSync(path.join(workspacePath, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');

    const store = createDiscoveryManifestStore(workspacePath);
    const manifest = await produceDiscoveryManifest({ workspacePath });
    store.save(manifest);

    expect(store.getPath()).toBe(path.join(workspacePath, DISCOVERY_MANIFEST_FILE_NAME));
    expect(fs.existsSync(store.getPath())).toBe(true);
    expect(store.load()).toEqual(manifest);
  });

  it('returns null for a corrupt manifest file', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, DISCOVERY_MANIFEST_FILE_NAME), '{not-json', 'utf-8');

    const store = createDiscoveryManifestStore(workspacePath);
    expect(store.load()).toBeNull();
  });

  it('returns null for a manifest with an unsupported (future) schema version', () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(
      path.join(workspacePath, DISCOVERY_MANIFEST_FILE_NAME),
      JSON.stringify({
        manifest_version: 999,
        generated_at: new Date(0).toISOString(),
        workspace_fingerprint: 'x',
        schema_fingerprint: 'x',
        source_fingerprint: 'x',
        generation_fingerprint: 'x',
        roots: ['.'],
        file_count: 0,
        files: [],
      }),
      'utf-8'
    );

    const store = createDiscoveryManifestStore(workspacePath);
    expect(store.load()).toBeNull();
  });

  it('produces and persists a manifest by default', async () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, 'a.md'), 'a\n', 'utf-8');

    const result = await produceAndPersistDiscoveryManifest({ workspacePath });

    expect(result.disabled).toBe(false);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.files.map((f) => f.path)).toEqual(['a.md']);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('rollback lever: disables production and preserves the existing artifact untouched', async () => {
    const workspacePath = createTempWorkspace();
    fs.writeFileSync(path.join(workspacePath, 'a.md'), 'a\n', 'utf-8');

    const store = createDiscoveryManifestStore(workspacePath);
    const initial = await produceDiscoveryManifest({ workspacePath });
    store.save(initial);
    const persistedBytesBefore = fs.readFileSync(store.getPath(), 'utf-8');

    process.env[DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR] = 'true';

    fs.writeFileSync(path.join(workspacePath, 'b.md'), 'b\n', 'utf-8');
    const result = await produceAndPersistDiscoveryManifest({ workspacePath }, store);

    expect(result.disabled).toBe(true);
    expect(result.manifest).toBeNull();
    expect(fs.readFileSync(store.getPath(), 'utf-8')).toBe(persistedBytesBefore);
  });
});
