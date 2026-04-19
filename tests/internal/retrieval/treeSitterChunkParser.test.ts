import { describe, expect, it } from '@jest/globals';
import { createTreeSitterChunkParser } from '../../../src/internal/retrieval/treeSitterChunkParser.js';
import { splitIntoChunks } from '../../../src/internal/retrieval/chunking.js';

type FakeNode = {
  type: string;
  isNamed: true;
  namedChildren: FakeNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};

function buildNode(
  type: string,
  startRow: number,
  endRow: number,
  namedChildren: FakeNode[] = []
): FakeNode {
  return {
    type,
    isNamed: true,
    namedChildren,
    startPosition: { row: startRow, column: 0 },
    endPosition: { row: endRow, column: 0 },
  };
}

function createFakeRuntime() {
  const rootNode = buildNode('program', 0, 12, [
    buildNode('export_statement', 0, 2, [
      buildNode('function_declaration', 0, 2),
    ]),
    buildNode('export_statement', 4, 8, [
      buildNode('class_declaration', 4, 8),
    ]),
    buildNode('lexical_declaration', 12, 12),
  ]);

  return {
    Parser: class {
      setLanguage(): void {
        // No-op for the fake runtime.
      }

      parse(): { rootNode: FakeNode } {
        return { rootNode };
      }
    },
    typescript: {},
    tsx: {},
  };
}

describe('tree-sitter chunk parser', () => {
  it('builds declaration chunks from a tree-sitter-like runtime', () => {
    const parser = createTreeSitterChunkParser({ runtime: createFakeRuntime() });

    expect(parser).not.toBeNull();
    expect(parser?.id).toBe('tree-sitter-typescript');
    expect(parser?.version).toBe(1);

    const chunks = parser?.parse(
      [
        'export function buildThing() {',
        '  return 1;',
        '}',
        '',
        'export class Example {',
        '  method() {',
        '    return 2;',
        '  }',
        '}',
        '',
        'const ignored = 1;',
        '',
        'const topLevel = true;',
      ].join('\n'),
      { path: 'src/example.ts' }
    ) ?? [];

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(expect.objectContaining({
      path: 'src/example.ts',
      chunkId: 'src/example.ts#L1-L3',
      lines: '1-3',
      kind: 'declaration',
      symbolName: 'buildThing',
      symbolKind: 'function',
      parserSource: 'tree-sitter-typescript',
      languageId: 'typescript',
    }));
    expect(chunks[1]).toEqual(expect.objectContaining({
      chunkId: 'src/example.ts#L5-L9',
      lines: '5-9',
      content: expect.stringContaining('class Example'),
      symbolName: 'Example',
      symbolKind: 'class',
      parserSource: 'tree-sitter-typescript',
      languageId: 'typescript',
    }));
    expect(chunks[2]).toEqual(expect.objectContaining({
      chunkId: 'src/example.ts#L13-L13',
      lines: '13-13',
      content: expect.stringContaining('topLevel'),
      symbolName: 'topLevel',
      parserSource: 'tree-sitter-typescript',
      languageId: 'typescript',
    }));
  });

  it('falls back to heuristic chunking for unsupported file types', () => {
    const parser = createTreeSitterChunkParser({ runtime: createFakeRuntime() });
    expect(parser).not.toBeNull();

    const markdown = [
      '# Overview',
      '',
      'Intro text.',
      '',
      '## Details',
      'More text.',
    ].join('\n');

    const actual = parser?.parse(markdown, { path: 'docs/example.md' }) ?? [];
    const expected = splitIntoChunks(markdown, { path: 'docs/example.md' });

    expect(actual).toEqual(expected);
  });
});
