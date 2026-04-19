export type ChunkKind = 'heading' | 'declaration' | 'paragraph' | 'tail';
export type ChunkParserSource = 'heuristic-boundary' | 'tree-sitter-typescript';

export interface ChunkRecord {
  chunkId: string;
  path: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  lines: string;
  content: string;
  tokenCount: number;
  symbolName?: string;
  symbolKind?: string;
  parentSymbol?: string;
  parserSource?: ChunkParserSource;
  languageId?: string;
}

export interface ChunkingOptions {
  path: string;
  maxChunkLines?: number;
  maxChunkChars?: number;
  overlapLines?: number;
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

export function inferChunkLanguageId(pathValue: string): string | undefined {
  if (/\.tsx$/i.test(pathValue)) return 'tsx';
  if (/\.(c|m)?ts$/i.test(pathValue)) return 'typescript';
  if (/\.jsx$/i.test(pathValue)) return 'jsx';
  if (/\.(c|m)?js$/i.test(pathValue)) return 'javascript';
  if (/\.py$/i.test(pathValue)) return 'python';
  if (/\.go$/i.test(pathValue)) return 'go';
  if (/\.rs$/i.test(pathValue)) return 'rust';
  if (/\.java$/i.test(pathValue)) return 'java';
  if (/\.cs$/i.test(pathValue)) return 'csharp';
  if (/\.md$/i.test(pathValue)) return 'markdown';
  if (/\.json$/i.test(pathValue)) return 'json';
  if (/\.(ya?ml)$/i.test(pathValue)) return 'yaml';
  return undefined;
}

function inferSymbolKindFromDeclarationLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const patterns: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
    [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/, 'function'],
    [/^(?:export\s+)?class\b/, 'class'],
    [/^(?:export\s+)?interface\b/, 'interface'],
    [/^(?:export\s+)?type\b/, 'type'],
    [/^(?:export\s+)?enum\b/, 'enum'],
    [/^(?:export\s+)?(?:const|let|var)\b/, (match) => match[0].trim().split(/\s+/).pop() ?? 'const'],
    [/^def\b/, 'function'],
    [/^class\b/, 'class'],
    [/^func\s+\([^)]*\)\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/, 'method'],
    [/^func\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/, 'function'],
    [/^(?:pub\s+)?fn\b/, 'function'],
    [/^(?:pub\s+)?struct\b/, 'struct'],
    [/^(?:pub\s+)?trait\b/, 'trait'],
    [/^(?:pub\s+)?impl\b/, 'impl'],
    [/^(?:public|private|protected|internal)?\s*(?:abstract\s+)?class\b/i, 'class'],
    [/^(?:public|private|protected|internal)?\s*interface\b/i, 'interface'],
    [/^(?:public|private|protected|internal)?\s*enum\b/i, 'enum'],
    [/^(?:public|private|protected|internal)?\s*(?:static\s+)?[A-Za-z_<>\[\],?]+\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/, 'method'],
  ];

  for (const [pattern, kind] of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return typeof kind === 'function' ? kind(match) : kind;
    }
  }

  return undefined;
}

function inferSymbolNameFromDeclarationLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const patterns = [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^(?:export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^def\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^func\s+\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:pub\s+)?impl\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:public|private|protected|internal)?\s*(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/i,
    /^(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)/i,
    /^(?:public|private|protected|internal)?\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)/i,
    /^(?:public|private|protected|internal)?\s*(?:static\s+)?[A-Za-z_<>\[\],?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export function extractDeclarationMetadata(
  content: string,
  languageId?: string,
  parserSource?: ChunkParserSource
): Pick<ChunkRecord, 'symbolName' | 'symbolKind' | 'parentSymbol' | 'parserSource' | 'languageId'> {
  const firstMeaningfulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';

  return {
    symbolName: inferSymbolNameFromDeclarationLine(firstMeaningfulLine),
    symbolKind: inferSymbolKindFromDeclarationLine(firstMeaningfulLine),
    parentSymbol: undefined,
    parserSource,
    languageId,
  };
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
  const languageId = inferChunkLanguageId(normalizedPath);

  const maxChunkLines = Math.max(1, Math.min(400, options.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES));
  const maxChunkChars = Math.max(64, Math.min(50_000, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS));
  const overlapLines = Math.max(0, Math.min(maxChunkLines - 1, Math.floor(options.overlapLines ?? 0)));
  const lines = content.split(/\r?\n/);
  const chunks: ChunkRecord[] = [];

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let bufferChars = 0;
  let bufferKind: ChunkKind = 'paragraph';

  const captureOverlapBuffer = (lineCount: number): { lines: string[]; startLine: number; kind: ChunkKind } | null => {
    if (lineCount <= 0 || buffer.length <= 1) {
      return null;
    }

    const overlapCount = Math.max(0, Math.min(lineCount, buffer.length - 1));
    if (overlapCount <= 0) {
      return null;
    }

    return {
      lines: buffer.slice(-overlapCount),
      startLine: Math.max(1, bufferStartLine + buffer.length - overlapCount),
      kind: bufferKind,
    };
  };

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
      ...(bufferKind === 'declaration'
        ? extractDeclarationMetadata(chunkContent, languageId, HEURISTIC_CHUNK_PARSER_ID)
        : {
            parserSource: HEURISTIC_CHUNK_PARSER_ID,
            languageId,
          }),
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
      const overlapSeed = exceedsSoftLimit ? captureOverlapBuffer(overlapLines) : null;
      flush(lineNumber - 1);
      if (overlapSeed) {
        buffer = overlapSeed.lines;
        bufferStartLine = overlapSeed.startLine;
        bufferChars = overlapSeed.lines.reduce((sum, overlapLine) => sum + overlapLine.length, 0);
        bufferKind = overlapSeed.kind;
      }
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
