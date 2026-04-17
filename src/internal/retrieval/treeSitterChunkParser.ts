import { createRequire } from 'module';
import * as path from 'path';
import {
  createHeuristicChunkParser,
  splitIntoChunks,
  type ChunkParser,
  type ChunkRecord,
  type ChunkingOptions,
} from './chunking.js';

export const TREE_SITTER_CHUNK_PARSER_ID = 'tree-sitter-typescript';
export const TREE_SITTER_CHUNK_PARSER_VERSION = 1;

export interface TreeSitterNodeLike {
  type?: string;
  kind?: string;
  isNamed?: boolean;
  namedChildren?: TreeSitterNodeLike[];
  children?: TreeSitterNodeLike[];
  childCount?: number;
  child?: (index: number) => TreeSitterNodeLike | null;
  childForFieldName?: (name: string) => TreeSitterNodeLike | null;
  parent?: TreeSitterNodeLike | null;
  startIndex?: number;
  endIndex?: number;
  startPosition?: { row: number; column: number };
  endPosition?: { row: number; column: number };
}

export interface TreeSitterTreeLike {
  rootNode?: TreeSitterNodeLike;
}

export type TreeSitterLanguageId =
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp';

export interface TreeSitterRuntime {
  Parser: new () => {
    setLanguage: (language: unknown) => void;
    parse: (source: string) => TreeSitterTreeLike | null | undefined;
  };
  typescript: unknown;
  tsx: unknown;
  languages?: Partial<Record<TreeSitterLanguageId, unknown>>;
}

export interface TreeSitterParserOptions {
  runtime?: TreeSitterRuntime | null;
}

interface LanguageConfig {
  declarations: Set<string>;
  wrappers: Set<string>;
}

const TS_DECLARATIONS = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_statement',
]);

const TS_WRAPPERS = new Set([
  'program',
  'export_statement',
  'ambient_declaration',
  'namespace_declaration',
  'module_declaration',
]);

const LANGUAGE_CONFIGS: Record<TreeSitterLanguageId, LanguageConfig> = {
  typescript: { declarations: TS_DECLARATIONS, wrappers: TS_WRAPPERS },
  tsx: { declarations: TS_DECLARATIONS, wrappers: TS_WRAPPERS },
  python: {
    declarations: new Set([
      'function_definition',
      'class_definition',
      'decorated_definition',
    ]),
    wrappers: new Set(['module']),
  },
  go: {
    declarations: new Set([
      'function_declaration',
      'method_declaration',
      'type_declaration',
    ]),
    wrappers: new Set(['source_file']),
  },
  rust: {
    declarations: new Set([
      'function_item',
      'struct_item',
      'enum_item',
      'union_item',
      'impl_item',
      'trait_item',
      'mod_item',
      'type_item',
      'const_item',
      'static_item',
      'macro_definition',
    ]),
    wrappers: new Set(['source_file']),
  },
  java: {
    declarations: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'annotation_type_declaration',
      'method_declaration',
      'constructor_declaration',
    ]),
    wrappers: new Set(['program']),
  },
  csharp: {
    declarations: new Set([
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
      'delegate_declaration',
      'method_declaration',
      'constructor_declaration',
    ]),
    wrappers: new Set([
      'compilation_unit',
      'namespace_declaration',
      'file_scoped_namespace_declaration',
      'declaration_list',
    ]),
  },
};

type PolyglotLanguageId = Exclude<TreeSitterLanguageId, 'typescript' | 'tsx'>;

const POLYGLOT_LANGUAGE_IDS: readonly PolyglotLanguageId[] = [
  'python',
  'go',
  'rust',
  'java',
  'csharp',
];

