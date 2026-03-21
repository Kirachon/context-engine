import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { createWorkspaceChunkSearchIndex } from '../../../src/internal/retrieval/chunkIndex.js';
import {
  createHeuristicChunkParser,
  splitIntoChunks,
} from '../../../src/internal/retrieval/chunking.js';

type IndexStateFile = {
  files: Record<string, { hash: string; indexed_at: string }>;
};

function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-chunk-index-'));
}

function writeIndexState(workspacePath: string, files: IndexStateFile['files']): void {
  fs.writeFileSync(
    path.join(workspacePath, '.augment-index-state.json'),
    JSON.stringify({ files }, null, 2),
    'utf8'
  );
}

function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): void {
  const absolutePath = path.join(workspacePath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

describe('chunking', () => {
  it('exposes a stable heuristic parser identity for future parser swaps', () => {
    const parser = createHeuristicChunkParser();

    expect(parser).toEqual(expect.objectContaining({
      id: 'heuristic-boundary',
      version: 1,
    }));
    expect(parser.parse('export const value = 1;', { path: 'src/sample.ts' })).toHaveLength(1);
  });

  it('splits markdown headings and code declarations into stable chunks', () => {
    const chunks = splitIntoChunks(
      [
        '# Overview',
        '',
        'Intro text.',
        '',
        'export function buildThing() {',
        '  return 1;',
        '}',
        '',
        'class Example {',
        '  render() {',
        '    return 2;',
        '  }',
        '}',
      ].join('\n'),
      { path: 'src/example.ts', maxChunkLines: 20, maxChunkChars: 500 }
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      chunkId: 'src/example.ts#L1-L4',
      lines: '1-4',
      kind: 'heading',
    });
    expect(chunks[1]).toMatchObject({
      chunkId: 'src/example.ts#L5-L8',
      lines: '5-8',
      kind: 'declaration',
    });
    expect(chunks[2]).toMatchObject({
      chunkId: 'src/example.ts#L9-L13',
      lines: '9-13',
      kind: 'declaration',
    });
    expect(chunks[1].content).toContain('buildThing');
    expect(chunks[2].content).toContain('class Example');
  });
});

describe('workspace chunk search index', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reuses unchanged file chunks on refresh and only rebuilds changed files', async () => {
    tempDir = createTempWorkspace();

    writeWorkspaceFile(
      tempDir,
      'src/a.ts',
      [
        'export function alpha() {',
        '  return "one";',
        '}',
      ].join('\n')
    );
    writeWorkspaceFile(
      tempDir,
      'src/b.ts',
      [
        'export function beta() {',
        '  return "two";',
        '}',
      ].join('\n')
    );

    writeIndexState(tempDir, {
      'src/a.ts': { hash: 'hash-a-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
      'src/b.ts': { hash: 'hash-b-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const index = createWorkspaceChunkSearchIndex({ workspacePath: tempDir });

    const first = await index.refresh();
    expect(first).toMatchObject({
      refreshedFiles: 2,
      reusedFiles: 0,
      removedFiles: 0,
      totalFiles: 2,
      wroteIndex: true,
    });
    expect(first.totalChunks).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tempDir, '.augment-chunk-index.json'))).toBe(true);

    const snapshot = index.getSnapshot();
    expect(snapshot).toMatchObject({
      fileCount: 2,
      parser: { id: 'heuristic-boundary', version: 1 },
    });
    expect(snapshot.workspaceFingerprint).toMatch(/^[a-f0-9]{16}$/);

    const second = await index.refresh();
    expect(second).toMatchObject({
      refreshedFiles: 0,
      reusedFiles: 2,
      removedFiles: 0,
      totalFiles: 2,
    });
    expect(second.totalChunks).toBeGreaterThan(0);

    writeWorkspaceFile(
      tempDir,
      'src/a.ts',
      [
        'export function alpha() {',
        '  return "changed";',
        '}',
      ].join('\n')
    );
    writeIndexState(tempDir, {
      'src/a.ts': { hash: 'hash-a-v2', indexed_at: '2026-03-21T00:01:00.000Z' },
      'src/b.ts': { hash: 'hash-b-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const third = await index.refresh();
    expect(third).toMatchObject({
      refreshedFiles: 1,
      reusedFiles: 1,
      removedFiles: 0,
      totalFiles: 2,
      wroteIndex: true,
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.augment-chunk-index.json'), 'utf8')
    ) as {
      docs: Record<string, { chunks: Array<{ content: string }> }>;
      parser: { id: string; version: number };
      workspaceFingerprint: string;
    };
    expect(persisted.parser).toEqual({ id: 'heuristic-boundary', version: 1 });
    expect(persisted.workspaceFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(Object.keys(persisted.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(persisted.docs['src/a.ts'].chunks.some((chunk) => chunk.content.includes('changed'))).toBe(true);
  });

  it('uses an injected parser factory and persists parser metadata', async () => {
    tempDir = createTempWorkspace();

    writeWorkspaceFile(
      tempDir,
      'src/tree.ts',
      [
        'export function treeMatch() {',
        '  return "tree target";',
        '}',
      ].join('\n')
    );

    writeIndexState(tempDir, {
      'src/tree.ts': { hash: 'hash-tree-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const fakeParser = {
      id: 'tree-sitter-typescript',
      version: 1,
      parse: (content: string, options: { path: string }) => [{
        chunkId: `${options.path}#L1-L3`,
        path: options.path,
        kind: 'declaration' as const,
        startLine: 1,
        endLine: 3,
        lines: '1-3',
        content,
        tokenCount: 4,
      }],
    };

    const index = createWorkspaceChunkSearchIndex({
      workspacePath: tempDir,
      chunkParserFactory: () => fakeParser,
    });

    await index.refresh();

    const snapshot = index.getSnapshot();
    expect(snapshot.parser).toEqual({ id: 'tree-sitter-typescript', version: 1 });

    const results = await index.search('tree target', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      path: 'src/tree.ts',
      chunkId: 'src/tree.ts#L1-L3',
      lines: '1-3',
    }));

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.augment-chunk-index.json'), 'utf8')
    ) as {
      parser: { id: string; version: number };
      docs: Record<string, unknown>;
    };
    expect(persisted.parser).toEqual({ id: 'tree-sitter-typescript', version: 1 });
    expect(Object.keys(persisted.docs)).toEqual(['src/tree.ts']);
  });

  it('ranks exact chunk matches first and includes chunk metadata', async () => {
    tempDir = createTempWorkspace();

    writeWorkspaceFile(
      tempDir,
      'src/needle.ts',
      [
        'export function exactMatch() {',
        '  return "needle target";',
        '}',
      ].join('\n')
    );
    writeWorkspaceFile(
      tempDir,
      'src/noise.ts',
      [
        'export function noisyMatch() {',
        '  const needle = "needle";',
        '  return needle + " and target in different places";',
        '}',
      ].join('\n')
    );

    writeIndexState(tempDir, {
      'src/needle.ts': { hash: 'hash-needle-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
      'src/noise.ts': { hash: 'hash-noise-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const index = createWorkspaceChunkSearchIndex({ workspacePath: tempDir });
    await index.refresh();

    const results = await index.search('needle target', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('src/needle.ts');
    expect(results[0].chunkId).toBeDefined();
    expect(results[0].lines).toMatch(/^\d+-\d+$/);
    expect(results[0].content).toContain('needle target');
    expect(results[0].relevanceScore ?? 0).toBeGreaterThan((results[1]?.relevanceScore ?? 0));
  });

  it('returns a tight snippet window around the best matching lines', async () => {
    tempDir = createTempWorkspace();

    writeWorkspaceFile(
      tempDir,
      'src/snippet.ts',
      [
        'export function snippetExample() {',
        '  const line01 = 1;',
        '  const line02 = 2;',
        '  const line03 = 3;',
        '  const line04 = 4;',
        '  const line05 = 5;',
        '  const line06 = 6;',
        '  const line07 = 7;',
        '  const line08 = 8;',
        '  const line09 = 9;',
        '  const line10 = 10;',
        '  const exact = "needle target";',
        '  const line12 = 12;',
        '  const line13 = 13;',
        '  const line14 = 14;',
        '  const line15 = 15;',
        '  const line16 = 16;',
        '  const line17 = 17;',
        '  const line18 = 18;',
        '  const line19 = 19;',
        '  return exact;',
        '}',
      ].join('\n')
    );

    writeIndexState(tempDir, {
      'src/snippet.ts': { hash: 'hash-snippet-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const index = createWorkspaceChunkSearchIndex({ workspacePath: tempDir });
    await index.refresh();

    const results = await index.search('needle target', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('src/snippet.ts');
    expect(results[0].lines).toBe('10-14');
    expect(results[0].content).toContain('needle target');
    expect(results[0].content).not.toContain('line01');
    expect(results[0].content).not.toContain('line19');
  });

  it('excludes artifact chunks for code-intent searches when artifacts are not included', async () => {
    tempDir = createTempWorkspace();

    writeWorkspaceFile(
      tempDir,
      'artifacts/generated.ts',
      [
        'export function exactArtifactNeedle() {',
        '  return true;',
        '}',
      ].join('\n')
    );
    writeWorkspaceFile(
      tempDir,
      'src/real.ts',
      [
        'export function exactArtifactNeedle() {',
        '  return true;',
        '}',
      ].join('\n')
    );

    writeIndexState(tempDir, {
      'artifacts/generated.ts': { hash: 'hash-artifact-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
      'src/real.ts': { hash: 'hash-real-v1', indexed_at: '2026-03-21T00:00:00.000Z' },
    });

    const index = createWorkspaceChunkSearchIndex({ workspacePath: tempDir });
    await index.refresh();

    const results = await index.search('exactArtifactNeedle', 5, {
      includeArtifacts: false,
      codeIntent: true,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('src/real.ts');
    expect(results.some((result) => result.path.startsWith('artifacts/'))).toBe(false);
  });
});
