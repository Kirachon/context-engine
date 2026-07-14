import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeuristicChunkParser } from '../../../src/internal/retrieval/chunking.js';
import {
  createWorkspacePersistentGraphStore,
  GRAPH_ARTIFACT_DIRECTORY_NAME,
  GRAPH_METADATA_FILE_NAME,
  GRAPH_PERSISTED_HYDRATION_DISABLED_ENV_VAR,
  type GraphMetadataFile,
} from '../../../src/internal/graph/persistentGraphStore.js';
import { GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR } from '../../../src/internal/graph/discoveryAdapter.js';
import { produceDiscoveryManifest } from '../../../src/internal/discovery/discoveryManifest.js';

function stripTimestamp(metadata: GraphMetadataFile): Omit<GraphMetadataFile, 'updated_at'> {
  const { updated_at: _updatedAt, ...rest } = metadata;
  return rest;
}

describe('persistentGraphStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) {
        fs.rmSync(next, { recursive: true, force: true });
      }
    }
  });

  function createTempWorkspace(prefix: string): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  function createStore(workspacePath: string) {
    return createWorkspacePersistentGraphStore({
      workspacePath,
      chunkParserFactory: () => createHeuristicChunkParser(),
    });
  }

  it('persists a deterministic graph and reloads it after restart', async () => {
    const workspacePath = createTempWorkspace('ctx-graph-ready-');
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'helper.ts'),
      [
        'export function helper(name: string) {',
        "  return name.toUpperCase();",
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'main.ts'),
      [
        "import { helper } from './helper';",
        'export function run(value: string) {',
        '  return helper(value);',
        '}',
      ].join('\n'),
      'utf8'
    );

    const firstStore = createStore(workspacePath);
    const firstRefresh = await firstStore.refresh();

    expect(firstRefresh.rebuilt).toBe(true);
    expect(firstRefresh.metadata.graph_status).toBe('ready');
    expect(firstRefresh.metadata.files_indexed).toBe(2);
    expect(firstRefresh.metadata.symbols_count).toBeGreaterThan(0);
    expect(firstRefresh.metadata.edges_count).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME, 'graph.json'))).toBe(true);

    const reloadedStore = createStore(workspacePath);
    const secondRefresh = await reloadedStore.refresh();

    expect(secondRefresh.rebuilt).toBe(false);
    expect(secondRefresh.loaded_from_disk).toBe(true);
    expect(stripTimestamp(secondRefresh.metadata)).toEqual(stripTimestamp(firstRefresh.metadata));
  });

  it('rebuilds idempotently on unchanged files', async () => {
    const workspacePath = createTempWorkspace('ctx-graph-idempotent-');
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'nested.py'),
      [
        'class Example:',
        '    def run(self, value):',
        '        return value',
      ].join('\n'),
      'utf8'
    );

    const store = createStore(workspacePath);
    const first = await store.refresh({ forceRebuild: true });
    const firstGraph = store.getGraph();
    const second = await store.refresh({ forceRebuild: true });
    const secondGraph = store.getGraph();

    expect(stripTimestamp(second.metadata)).toEqual(stripTimestamp(first.metadata));
    expect(secondGraph).toEqual(firstGraph);
  });

  it('degrades cleanly for unsupported-language-only workspaces', async () => {
    const workspacePath = createTempWorkspace('ctx-graph-unsupported-');
    fs.writeFileSync(path.join(workspacePath, 'notes.md'), '# hello\n', 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'sample.rb'), 'puts "hello"\n', 'utf8');

    const store = createStore(workspacePath);
    const result = await store.refresh();

    expect(result.metadata.graph_status).toBe('degraded');
    expect(result.metadata.degraded_reason).toBe('graph_unsupported_language');
    expect(result.metadata.files_indexed).toBe(0);
    expect(result.metadata.unsupported_files).toBe(2);
  });

  it('recovers from corrupt metadata and payload artifacts', async () => {
    const workspacePath = createTempWorkspace('ctx-graph-corrupt-');
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'app.go'),
      [
        'package app',
        'func Run() string {',
        '  return "ok"',
        '}',
      ].join('\n'),
      'utf8'
    );

    const store = createStore(workspacePath);
    const first = await store.refresh();
    expect(first.metadata.graph_status).toBe('ready');

    fs.writeFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), '{bad json', 'utf8');
    fs.writeFileSync(path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME, 'graph.json'), '{bad json', 'utf8');

    const recovered = await createStore(workspacePath).refresh();
    expect(recovered.rebuilt).toBe(true);
    expect(recovered.metadata.graph_status).toBe('ready');
    expect(recovered.metadata.files_indexed).toBe(1);
  });

  it('clears only graph-local artifacts during rollback cleanup', async () => {
    const workspacePath = createTempWorkspace('ctx-graph-clear-');
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.context-engine-lancedb'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.context-engine-lexical-index.sqlite'), 'sqlite', 'utf8');
    fs.writeFileSync(path.join(workspacePath, '.context-engine-lancedb', 'keep.txt'), 'vector', 'utf8');
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'app.java'),
      [
        'class App {',
        '  String run() {',
        '    return "ok";',
        '  }',
        '}',
      ].join('\n'),
      'utf8'
    );

    const store = createStore(workspacePath);
    await store.refresh();
    await store.clear();

    expect(fs.existsSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.context-engine-lexical-index.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.context-engine-lancedb', 'keep.txt'))).toBe(true);
  });

  function writeIndexState(workspacePath: string, files: Record<string, string>): void {
    fs.writeFileSync(
      path.join(workspacePath, '.context-engine-index-state.json'),
      JSON.stringify({
        files: Object.fromEntries(
          Object.entries(files).map(([relativePath, hash]) => [
            relativePath,
            { hash, indexed_at: new Date().toISOString() },
          ])
        ),
      }),
      'utf8'
    );
  }

  describe('hydrate (C2a cold-start defensive load; C2b canonical-manifest-bound)', () => {
    it('hydrates a ready, validated artifact without rebuilding', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-ready-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'helper.ts'),
        ['export function helper() {', '  return 1;', '}'].join('\n'),
        'utf8'
      );
      writeIndexState(workspacePath, { 'src/helper.ts': 'hash-helper' });

      const builderStore = createStore(workspacePath);
      const built = await builderStore.refresh();
      expect(built.metadata.graph_status).toBe('ready');

      const coldStore = createStore(workspacePath);
      const hydrated = await coldStore.hydrate();

      expect(hydrated.loaded_from_disk).toBe(true);
      expect(hydrated.rebuilt).toBe(false);
      expect(hydrated.metadata.graph_status).toBe('ready');
      expect(hydrated.metadata.degraded_reason).toBeNull();
      expect(hydrated.metadata.manifest_generation_fingerprint).toEqual(
        built.metadata.manifest_generation_fingerprint
      );
      expect(typeof hydrated.metadata.manifest_generation_fingerprint).toBe('string');
      const coldGraph = coldStore.getGraph();
      expect(coldGraph).toEqual(builderStore.getGraph());
      // Fresh-process navigation (C2b acceptance): a valid persisted graph
      // resolves symbols directly from the hydrated payload, with no
      // heuristic fallback involved.
      expect(coldGraph?.symbols.length).toBeGreaterThan(0);
    });

    it('reports graph_missing without scanning the workspace when no artifacts are persisted', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-missing-');
      // A deeply nested, unreferenced tree that a broad fallback scan would
      // walk. hydrate() must short-circuit on the missing-artifact check
      // before ever looking at these files, so counts stay at zero and the
      // reported status/reason are deterministic regardless of tree shape.
      fs.mkdirSync(path.join(workspacePath, 'src', 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'lonely.ts'), 'export const x = 1;\n', 'utf8');
      fs.writeFileSync(path.join(workspacePath, 'src', 'nested', 'deep', 'other.ts'), 'export const y = 2;\n', 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('empty');
      expect(result.metadata.degraded_reason).toBe('graph_missing');
      expect(result.loaded_from_disk).toBe(false);
      expect(result.rebuilt).toBe(false);
      expect(result.metadata.files_indexed).toBe(0);
      expect(result.metadata.symbols_count).toBe(0);
      expect(fs.existsSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME))).toBe(false);
      expect(store.getGraph()).toBeNull();
    });

    it('reports graph_corrupt and refuses to serve when the metadata file is unparsable', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-corrupt-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'app.go'),
        ['package app', 'func Run() string {', '  return "ok"', '}'].join('\n'),
        'utf8'
      );
      writeIndexState(workspacePath, { 'src/app.go': 'hash-app' });

      await createStore(workspacePath).refresh();
      fs.writeFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), '{not valid json', 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.degraded_reason).toBe('graph_corrupt');
      expect(result.loaded_from_disk).toBe(false);
      expect(store.getGraph()).toBeNull();
    });

    it('reports graph_wrong_workspace when the artifact belongs to a different workspace fingerprint', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-wrong-ws-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.py'), 'def run():\n    return 1\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.py': 'hash-app' });

      await createStore(workspacePath).refresh();
      const metadataPath = path.join(workspacePath, GRAPH_METADATA_FILE_NAME);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as GraphMetadataFile;
      metadata.workspace_fingerprint = 'deadbeefdeadbeef';
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('rebuild_required');
      expect(result.metadata.degraded_reason).toBe('graph_wrong_workspace');
      expect(store.getGraph()).toBeNull();
    });

    it('reports graph_rebuild_required when the schema version no longer matches', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-wrong-schema-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'app.java'),
        ['class App {', '  String run() {', '    return "ok";', '  }', '}'].join('\n'),
        'utf8'
      );
      writeIndexState(workspacePath, { 'src/app.java': 'hash-app' });

      await createStore(workspacePath).refresh();
      const metadataPath = path.join(workspacePath, GRAPH_METADATA_FILE_NAME);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as GraphMetadataFile;
      metadata.schema_version = metadata.schema_version + 1;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('rebuild_required');
      expect(result.metadata.degraded_reason).toBe('graph_rebuild_required');
      expect(store.getGraph()).toBeNull();
    });

    it('reports graph_stale when the corpus/source fingerprint has moved on', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-stale-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.rs'), 'fn run() -> i32 {\n    1\n}\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.rs': 'hash-app-v1' });

      await createStore(workspacePath).refresh();
      // Only the index-state sidecar's claimed hash changes here; the file
      // on disk (and therefore the canonical manifest's generation
      // fingerprint) is untouched, so the C2b manifest-generation gate
      // still passes and this exercises the older sidecar-based check.
      writeIndexState(workspacePath, { 'src/app.rs': 'hash-app-v2' });

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('stale');
      expect(result.metadata.degraded_reason).toBe('graph_stale');
      expect(store.getGraph()).toBeNull();
    });

    it('remains degraded without opportunistic rebuild when there is no canonical corpus reference to validate against', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-no-canonical-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'src', 'app.cs'),
        ['class App {', '  string Run() {', '    return "ok";', '  }', '}'].join('\n'),
        'utf8'
      );
      writeIndexState(workspacePath, { 'src/app.cs': 'hash-app' });

      await createStore(workspacePath).refresh();
      // Removing the sidecar leaves no canonical corpus reference for the
      // *sidecar-based* staleness check, but the files on disk (and thus
      // the canonical manifest generation) are unchanged, so the C2b gate
      // above it still passes and this isolates the sidecar-only check.
      fs.unlinkSync(path.join(workspacePath, '.context-engine-index-state.json'));

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('stale');
      expect(result.metadata.degraded_reason).toBe('graph_stale');
      expect(result.rebuilt).toBe(false);
      expect(result.metadata.files_indexed).toBe(0);
      expect(store.getGraph()).toBeNull();
    });

    it('reports graph_excluded_path and refuses to serve payload records referencing excluded directories', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-excluded-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.ts': 'hash-app' });

      await createStore(workspacePath).refresh();
      const payloadFilePath = path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME, 'graph.json');
      const payload = JSON.parse(fs.readFileSync(payloadFilePath, 'utf8')) as {
        files: Array<{ id: string; path: string; hash: string; language: string }>;
      };
      payload.files.push({
        id: 'file:node_modules/pkg/index.js',
        path: 'node_modules/pkg/index.js',
        hash: 'tampered',
        language: 'typescript',
      });
      fs.writeFileSync(payloadFilePath, JSON.stringify(payload), 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.degraded_reason).toBe('graph_excluded_path');
      expect(store.getGraph()).toBeNull();
    });

    it('disables hydration explicitly via the rollback env var while leaving persisted artifacts untouched', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-disabled-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.ts': 'hash-app' });

      await createStore(workspacePath).refresh();

      const previous = process.env[GRAPH_PERSISTED_HYDRATION_DISABLED_ENV_VAR];
      process.env[GRAPH_PERSISTED_HYDRATION_DISABLED_ENV_VAR] = 'true';
      try {
        const store = createStore(workspacePath);
        const result = await store.hydrate();
        expect(result.metadata.degraded_reason).toBe('graph_hydration_disabled');
        expect(result.loaded_from_disk).toBe(false);
        expect(store.getGraph()).toBeNull();
      } finally {
        if (previous === undefined) {
          delete process.env[GRAPH_PERSISTED_HYDRATION_DISABLED_ENV_VAR];
        } else {
          process.env[GRAPH_PERSISTED_HYDRATION_DISABLED_ENV_VAR] = previous;
        }
      }

      expect(fs.existsSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME))).toBe(true);
    });

    it('reports graph_manifest_generation_mismatch when the canonical manifest has moved on since the artifact was built (C2b)', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-manifest-mismatch-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.ts': 'hash-app' });

      const built = await createStore(workspacePath).refresh();
      expect(built.metadata.graph_status).toBe('ready');
      expect(typeof built.metadata.manifest_generation_fingerprint).toBe('string');
      const metadataBefore = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');

      // A new eligible file lands on disk after the artifact was built.
      // The index-state sidecar still only claims the original file, so
      // the OLDER sidecar-based staleness check alone would not catch
      // this; only the canonical manifest (a real, current discovery
      // pass) reflects the new file and therefore a new generation.
      fs.writeFileSync(path.join(workspacePath, 'src', 'untracked.ts'), 'export const x = 1;\n', 'utf8');

      const store = createStore(workspacePath);
      const result = await store.hydrate();

      expect(result.metadata.graph_status).toBe('stale');
      expect(result.metadata.degraded_reason).toBe('graph_manifest_generation_mismatch');
      expect(result.loaded_from_disk).toBe(false);
      expect(result.rebuilt).toBe(false);
      expect(result.metadata.files_indexed).toBe(0);
      expect(store.getGraph()).toBeNull();
      // Never an opportunistic rebuild scan: the persisted artifact is
      // untouched, and the untracked file is never absorbed into a graph.
      const metadataAfter = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');
      expect(metadataAfter).toBe(metadataBefore);
    });

    it('reports graph_manifest_unavailable when the canonical discovery manifest rollback lever is set (C2b no-manifest case)', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-hydrate-manifest-unavailable-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.ts': 'hash-app' });

      const built = await createStore(workspacePath).refresh();
      expect(built.metadata.graph_status).toBe('ready');
      const metadataBefore = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');

      const previous = process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
      process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';
      try {
        const store = createStore(workspacePath);
        const result = await store.hydrate();

        expect(result.metadata.graph_status).toBe('degraded');
        expect(result.metadata.degraded_reason).toBe('graph_manifest_unavailable');
        expect(result.loaded_from_disk).toBe(false);
        expect(result.rebuilt).toBe(false);
        expect(store.getGraph()).toBeNull();
      } finally {
        if (previous === undefined) {
          delete process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
        } else {
          process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = previous;
        }
      }

      const metadataAfter = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');
      expect(metadataAfter).toBe(metadataBefore);
    });
  });

  describe('refresh source binding (R3b3 canonical discovery manifest adoption)', () => {
    it('binds a from-scratch build to exactly the canonical discovery manifest path set', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-manifest-bound-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      // Eligible extension, but under a hard-excluded canonical directory --
      // a from-scratch build must never invent this path into the corpus.
      fs.writeFileSync(path.join(workspacePath, 'node_modules', 'pkg', 'index.ts'), 'export const v = 1;\n', 'utf8');

      const manifest = await produceDiscoveryManifest({ workspacePath });
      const store = createStore(workspacePath);
      const result = await store.refresh();
      const graph = store.getGraph();

      expect(result.metadata.graph_status).toBe('ready');
      expect(result.metadata.files_indexed).toBe(1);
      expect(graph?.files.map((file) => file.path).sort()).toEqual(
        manifest.files.map((file) => file.path).sort()
      );
      expect(graph?.files.map((file) => file.path)).toEqual(['src/app.ts']);
    });

    it('excludes a .gitignore-matched path from the corpus, matching a full discovery pass', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-manifest-gitignore-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'ignored.ts\n', 'utf8');
      // Eligible extension, but excluded by the .gitignore rule above -- a
      // from-scratch build must agree with a full discovery pass and never
      // invent this path into the corpus.
      fs.writeFileSync(path.join(workspacePath, 'ignored.ts'), 'export const ignored = 1;\n', 'utf8');

      const manifest = await produceDiscoveryManifest({ workspacePath });
      expect(manifest.files.map((file) => file.path).sort()).toEqual(['.gitignore', 'src/app.ts']);

      const store = createStore(workspacePath);
      const result = await store.refresh();
      const graph = store.getGraph();

      // `.gitignore` is a canonically eligible path (so it is part of the
      // considered corpus) but has no supported graph language, hence
      // unsupported rather than indexed; `ignored.ts` never enters the
      // corpus at all.
      expect(result.metadata.files_indexed).toBe(1);
      expect(result.metadata.unsupported_files).toBe(1);
      expect(graph?.files.map((file) => file.path)).toEqual(['src/app.ts']);
    });

    it('narrows an explicit indexedFiles entry that points outside the canonical manifest', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-manifest-narrow-explicit-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      fs.writeFileSync(path.join(workspacePath, 'node_modules', 'pkg', 'index.ts'), 'export const v = 1;\n', 'utf8');

      const store = createStore(workspacePath);
      const result = await store.refresh({
        indexedFiles: {
          'src/app.ts': { hash: 'hash-app' },
          'node_modules/pkg/index.ts': { hash: 'hash-vendor' },
        },
      });
      const graph = store.getGraph();

      expect(result.metadata.files_indexed).toBe(1);
      expect(graph?.files.map((file) => file.path)).toEqual(['src/app.ts']);
    });

    it('narrows an index-state sidecar entry that points outside the canonical manifest', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-manifest-narrow-index-state-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');
      fs.writeFileSync(path.join(workspacePath, 'dist', 'app.js'), 'exports.run = function () { return 1; };\n', 'utf8');
      writeIndexState(workspacePath, { 'src/app.ts': 'hash-app', 'dist/app.js': 'hash-dist' });

      const store = createStore(workspacePath);
      const result = await store.refresh();
      const graph = store.getGraph();

      expect(result.metadata.files_indexed).toBe(1);
      expect(graph?.files.map((file) => file.path)).toEqual(['src/app.ts']);
    });

    it('reports graph_manifest_unavailable and never scans when the rollback lever is set', async () => {
      const workspacePath = createTempWorkspace('ctx-graph-manifest-disabled-');
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export function run() {\n  return 1;\n}\n', 'utf8');

      const seeded = await createStore(workspacePath).refresh();
      expect(seeded.metadata.graph_status).toBe('ready');
      const metadataBefore = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');

      const previous = process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
      process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = 'true';
      try {
        // A stray, unreferenced file that a broad fallback scan would pick
        // up. refresh() must stay degraded instead of opportunistically
        // rebuilding around it.
        fs.writeFileSync(path.join(workspacePath, 'src', 'untracked.ts'), 'export const x = 1;\n', 'utf8');

        const store = createStore(workspacePath);
        const result = await store.refresh();

        expect(result.metadata.graph_status).toBe('degraded');
        expect(result.metadata.degraded_reason).toBe('graph_manifest_unavailable');
        expect(result.rebuilt).toBe(false);
        expect(result.loaded_from_disk).toBe(false);
        expect(result.metadata.files_indexed).toBe(0);
        expect(store.getGraph()).toBeNull();
      } finally {
        if (previous === undefined) {
          delete process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR];
        } else {
          process.env[GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR] = previous;
        }
      }

      const metadataAfter = fs.readFileSync(path.join(workspacePath, GRAPH_METADATA_FILE_NAME), 'utf8');
      expect(metadataAfter).toBe(metadataBefore);
    });
  });
});
