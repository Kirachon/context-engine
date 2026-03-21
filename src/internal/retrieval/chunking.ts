export type ChunkKind = 'heading' | 'declaration' | 'paragraph' | 'tail';

export interface ChunkRecord {
  chunkId: string;
  path: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  lines: string;
  content: string;
  tokenCount: number;
}

export interface ChunkingOptions {
  path: string;
  maxChunkLines?: number;
  maxChunkChars?: number;
}

export interface ChunkParser {
  id: string;
  version: number;
  parse: (content: string, options: ChunkingOptions) => ChunkRecord[];
}

const DEFAULT_MAX_CHUNK_LINES = 80;
const DEFAULT_MAX_CHUNK_CHARS = 4_000;
export const HEURISTIC_CHUNK_PARSER_ID = 'heuristic-boundary';
export const HEURISTIC_CHUNK_PARSER_VERSION = 1;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function estimateTokenCount(text: string): number {
  return Math.max(1, tokenize(text).length);
}

function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

function isDeclarationLine(line: string): boolean {
  return /^\s*(export\s+)?(async\s+)?(function|class|interface|type)\b/.test(line)
    || /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\()/.test(line)
    || /^\s*(export\s+)?default\s+(function|class)\b/.test(line);
}

function classifyLineKind(line: string): ChunkKind {
  if (isHeadingLine(line)) return 'heading';
  if (isDeclarationLine(line)) return 'declaration';
  return 'paragraph';
}

function buildChunkId(pathValue: string, startLine: number, endLine: number): string {
  return `${pathValue}#L${startLine}-L${endLine}`;
}

export function splitIntoChunks(content: string, options: ChunkingOptions): ChunkRecord[] {
  const normalizedPath = normalizePath(options.path);
  if (!normalizedPath || !content.trim()) {
    return [];
  }

  const maxChunkLines = Math.max(1, Math.min(400, options.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES));
  const maxChunkChars = Math.max(64, Math.min(50_000, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS));
  const lines = content.split(/\r?\n/);
  const chunks: ChunkRecord[] = [];

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let bufferChars = 0;
  let bufferKind: ChunkKind = 'paragraph';

  const flush = (endLine: number): void => {
    if (buffer.length === 0) {
      return;
    }

    const chunkContent = buffer.join('\n').trimEnd();
    if (!chunkContent.trim()) {
      buffer = [];
      bufferChars = 0;
      return;
    }

    const startLine = bufferStartLine;
    const chunkEndLine = Math.max(startLine, endLine);
    const pathValue = normalizedPath;
    chunks.push({
      chunkId: buildChunkId(pathValue, startLine, chunkEndLine),
      path: pathValue,
      kind: bufferKind,
      startLine,
      endLine: chunkEndLine,
      lines: `${startLine}-${chunkEndLine}`,
      content: chunkContent,
      tokenCount: estimateTokenCount(chunkContent),
    });

    buffer = [];
    bufferChars = 0;
    bufferKind = 'paragraph';
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const lineKind = classifyLineKind(line);
    const lineLength = line.length + (buffer.length > 0 ? 1 : 0);

    const startsNewSemanticChunk = lineKind !== 'paragraph' && buffer.length > 0;
    const exceedsSoftLimit = buffer.length > 0
      && (buffer.length >= maxChunkLines || (bufferChars + lineLength) > maxChunkChars);

    if (startsNewSemanticChunk || exceedsSoftLimit) {
      flush(lineNumber - 1);
    }

    if (buffer.length === 0) {
      bufferStartLine = lineNumber;
      bufferKind = lineKind;
    }

    buffer.push(line);
    bufferChars += line.length;
    if (bufferKind === 'paragraph' && lineKind !== 'paragraph') {
      bufferKind = lineKind;
    }
  }

  flush(lines.length);

  return chunks;
}

export function createHeuristicChunkParser(): ChunkParser {
  return {
    id: HEURISTIC_CHUNK_PARSER_ID,
    version: HEURISTIC_CHUNK_PARSER_VERSION,
    parse: (content: string, options: ChunkingOptions) => splitIntoChunks(content, options),
  };
}
