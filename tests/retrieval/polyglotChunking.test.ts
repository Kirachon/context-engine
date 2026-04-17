import { describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import {
  createTreeSitterChunkParser,
  listSupportedTreeSitterLanguages,
  type TreeSitterRuntime,
} from '../../src/internal/retrieval/treeSitterChunkParser.js';
import { splitIntoChunks } from '../../src/internal/retrieval/chunking.js';

const nodeRequire = createRequire(import.meta.url);

const POLYGLOT_GRAMMAR_PACKAGES = {
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  csharp: 'tree-sitter-c-sharp',
} as const;

function isOptionalDependencyInstalled(packageName: string): boolean {
  try {
    nodeRequire.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

interface LanguageCase {
  id: 'python' | 'go' | 'rust' | 'java' | 'csharp';
  extension: string;
  source: string;
}

const LANGUAGE_CASES: LanguageCase[] = [
  {
    id: 'python',
    extension: 'py',
    source: [
      'def greet(name):',
      '    return f"hello {name}"',
      '',
      'class Greeter:',
      '    def __init__(self, name):',
      '        self.name = name',
      '',
      '    def greet(self):',
      '        return greet(self.name)',
      '',
    ].join('\n'),
  },
  {
    id: 'go',
    extension: 'go',
    source: [
      'package main',
      '',
      'import "fmt"',
      '',
      'type Greeter struct {',
      '    Name string',
      '}',
      '',
      'func (g Greeter) Greet() string {',
      '    return fmt.Sprintf("hello %s", g.Name)',
      '}',
      '',
      'func main() {',
      '    fmt.Println(Greeter{Name: "world"}.Greet())',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'rust',
    extension: 'rs',
    source: [
      'pub struct Greeter {',
      '    pub name: String,',
      '}',
      '',
      'impl Greeter {',
      '    pub fn new(name: &str) -> Self {',
      '        Self { name: name.to_string() }',
      '    }',
      '',
      '    pub fn greet(&self) -> String {',
      '        format!("hello {}", self.name)',
      '    }',
      '}',
      '',
      'fn main() {',
      '    println!("{}", Greeter::new("world").greet());',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'java',
    extension: 'java',
    source: [
      'package example;',
      '',
      'public class Greeter {',
      '    private final String name;',
      '',
      '    public Greeter(String name) {',
      '        this.name = name;',
      '    }',
      '',
      '    public String greet() {',
      '        return "hello " + name;',
      '    }',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'csharp',
    extension: 'cs',
    source: [
      'namespace Example',
      '{',
      '    public class Greeter',
      '    {',
      '        private readonly string _name;',
      '',
      '        public Greeter(string name)',
      '        {',
      '            _name = name;',
      '        }',
      '',
      '        public string Greet()',
      '        {',
      '            return $"hello {_name}";',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  },
];

describe('polyglot tree-sitter chunking', () => {
  const supported = new Set(listSupportedTreeSitterLanguages());
  const parser = createTreeSitterChunkParser();

  for (const testCase of LANGUAGE_CASES) {
    const grammarPackage = POLYGLOT_GRAMMAR_PACKAGES[testCase.id];
    const installedDependency = isOptionalDependencyInstalled(grammarPackage);
    const canRun = Boolean(parser) && supported.has(testCase.id);
    const requireRuntime = installedDependency;
    const maybeIt = canRun ? it : requireRuntime ? it : it.skip;
    const label = canRun
      ? `produces at least one declaration chunk for ${testCase.id}`
      : requireRuntime
        ? `requires ${testCase.id} grammar at runtime when ${grammarPackage} is installed`
        : `skips ${testCase.id}: grammar package not installed`;

    maybeIt(label, () => {
      if (!canRun) {
        expect(parser).toBeTruthy();
        expect(supported.has(testCase.id)).toBe(true);
        return;
      }
      const filePath = `sample/sample.${testCase.extension}`;
      const chunks = parser!.parse(testCase.source, { path: filePath });
      expect(Array.isArray(chunks)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);

      const totalLines = testCase.source.split(/\r?\n/).length;
      for (const chunk of chunks) {
        expect(chunk.path).toBe(filePath);
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.endLine).toBeLessThanOrEqual(totalLines);
        expect(chunk.content.trim().length).toBeGreaterThan(0);
      }

      for (let index = 1; index < chunks.length; index += 1) {
        expect(chunks[index].startLine).toBeGreaterThanOrEqual(chunks[index - 1].startLine);
      }
    });
  }

  it('preserves TypeScript chunking behavior (regression)', () => {
    if (!parser || !supported.has('typescript')) {
      // eslint-disable-next-line no-console
      console.log('[polyglotChunking] skipping TS regression: typescript grammar unavailable');
      return;
    }
    const source = [
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
      'export const topLevel = true;',
    ].join('\n');

    const chunks = parser.parse(source, { path: 'src/example.ts' });
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].startLine).toBeGreaterThanOrEqual(chunks[index - 1].startLine);
    }
    expect(chunks.some((chunk) => chunk.content.includes('class Example'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('buildThing'))).toBe(true);
  });

  it('falls back without throwing when a polyglot grammar fails to load', () => {
    const fakeRuntime: TreeSitterRuntime = {
      Parser: class {
        setLanguage(): void {
          throw new Error('should not be reached because no python grammar is provided');
        }
        parse(): null {
          return null;
        }
      },
      typescript: {},
      tsx: {},
      languages: {
        // Intentionally omit 'python' to simulate a failed/missing grammar require.
        typescript: {},
        tsx: {},
      },
    };

    const isolatedParser = createTreeSitterChunkParser({ runtime: fakeRuntime });
    expect(isolatedParser).not.toBeNull();

    const pySource = 'def greet():\n    return 1\n';
    const path = 'sample/sample.py';

    // Must not throw: graceful fallback to heuristic chunking.
    let result;
    expect(() => {
      result = isolatedParser!.parse(pySource, { path });
    }).not.toThrow();

    // Fallback produces the same output as the heuristic chunker would on its own,
    // so the tree-sitter path contributed no chunks of its own.
    expect(result).toEqual(splitIntoChunks(pySource, { path }));
  });
});
