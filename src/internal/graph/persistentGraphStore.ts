import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { featureEnabled } from '../../config/features.js';
import {
  buildIndexStateWorkspaceFingerprint,
  hashIndexStateContent,
} from '../../mcp/indexStateStore.js';
import {
  createHeuristicChunkParser,
  inferChunkLanguageId,
  type ChunkParser,
  type ChunkRecord,
} from '../retrieval/chunking.js';
import { createTreeSitterChunkParser } from '../retrieval/treeSitterChunkParser.js';
import { snapshotRetrievalV2FeatureFlags, type RetrievalV2FeatureFlagsSnapshot } from '../retrieval/v2Contracts.js';

export const GRAPH_ARTIFACT_DIRECTORY_NAME = '.context-engine-graph';
export const GRAPH_METADATA_FILE_NAME = '.context-engine-graph-index.json';
export const GRAPH_PAYLOAD_FILE_NAME = 'graph.json';
export const GRAPH_ARTIFACT_SCHEMA_VERSION = 1;
export const GRAPH_ENGINE_VERSION = 'heuristic-symbol-graph-v1';
export const GRAPH_ARTIFACT_LAYOUT_VERSION = 1;

export type SupportedGraphLanguage =
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp';

export type GraphStatus = 'ready' | 'empty' | 'degraded' | 'stale' | 'rebuild_required';
export type GraphDegradedReason =
  | 'graph_unavailable'
  | 'graph_missing'
  | 'graph_stale'
  | 'graph_rebuild_required'
  | 'graph_unsupported_language'
  | 'graph_partial'
  | 'graph_corrupt';

export interface GraphFileRecord {
  id: string;
  path: string;
  hash: string;
  language: SupportedGraphLanguage;
}

export interface GraphSymbolRecord {
  id: string;
  file_id: string;
  path: string;
  name: string;
  kind: string;
  language: SupportedGraphLanguage;
  start_line: number;
  end_line: number;
  parser_source: string;
}

export interface GraphDefinitionRecord {
  id: string;
  symbol_id: string;
  path: string;
  language: SupportedGraphLanguage;
  start_line: number;
  end_line: number;
  confidence: number;
}

export interface GraphReferenceRecord {
  id: string;
  path: string;
  language: SupportedGraphLanguage;
  line: number;
  symbol_name: string;
  symbol_id: string | null;
  source_symbol_id: string | null;
  confidence: number;
}

export interface GraphImportRecord {
  id: string;
  path: string;
  language: SupportedGraphLanguage;
  line: number;
  source: string;
  imported_name: string | null;
  local_name: string | null;
}

export interface GraphContainmentRecord {
  id: string;
  parent_id: string;
  child_id: string;
  path: string;
  kind: 'file_symbol' | 'symbol_symbol';
}

export interface GraphCallEdgeRecord {
  id: string;
  path: string;
  language: SupportedGraphLanguage;
  line: number;
  source_symbol_id: string | null;
  target_symbol_id: string | null;
  target_symbol_name: string;
  confidence: number;
}

export interface GraphPayloadFile {
  version: number;
  schema_version: number;
  workspace_fingerprint: string;
  source_fingerprint: string;
  files: GraphFileRecord[];
  symbols: GraphSymbolRecord[];
  definitions: GraphDefinitionRecord[];
  references: GraphReferenceRecord[];
  imports: GraphImportRecord[];
  containments: GraphContainmentRecord[];
  call_edges: GraphCallEdgeRecord[];
}

export interface GraphMetadataFile {
  version: number;
  schema_version: number;
  graph_engine_version: string;
  updated_at: string;
  workspace_fingerprint: string;
  feature_flags_snapshot: RetrievalV2FeatureFlagsSnapshot;
  language_matrix: SupportedGraphLanguage[];
  artifact_layout_version: number;
  graph_status: GraphStatus;
  symbols_count: number;
  edges_count: number;
  files_indexed: number;
  unsupported_files: number;
  degraded_reason: GraphDegradedReason | null;
  source_fingerprint: string;
  payload_file: string;
}

export interface GraphRefreshResult {
  metadata: GraphMetadataFile;
  rebuilt: boolean;
  loaded_from_disk: boolean;
  warning: GraphDegradedReason | null;
}

