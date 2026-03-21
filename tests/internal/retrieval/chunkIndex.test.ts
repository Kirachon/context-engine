import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { createWorkspaceChunkSearchIndex } from '../../../src/internal/retrieval/chunkIndex.js';
import { splitIntoChunks } from '../../../src/internal/retrieval/chunking.js';

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
    ) as { docs: Record<string, { chunks: Array<{ content: string }> }> };
    expect(Object.keys(persisted.docs).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(persisted.docs['src/a.ts'].chunks.some((chunk) => chunk.content.includes('changed'))).toBe(true);
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