const POLYGLOT_GRAMMAR_MODULES: Record<PolyglotLanguageId, string> = {
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  csharp: 'tree-sitter-c-sharp',
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function inferLanguageId(pathValue: string): TreeSitterLanguageId | null {
  if (/\.tsx$/i.test(pathValue)) return 'tsx';
  if (/\.(c|m)?ts$/i.test(pathValue)) return 'typescript';
  if (/\.(c|m)?jsx?$/i.test(pathValue)) return 'tsx';
  if (/\.py$/i.test(pathValue)) return 'python';
  if (/\.go$/i.test(pathValue)) return 'go';
  if (/\.rs$/i.test(pathValue)) return 'rust';
  if (/\.java$/i.test(pathValue)) return 'java';
  if (/\.cs$/i.test(pathValue)) return 'csharp';
  return null;
}

function resolveLanguageGrammar(
  runtime: TreeSitterRuntime,
  languageId: TreeSitterLanguageId
): unknown | null {
  const fromMap = runtime.languages?.[languageId];
  if (fromMap) {
    return fromMap;
  }
  if (languageId === 'typescript') {
    return runtime.typescript ?? null;
  }
  if (languageId === 'tsx') {
    return runtime.tsx ?? runtime.typescript ?? null;
  }
  return null;
}

function estimateTokenCount(text: string): number {
  return Math.max(
    1,
    text
      .trim()
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter(Boolean).length
  );
}

function getNodeType(node: TreeSitterNodeLike): string {
  return String(node.type ?? node.kind ?? '').trim();
}

function getNodeChildren(node: TreeSitterNodeLike): TreeSitterNodeLike[] {
  if (Array.isArray(node.namedChildren) && node.namedChildren.length > 0) {
    return node.namedChildren.filter(Boolean);
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    return node.children.filter(Boolean);
  }
  if (typeof node.childCount === 'number' && typeof node.child === 'function') {
    const children: TreeSitterNodeLike[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) {
        children.push(child);
      }
    }
    return children;
  }
  return [];
}

function getNodeRange(node: TreeSitterNodeLike): { startLine: number; endLine: number } | null {
  const startPosition = node.startPosition;
  const endPosition = node.endPosition;
  if (startPosition && endPosition) {
    const startLine = Math.max(1, startPosition.row + 1);
    const endLine = Math.max(startLine, endPosition.row + 1);
    return { startLine, endLine };
  }
  return null;
}

function buildChunkId(pathValue: string, startLine: number, endLine: number): string {
  return `${pathValue}#L${startLine}-L${endLine}`;
}

function makeChunkFromNode(
  node: TreeSitterNodeLike,
  sourceLines: string[],
  normalizedPath: string
): ChunkRecord | null {
  const range = getNodeRange(node);
  if (!range) {
    return null;
  }

  const startIndex = Math.max(0, range.startLine - 1);
  const endIndex = Math.min(sourceLines.length - 1, range.endLine - 1);
  if (endIndex < startIndex) {
    return null;
  }

  const content = sourceLines.slice(startIndex, endIndex + 1).join('\n').trimEnd();
  if (!content.trim()) {
    return null;
  }

  return {
    chunkId: buildChunkId(normalizedPath, range.startLine, range.endLine),
    path: normalizedPath,
    kind: 'declaration',
    startLine: range.startLine,
    endLine: range.endLine,
    lines: `${range.startLine}-${range.endLine}`,
    content,
    tokenCount: estimateTokenCount(content),
  };
}

function collectTreeSitterChunks(
  rootNode: TreeSitterNodeLike,
  sourceLines: string[],
  normalizedPath: string,
  config: LanguageConfig = { declarations: TS_DECLARATIONS, wrappers: TS_WRAPPERS }
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const seen = new Set<string>();

  const visit = (node: TreeSitterNodeLike): void => {
    const type = getNodeType(node);
    if (config.declarations.has(type)) {
      const chunk = makeChunkFromNode(node, sourceLines, normalizedPath);
      if (chunk && !seen.has(chunk.chunkId)) {
        seen.add(chunk.chunkId);
        chunks.push(chunk);
      }
      return;
    }

    if (!config.wrappers.has(type)) {
      return;
    }

    for (const child of getNodeChildren(node)) {
      visit(child);
    }
  };

  visit(rootNode);

  return chunks.sort((a, b) => {
    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine;
    }
    if (a.endLine !== b.endLine) {
      return a.endLine - b.endLine;
    }
    return a.chunkId.localeCompare(b.chunkId);
  });
}

function tryRequire<T = unknown>(moduleId: string): T | null {
  try {
    const require = createRequire(import.meta.url);
    return require(moduleId) as T;
  } catch {
    return null;
  }
}

function extractDefault(mod: Record<string, unknown> | null): Record<string, unknown> {
  if (!mod) return {};
  const fallback = (mod.default as Record<string, unknown> | undefined) ?? undefined;
  return fallback ?? mod;
}