export interface GraphStoreSnapshot extends GraphMetadataFile {
  payload_loaded: boolean;
}

export interface WorkspaceGraphStoreOptions {
  workspacePath: string;
  indexStatePath?: string;
  graphDirectoryPath?: string;
  graphMetadataPath?: string;
  chunkParserFactory?: () => ChunkParser | null;
  onWarning?: (message: string) => void;
}

export interface GraphRefreshOptions {
  forceRebuild?: boolean;
  indexedFiles?: Record<string, { hash: string; indexed_at?: string }>;
}

export interface WorkspacePersistentGraphStore {
  refresh: (options?: GraphRefreshOptions) => Promise<GraphRefreshResult>;
  getSnapshot: () => GraphStoreSnapshot;
  getGraph: () => GraphPayloadFile | null;
  clear: () => Promise<void>;
}

interface GraphSourceFile {
  path: string;
  hash: string;
  language: SupportedGraphLanguage | null;
}

const SUPPORTED_GRAPH_LANGUAGES: SupportedGraphLanguage[] = [
  'typescript',
  'tsx',
  'python',
  'go',
  'rust',
  'java',
  'csharp',
];

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  GRAPH_ARTIFACT_DIRECTORY_NAME,
  '.context-engine-lancedb',
  '.memories',
]);

function isArtifactLikeFile(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  return basename.startsWith('.context-engine-') || basename.startsWith('.augment-');
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim();
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, payload: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function stableHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function toSupportedGraphLanguage(pathValue: string): SupportedGraphLanguage | null {
  const languageId = inferChunkLanguageId(pathValue);
  if (!languageId) return null;
  return SUPPORTED_GRAPH_LANGUAGES.includes(languageId as SupportedGraphLanguage)
    ? languageId as SupportedGraphLanguage
    : null;
}

function buildGraphFileId(relativePath: string): string {
  return `file:${normalizePath(relativePath)}`;
}

function buildGraphSymbolId(symbol: Pick<GraphSymbolRecord, 'path' | 'name' | 'kind' | 'start_line' | 'end_line'>): string {
  return `symbol:${stableHash({
    path: normalizePath(symbol.path),
    name: symbol.name,
    kind: symbol.kind,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
  })}`;
}

function buildGraphEdgeId(prefix: string, payload: unknown): string {
  return `${prefix}:${stableHash(payload)}`;
}

function resolveChunkParser(options: WorkspaceGraphStoreOptions): ChunkParser {
  try {
    if (typeof options.chunkParserFactory === 'function') {
      const customParser = options.chunkParserFactory();
      if (customParser) {
        return customParser;
      }
    }
  } catch {
    // Fall through to runtime resolution.
  }

  if (featureEnabled('retrieval_tree_sitter_v1')) {
    const treeSitterParser = createTreeSitterChunkParser();
    if (treeSitterParser) {
      return treeSitterParser;
    }
  }

  return createHeuristicChunkParser();
}

function buildFeatureFlagsSnapshot(): RetrievalV2FeatureFlagsSnapshot {
  return snapshotRetrievalV2FeatureFlags();
}

function buildMetadataSourceFingerprint(
  sourceFiles: GraphSourceFile[],
  featureFlagsSnapshot: RetrievalV2FeatureFlagsSnapshot
): string {
  return stableHash({
    files: sourceFiles
      .map((file) => ({ path: file.path, hash: file.hash, language: file.language }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    featureFlagsSnapshot,
    graphEngineVersion: GRAPH_ENGINE_VERSION,
    languageMatrix: SUPPORTED_GRAPH_LANGUAGES,
  });
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedTargetPath = path.resolve(targetPath);
  return resolvedTargetPath === resolvedWorkspacePath || resolvedTargetPath.startsWith(`${resolvedWorkspacePath}${path.sep}`);
}

function listWorkspaceFiles(workspacePath: string, currentDir: string = workspacePath): string[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizePath(path.relative(workspacePath, absolutePath));
    if (!relativePath) {
      continue;
    }

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...listWorkspaceFiles(workspacePath, absolutePath));
      continue;
    }

    if (isArtifactLikeFile(relativePath)) {
      continue;
    }

    files.push(relativePath);
  }

  return files;
}

