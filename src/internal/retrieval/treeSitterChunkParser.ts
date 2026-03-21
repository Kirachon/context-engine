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

export interface TreeSitterRuntime {
  Parser: new () => {
    setLanguage: (language: unknown) => void;
    parse: (source: string) => TreeSitterTreeLike | null | undefined;
  };
  typescript: unknown;
  tsx: unknown;
}

export interface TreeSitterParserOptions {
  runtime?: TreeSitterRuntime | null;
}

const DECLARATION_NODE_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_statement',
]);

const WRAPPER_NODE_TYPES = new Set([
  'program',
  'export_statement',
  'ambient_declaration',
  'namespace_declaration',
  'module_declaration',
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function isSupportedSourcePath(pathValue: string): boolean {
  return /\.(c|m)?jsx?$/i.test(pathValue) || /\.(c|m)?tsx?$/i.test(pathValue);
}

function inferTreeSitterLanguage(pathValue: string, runtime: TreeSitterRuntime): unknown | null {
  if (/\.tsx?$/i.test(pathValue)) {
    return runtime.typescript;
  }
  if (/\.(jsx?|mjsx?|cjsx?)$/i.test(pathValue)) {
    return runtime.tsx ?? runtime.typescript;
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
  normalizedPath: string
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const seen = new Set<string>();

  const visit = (node: TreeSitterNodeLike): void => {
    const type = getNodeType(node);
    if (DECLARATION_NODE_TYPES.has(type)) {
      const chunk = makeChunkFromNode(node, sourceLines, normalizedPath);
      if (chunk && !seen.has(chunk.chunkId)) {
        seen.add(chunk.chunkId);
        chunks.push(chunk);
      }
      return;
    }

    if (!WRAPPER_NODE_TYPES.has(type)) {
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

function createTreeSitterRuntime(): TreeSitterRuntime | null {
  try {
    const require = createRequire(import.meta.url);
    const parserModule = require('tree-sitter') as Record<string, unknown>;
    const languageModule = require('tree-sitter-typescript') as Record<string, unknown>;
    const Parser = (parserModule.default ?? parserModule) as TreeSitterRuntime['Parser'];
    const defaultLanguageModule = (languageModule.default as Record<string, unknown> | undefined) ?? {};
    const typescript = languageModule.typescript ?? defaultLanguageModule.typescript ?? null;
    const tsx = languageModule.tsx ?? defaultLanguageModule.tsx ?? typescript;

    if (typeof Parser !== 'function' || !typescript || !tsx) {
      return null;
    }

    return { Parser, typescript, tsx };
  } catch {
    return null;
  }
}

export function createTreeSitterChunkParser(
  options?: TreeSitterParserOptions
): ChunkParser | null {
  const runtime = options?.runtime ?? createTreeSitterRuntime();
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
      if (!isSupportedSourcePath(normalizedPath)) {
        return heuristicFallback.parse(content, options);
      }

      const language = inferTreeSitterLanguage(normalizedPath, runtime);
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
        const chunks = collectTreeSitterChunks(rootNode, sourceLines, normalizedPath);
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