function loadPolyglotGrammar(languageId: PolyglotLanguageId): unknown | null {
  const moduleId = POLYGLOT_GRAMMAR_MODULES[languageId];
  const mod = tryRequire<Record<string, unknown>>(moduleId);
  if (!mod) return null;
  const resolved = extractDefault(mod);
  // Most grammar modules export the language directly as the module value.
  // Some (like tree-sitter-typescript) expose named fields, but polyglot
  // single-language packages are typically the language itself.
  if (resolved && typeof resolved === 'object' && 'nodeTypeInfo' in (resolved as object)) {
    return resolved;
  }
  if (mod && typeof mod === 'object' && 'nodeTypeInfo' in (mod as object)) {
    return mod;
  }
  // Fallback: return the default export or the module itself; tree-sitter
  // will throw at setLanguage time if invalid, which we catch below.
  return resolved ?? mod ?? null;
}

function createTreeSitterRuntime(): TreeSitterRuntime | null {
  const parserModule = tryRequire<Record<string, unknown>>('tree-sitter');
  const languageModule = tryRequire<Record<string, unknown>>('tree-sitter-typescript');
  if (!parserModule || !languageModule) {
    return null;
  }

  const Parser = (parserModule.default ?? parserModule) as TreeSitterRuntime['Parser'];
  const defaultLanguageModule = (languageModule.default as Record<string, unknown> | undefined) ?? {};
  const typescript = languageModule.typescript ?? defaultLanguageModule.typescript ?? null;
  const tsx = languageModule.tsx ?? defaultLanguageModule.tsx ?? typescript;

  if (typeof Parser !== 'function' || !typescript || !tsx) {
    return null;
  }

  const languages: Partial<Record<TreeSitterLanguageId, unknown>> = {
    typescript,
    tsx,
  };

  for (const languageId of POLYGLOT_LANGUAGE_IDS) {
    const grammar = loadPolyglotGrammar(languageId);
    if (grammar) {
      languages[languageId] = grammar;
    }
  }

  return { Parser, typescript, tsx, languages };
}

let cachedDefaultRuntime: TreeSitterRuntime | null | undefined;

function getDefaultRuntime(): TreeSitterRuntime | null {
  if (cachedDefaultRuntime === undefined) {
    cachedDefaultRuntime = createTreeSitterRuntime();
  }
  return cachedDefaultRuntime;
}

export function listSupportedTreeSitterLanguages(): string[] {
  const runtime = getDefaultRuntime();
  if (!runtime) return [];
  const ids: string[] = [];
  if (runtime.typescript) ids.push('typescript');
  if (runtime.tsx) ids.push('tsx');
  for (const languageId of POLYGLOT_LANGUAGE_IDS) {
    if (runtime.languages?.[languageId]) {
      ids.push(languageId);
    }
  }
  return ids;
}

export function createTreeSitterChunkParser(
  options?: TreeSitterParserOptions
): ChunkParser | null {
  const runtime = options?.runtime ?? getDefaultRuntime();
  if (!runtime) {
    return null;
  }

  const parser = new runtime.Parser();
  const heuristicFallback = createHeuristicChunkParser();

  return {
    id: TREE_SITTER_CHUNK_PARSER_ID,
    version: TREE_SITTER_CHUNK_PARSER_VERSION,
    parse: (content: string, options: ChunkingOptions) => {
      const normalizedPath = normalizePath(options.path);
      if (!normalizedPath || !content.trim()) {
        return [];
      }

      const languageId = inferLanguageId(normalizedPath);
      if (!languageId) {
        return heuristicFallback.parse(content, options);
      }

      const language = resolveLanguageGrammar(runtime, languageId);
      if (!language) {
        return heuristicFallback.parse(content, options);
      }

      try {
        parser.setLanguage(language);
        const tree = parser.parse(content);
        const rootNode = tree?.rootNode;
        if (!rootNode) {
          return heuristicFallback.parse(content, options);
        }

        const sourceLines = content.split(/\r?\n/);
        const config = LANGUAGE_CONFIGS[languageId];
        const chunks = collectTreeSitterChunks(rootNode, sourceLines, normalizedPath, config);
        if (chunks.length > 0) {
          return chunks;
        }
      } catch {
        // Fall back to heuristic chunking for unsupported or malformed syntax.
      }

      return splitIntoChunks(content, options);
    },
  };
}