function collectSourceFiles(
  workspacePath: string,
  indexStatePath: string,
  indexedFiles?: Record<string, { hash: string }>
): GraphSourceFile[] {
  const explicitFiles = indexedFiles && typeof indexedFiles === 'object'
    ? Object.entries(indexedFiles)
      .map(([relativePath, entry]) => ({
        path: normalizePath(relativePath),
        hash: typeof entry?.hash === 'string' ? entry.hash : '',
      }))
      .filter((entry) => entry.path && entry.hash)
    : [];

  if (explicitFiles.length > 0) {
    return explicitFiles
      .map((entry) => ({
        ...entry,
        language: toSupportedGraphLanguage(entry.path),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  const indexState = safeReadJson<{ files?: Record<string, { hash?: string }> }>(indexStatePath);
  const fromIndexState = Object.entries(indexState?.files ?? {})
    .map(([relativePath, entry]) => ({
      path: normalizePath(relativePath),
      hash: typeof entry?.hash === 'string' ? entry.hash : '',
    }))
    .filter((entry) => entry.path && entry.hash);
  if (fromIndexState.length > 0) {
    return fromIndexState
      .map((entry) => ({
        ...entry,
        language: toSupportedGraphLanguage(entry.path),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  return listWorkspaceFiles(workspacePath)
    .map((relativePath) => {
      const absolutePath = path.join(workspacePath, relativePath);
      let hash = '';
      try {
        hash = hashIndexStateContent(fs.readFileSync(absolutePath, 'utf8'));
      } catch {
        hash = '';
      }
      return {
        path: relativePath,
        hash,
        language: toSupportedGraphLanguage(relativePath),
      };
    })
    .filter((entry) => entry.hash)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function getImportRecords(
  relativePath: string,
  language: SupportedGraphLanguage,
  content: string
): GraphImportRecord[] {
  const imports: GraphImportRecord[] = [];
  const lines = content.split(/\r?\n/);

  const pushImport = (line: number, source: string, importedName: string | null, localName: string | null): void => {
    imports.push({
      id: buildGraphEdgeId('import', { relativePath, language, line, source, importedName, localName }),
      path: relativePath,
      language,
      line,
      source,
      imported_name: importedName,
      local_name: localName,
    });
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    if ((language === 'typescript' || language === 'tsx') && /^(import|export)\b/.test(trimmed)) {
      const sourceMatch = trimmed.match(/\bfrom\s+['"]([^'"]+)['"]/);
      const source = sourceMatch?.[1] ?? trimmed.match(/^import\s+['"]([^'"]+)['"]/)?.[1];
      if (!source) return;
      const namedImportMatch = trimmed.match(/\{([^}]+)\}/);
      if (namedImportMatch?.[1]) {
        namedImportMatch[1]
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean)
          .forEach((token) => {
            const aliasMatch = token.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
            pushImport(lineNumber, source, aliasMatch?.[1] ?? null, aliasMatch?.[2] ?? aliasMatch?.[1] ?? null);
          });
        return;
      }
      const defaultImportMatch = trimmed.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      pushImport(lineNumber, source, null, defaultImportMatch?.[1] ?? null);
      return;
    }

    if (language === 'python') {
      const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_./]+)\s+import\s+(.+)$/);
      if (fromMatch) {
        fromMatch[2]
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean)
          .forEach((token) => {
            const aliasMatch = token.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
            pushImport(lineNumber, fromMatch[1], aliasMatch?.[1] ?? null, aliasMatch?.[2] ?? aliasMatch?.[1] ?? null);
          });
        return;
      }
      const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)$/);
      if (importMatch) {
        importMatch[1]
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean)
          .forEach((token) => {
            const aliasMatch = token.match(/^([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
            const importedName = aliasMatch?.[1] ?? null;
            const localName = aliasMatch?.[2] ?? importedName?.split('.').pop() ?? null;
            if (importedName) {
              pushImport(lineNumber, importedName, importedName.split('.').pop() ?? null, localName);
            }
          });
      }
      return;
    }

    if (language === 'go') {
      const goImportMatch = trimmed.match(/^import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?\"([^\"]+)\"/);
      if (goImportMatch) {
        pushImport(lineNumber, goImportMatch[1], null, null);
      }
      return;
    }

    if (language === 'rust') {
      const rustUseMatch = trimmed.match(/^use\s+([^;]+);$/);
      if (rustUseMatch) {
        const imported = rustUseMatch[1].split('::').pop()?.replace(/[{}]/g, '').trim() ?? null;
        pushImport(lineNumber, rustUseMatch[1], imported, imported);
      }
      return;
    }

    if (language === 'java') {
      const javaImportMatch = trimmed.match(/^import\s+([A-Za-z0-9_.]+);$/);
      if (javaImportMatch) {
        pushImport(lineNumber, javaImportMatch[1], javaImportMatch[1].split('.').pop() ?? null, javaImportMatch[1].split('.').pop() ?? null);
      }
      return;
    }

    if (language === 'csharp') {
      const csharpImportMatch = trimmed.match(/^using\s+([A-Za-z0-9_.]+);$/);
      if (csharpImportMatch) {
        pushImport(lineNumber, csharpImportMatch[1], csharpImportMatch[1].split('.').pop() ?? null, csharpImportMatch[1].split('.').pop() ?? null);
      }
    }
  });

  return imports;
}

function buildSymbolsFromChunks(
  relativePath: string,
  language: SupportedGraphLanguage,
  chunks: ChunkRecord[]
): GraphSymbolRecord[] {
  return chunks
    .filter((chunk) => chunk.kind === 'declaration' && chunk.symbolName)
    .map((chunk) => {
      const symbol: GraphSymbolRecord = {
        id: '',
        file_id: buildGraphFileId(relativePath),
        path: relativePath,
        name: chunk.symbolName ?? 'anonymous',
        kind: chunk.symbolKind ?? 'declaration',
        language,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        parser_source: chunk.parserSource ?? 'heuristic-boundary',
      };
      symbol.id = buildGraphSymbolId(symbol);
      return symbol;
    })
    .sort((left, right) =>
      left.start_line - right.start_line
      || left.end_line - right.end_line
      || left.name.localeCompare(right.name)
      || left.kind.localeCompare(right.kind)
    );
}

function buildContainments(relativePath: string, symbols: GraphSymbolRecord[], chunks: ChunkRecord[]): GraphContainmentRecord[] {
  const containments: GraphContainmentRecord[] = [];
  const symbolByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

  for (const symbol of symbols) {
    containments.push({
      id: buildGraphEdgeId('contains', {
        parent: buildGraphFileId(relativePath),
        child: symbol.id,
        kind: 'file_symbol',
      }),
      parent_id: buildGraphFileId(relativePath),
      child_id: symbol.id,
      path: relativePath,
      kind: 'file_symbol',
    });
  }

  for (const chunk of chunks) {
    if (chunk.kind !== 'declaration' || !chunk.symbolName || !chunk.parentSymbol) {
      continue;
    }
    const child = symbolByName.get(chunk.symbolName);
    const parent = symbolByName.get(chunk.parentSymbol);
    if (!child || !parent) {
      continue;
    }
    containments.push({
      id: buildGraphEdgeId('contains', {
        parent: parent.id,
        child: child.id,
        kind: 'symbol_symbol',
      }),
      parent_id: parent.id,
      child_id: child.id,
      path: relativePath,
      kind: 'symbol_symbol',
    });
  }

  return containments;
}

function findContainingSymbol(symbols: GraphSymbolRecord[], line: number): GraphSymbolRecord | null {
  const matches = symbols.filter((symbol) => symbol.start_line <= line && symbol.end_line >= line);
  if (matches.length === 0) return null;
  return matches.sort((left, right) =>
    (left.end_line - left.start_line) - (right.end_line - right.start_line)
    || left.start_line - right.start_line
  )[0] ?? null;
}

function buildReferencesAndCalls(
  relativePath: string,
  language: SupportedGraphLanguage,
  content: string,
  symbols: GraphSymbolRecord[],
  imports: GraphImportRecord[]
): Pick<GraphPayloadFile, 'references' | 'call_edges'> {
  const references: GraphReferenceRecord[] = [];
  const callEdges: GraphCallEdgeRecord[] = [];
  const symbolByName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const importedNames = new Set(
    imports
      .map((entry) => entry.local_name ?? entry.imported_name)
      .filter((value): value is string => Boolean(value))
  );
  const candidateNames = new Set([...symbolByName.keys(), ...importedNames]);
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^(import|export|from|using|use)\b/.test(trimmed)) return;

    const containingSymbol = findContainingSymbol(symbols, lineNumber);
    const matches = Array.from(trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g));
    for (const match of matches) {
      const name = match[1];
      if (!candidateNames.has(name)) {
        continue;
      }
      const targetSymbol = symbolByName.get(name) ?? null;
      references.push({
        id: buildGraphEdgeId('ref', {
          relativePath,
          language,
          lineNumber,
          name,
          start: match.index ?? 0,
          sourceSymbolId: containingSymbol?.id ?? null,
        }),
        path: relativePath,
        language,
        line: lineNumber,
        symbol_name: name,
        symbol_id: targetSymbol?.id ?? null,
        source_symbol_id: containingSymbol?.id ?? null,
        confidence: targetSymbol ? 1 : 0.7,
      });

      const rest = trimmed.slice((match.index ?? 0) + name.length);
      if (!/^\s*\(/.test(rest)) {
        continue;
      }
      callEdges.push({
        id: buildGraphEdgeId('call', {
          relativePath,
          language,
          lineNumber,
          name,
          sourceSymbolId: containingSymbol?.id ?? null,
        }),
        path: relativePath,
        language,
        line: lineNumber,
        source_symbol_id: containingSymbol?.id ?? null,
        target_symbol_id: targetSymbol?.id ?? null,
        target_symbol_name: name,
        confidence: targetSymbol ? 1 : 0.7,
      });
    }
  });

  return { references, call_edges: callEdges };
}

