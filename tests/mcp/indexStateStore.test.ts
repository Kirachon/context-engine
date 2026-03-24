import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonIndexStateStore } from '../../src/mcp/indexStateStore.js';

describe('JsonIndexStateStore', () => {
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-store-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads neutral state files without provider metadata', () => {
    const workspace = makeTempDir();
    const statePath = path.join(workspace, '.context-engine-index-state.json');
    const legacyUpdatedAt = '2026-03-04T00:00:00.000Z';
    const legacyIndexedAt = '2026-03-03T00:00:00.000Z';

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 7,
        updated_at: legacyUpdatedAt,
        files: {
          'src/a.ts': {
            hash: 'abc123',
            indexed_at: legacyIndexedAt,
          },
        },
      }),
      'utf-8'
    );

    const store = new JsonIndexStateStore(workspace);
    const loaded = store.load();

    expect(loaded.version).toBe(7);
    expect(loaded.schema_version).toBe(1);
    expect(loaded.provider_id).toBe('local_native');
    expect(loaded.updated_at).toBe(legacyUpdatedAt);
    expect(loaded.files['src/a.ts']).toEqual({
      hash: 'abc123',
      indexed_at: legacyIndexedAt,
    });
  });

  it('loads legacy augment-named state files for compatibility', () => {
    const workspace = makeTempDir();
    const legacyStatePath = path.join(workspace, '.augment-index-state.json');
    const legacyUpdatedAt = '2026-03-04T00:00:00.000Z';
    const legacyIndexedAt = '2026-03-03T00:00:00.000Z';

    fs.writeFileSync(
      legacyStatePath,
      JSON.stringify({
        version: 8,
        updated_at: legacyUpdatedAt,
        files: {
          'src/legacy.ts': {
            hash: 'legacy123',
            indexed_at: legacyIndexedAt,
          },
        },
      }),
      'utf-8'
    );

    const store = new JsonIndexStateStore(workspace);
    const loaded = store.load();

    expect(loaded.version).toBe(8);
    expect(loaded.schema_version).toBe(1);
    expect(loaded.provider_id).toBe('local_native');
    expect(loaded.updated_at).toBe(legacyUpdatedAt);
    expect(loaded.files['src/legacy.ts']).toEqual({
      hash: 'legacy123',
      indexed_at: legacyIndexedAt,
    });
  });

  it('persists provider metadata for callers using legacy save shape', () => {
    const workspace = makeTempDir();
    const store = new JsonIndexStateStore(workspace);

    store.save({
      version: 2,
      updated_at: '2026-03-04T01:00:00.000Z',
      files: {
        'src/b.ts': {
          hash: 'def456',
          indexed_at: '2026-03-04T01:00:00.000Z',
        },
      },
    });

    const statePath = path.join(workspace, '.context-engine-index-state.json');
    expect(fs.existsSync(statePath)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      version: number;
      schema_version: number;
      provider_id: string;
      files: Record<string, { hash: string; indexed_at: string }>;
    };

    expect(persisted.version).toBe(2);
    expect(persisted.schema_version).toBe(2);
    expect(persisted.provider_id).toBe('local_native');
    expect(persisted.files['src/b.ts']).toEqual({
      hash: 'def456',
      indexed_at: '2026-03-04T01:00:00.000Z',
    });
  });

  it('fails safe with empty default state when schema_version is unsupported', () => {
    const workspace = makeTempDir();
    const statePath = path.join(workspace, '.context-engine-index-state.json');

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 99,
        schema_version: 999,
        provider_id: 'local_native',
        updated_at: '2026-03-04T02:00:00.000Z',
        files: {
          'src/c.ts': {
            hash: 'zzz999',
            indexed_at: '2026-03-04T02:00:00.000Z',
          },
        },
      }),
      'utf-8'
    );

    const store = new JsonIndexStateStore(workspace);
    const loaded = store.loadWithMetadata();

    expect(loaded.state.version).toBe(1);
    expect(loaded.state.schema_version).toBe(2);
    expect(loaded.state.provider_id).toBe('local_native');
    expect(loaded.state.files).toEqual({});
    expect(loaded.metadata.unsupported_schema_version).toBe(999);
    expect(loaded.metadata.warnings.length).toBeGreaterThan(0);
  });
});
