import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeuristicChunkParser } from '../../../src/internal/retrieval/chunking.js';
import {
  createWorkspacePersistentGraphStore,
  GRAPH_ARTIFACT_DIRECTORY_NAME,
  GRAPH_METADATA_FILE_NAME,
  type GraphMetadataFile,
} from '../../../src/internal/graph/persistentGraphStore.js';

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
});