function buildDefinitions(symbols: GraphSymbolRecord[]): GraphDefinitionRecord[] {
  return symbols.map((symbol) => ({
    id: buildGraphEdgeId('def', {
      symbolId: symbol.id,
      path: symbol.path,
      startLine: symbol.start_line,
      endLine: symbol.end_line,
    }),
    symbol_id: symbol.id,
    path: symbol.path,
    language: symbol.language,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    confidence: 1,
  }));
}

function validateMetadata(
  metadata: GraphMetadataFile | null,
  workspaceFingerprint: string,
  sourceFingerprint: string,
  featureFlagsSnapshot: RetrievalV2FeatureFlagsSnapshot
): metadata is GraphMetadataFile {
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.schema_version !== GRAPH_ARTIFACT_SCHEMA_VERSION) return false;
  if (metadata.graph_engine_version !== GRAPH_ENGINE_VERSION) return false;
  if (metadata.workspace_fingerprint !== workspaceFingerprint) return false;
  if (metadata.artifact_layout_version !== GRAPH_ARTIFACT_LAYOUT_VERSION) return false;
  if (metadata.source_fingerprint !== sourceFingerprint) return false;
  if (JSON.stringify(metadata.feature_flags_snapshot) !== JSON.stringify(featureFlagsSnapshot)) return false;
  if (!Array.isArray(metadata.language_matrix)) return false;
  return true;
}

function validatePayload(
  payload: GraphPayloadFile | null,
  workspaceFingerprint: string,
  sourceFingerprint: string
): payload is GraphPayloadFile {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.schema_version !== GRAPH_ARTIFACT_SCHEMA_VERSION) return false;
  if (payload.workspace_fingerprint !== workspaceFingerprint) return false;
  if (payload.source_fingerprint !== sourceFingerprint) return false;
  return Array.isArray(payload.files)
    && Array.isArray(payload.symbols)
    && Array.isArray(payload.definitions)
    && Array.isArray(payload.references)
    && Array.isArray(payload.imports)
    && Array.isArray(payload.containments)
    && Array.isArray(payload.call_edges);
}

export function createWorkspacePersistentGraphStore(
  options: WorkspaceGraphStoreOptions
): WorkspacePersistentGraphStore {
  const workspacePath = path.resolve(options.workspacePath);
  const graphDirectoryPath = options.graphDirectoryPath ?? path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME);
  const graphMetadataPath = options.graphMetadataPath ?? path.join(workspacePath, GRAPH_METADATA_FILE_NAME);
  const payloadPath = path.join(graphDirectoryPath, GRAPH_PAYLOAD_FILE_NAME);
  const indexStatePath = options.indexStatePath ?? path.join(workspacePath, '.context-engine-index-state.json');
  const chunkParser = resolveChunkParser(options);

  let snapshot: GraphStoreSnapshot = {
    version: GRAPH_ARTIFACT_SCHEMA_VERSION,
    schema_version: GRAPH_ARTIFACT_SCHEMA_VERSION,
    graph_engine_version: GRAPH_ENGINE_VERSION,
    updated_at: new Date(0).toISOString(),
    workspace_fingerprint: buildIndexStateWorkspaceFingerprint(workspacePath),
    feature_flags_snapshot: buildFeatureFlagsSnapshot(),
    language_matrix: [...SUPPORTED_GRAPH_LANGUAGES],
    artifact_layout_version: GRAPH_ARTIFACT_LAYOUT_VERSION,
    graph_status: 'empty',
    symbols_count: 0,
    edges_count: 0,
    files_indexed: 0,
    unsupported_files: 0,
    degraded_reason: null,
    source_fingerprint: stableHash({ workspacePath }),
    payload_file: normalizePath(path.relative(workspacePath, payloadPath)),
    payload_loaded: false,
  };
  let payloadCache: GraphPayloadFile | null = null;

  async function clear(): Promise<void> {
    for (const targetPath of [graphMetadataPath, graphDirectoryPath]) {
      if (!isInsideWorkspace(workspacePath, targetPath) || !fs.existsSync(targetPath)) {
        continue;
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    payloadCache = null;
    snapshot = {
      ...snapshot,
      updated_at: new Date(0).toISOString(),
      graph_status: 'empty',
      symbols_count: 0,
      edges_count: 0,
      files_indexed: 0,
      unsupported_files: 0,
      degraded_reason: null,
      payload_loaded: false,
    };
  }

  async function refresh(refreshOptions?: GraphRefreshOptions): Promise<GraphRefreshResult> {
    const workspaceFingerprint = buildIndexStateWorkspaceFingerprint(workspacePath);
    const featureFlagsSnapshot = buildFeatureFlagsSnapshot();
    const sourceFiles = collectSourceFiles(workspacePath, indexStatePath, refreshOptions?.indexedFiles);
    const sourceFingerprint = buildMetadataSourceFingerprint(sourceFiles, featureFlagsSnapshot);
    const metadataFromDisk = safeReadJson<GraphMetadataFile>(graphMetadataPath);
    const payloadFromDisk = safeReadJson<GraphPayloadFile>(payloadPath);
    const payloadRelativePath = normalizePath(path.relative(workspacePath, payloadPath));

    if (!refreshOptions?.forceRebuild) {
      const validMetadata = validateMetadata(metadataFromDisk, workspaceFingerprint, sourceFingerprint, featureFlagsSnapshot);
      const validPayload = validatePayload(payloadFromDisk, workspaceFingerprint, sourceFingerprint);
      if (validMetadata && validPayload) {
        payloadCache = payloadFromDisk;
        snapshot = { ...metadataFromDisk, payload_loaded: true };
        return {
          metadata: metadataFromDisk,
          rebuilt: false,
          loaded_from_disk: true,
          warning: metadataFromDisk.degraded_reason,
        };
      }
    }

    const files: GraphFileRecord[] = [];
    const symbols: GraphSymbolRecord[] = [];
    const definitions: GraphDefinitionRecord[] = [];
    const references: GraphReferenceRecord[] = [];
    const imports: GraphImportRecord[] = [];
    const containments: GraphContainmentRecord[] = [];
    const callEdges: GraphCallEdgeRecord[] = [];

    let unsupportedFiles = 0;
    let partialFailure = false;

    for (const sourceFile of sourceFiles) {
      if (!sourceFile.language) {
        unsupportedFiles += 1;
        continue;
      }

      const absolutePath = path.join(workspacePath, sourceFile.path);
      let content = '';
      try {
        content = fs.readFileSync(absolutePath, 'utf8');
      } catch {
        partialFailure = true;
        continue;
      }

      const fileRecord: GraphFileRecord = {
        id: buildGraphFileId(sourceFile.path),
        path: sourceFile.path,
        hash: sourceFile.hash,
        language: sourceFile.language,
      };
      files.push(fileRecord);

      let chunks: ChunkRecord[] = [];
      try {
        chunks = chunkParser.parse(content, { path: sourceFile.path });
      } catch {
        partialFailure = true;
        chunks = [];
      }

      const fileSymbols = buildSymbolsFromChunks(sourceFile.path, sourceFile.language, chunks);
      const fileDefinitions = buildDefinitions(fileSymbols);
      const fileContainments = buildContainments(sourceFile.path, fileSymbols, chunks);
      const fileImports = getImportRecords(sourceFile.path, sourceFile.language, content);
      const fileReferencesAndCalls = buildReferencesAndCalls(
        sourceFile.path,
        sourceFile.language,
        content,
        fileSymbols,
        fileImports
      );

      symbols.push(...fileSymbols);
      definitions.push(...fileDefinitions);
      containments.push(...fileContainments);
      imports.push(...fileImports);
      references.push(...fileReferencesAndCalls.references);
      callEdges.push(...fileReferencesAndCalls.call_edges);
    }

    const graphStatus: GraphStatus =
      files.length === 0
        ? (unsupportedFiles > 0 ? 'degraded' : 'empty')
        : (partialFailure ? 'degraded' : 'ready');
    const degradedReason: GraphDegradedReason | null =
      files.length === 0 && unsupportedFiles > 0
        ? 'graph_unsupported_language'
        : (partialFailure ? 'graph_partial' : null);

    const payload: GraphPayloadFile = {
      version: GRAPH_ARTIFACT_SCHEMA_VERSION,
      schema_version: GRAPH_ARTIFACT_SCHEMA_VERSION,
      workspace_fingerprint: workspaceFingerprint,
      source_fingerprint: sourceFingerprint,
      files,
      symbols,
      definitions,
      references: references.sort((left, right) => left.id.localeCompare(right.id)),
      imports: imports.sort((left, right) => left.id.localeCompare(right.id)),
      containments: containments.sort((left, right) => left.id.localeCompare(right.id)),
      call_edges: callEdges.sort((left, right) => left.id.localeCompare(right.id)),
    };
    const metadata: GraphMetadataFile = {
      version: GRAPH_ARTIFACT_SCHEMA_VERSION,
      schema_version: GRAPH_ARTIFACT_SCHEMA_VERSION,
      graph_engine_version: GRAPH_ENGINE_VERSION,
      updated_at: new Date().toISOString(),
      workspace_fingerprint: workspaceFingerprint,
      feature_flags_snapshot: featureFlagsSnapshot,
      language_matrix: [...SUPPORTED_GRAPH_LANGUAGES],
      artifact_layout_version: GRAPH_ARTIFACT_LAYOUT_VERSION,
      graph_status: graphStatus,
      symbols_count: payload.symbols.length,
      edges_count:
        payload.references.length
        + payload.imports.length
        + payload.containments.length
        + payload.call_edges.length,
      files_indexed: payload.files.length,
      unsupported_files: unsupportedFiles,
      degraded_reason: degradedReason,
      source_fingerprint: sourceFingerprint,
      payload_file: payloadRelativePath,
    };

    safeWriteJson(payloadPath, payload);
    safeWriteJson(graphMetadataPath, metadata);

    payloadCache = payload;
    snapshot = { ...metadata, payload_loaded: true };
    if (degradedReason) {
      options.onWarning?.(`[graph] persisted with degraded_reason=${degradedReason}`);
    }

    return {
      metadata,
      rebuilt: true,
      loaded_from_disk: false,
      warning: degradedReason,
    };
  }

  return {
    refresh,
    getSnapshot: () => ({ ...snapshot }),
    getGraph: () => (payloadCache ? JSON.parse(JSON.stringify(payloadCache)) as GraphPayloadFile : null),
    clear,
  };
}
