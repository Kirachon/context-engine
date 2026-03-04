import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SearchResult } from '../../mcp/serviceClient.js';

export interface LegacyContextInstance {
  addToIndex: (...args: unknown[]) => Promise<{
    newlyUploaded?: Array<{ path: string }>;
    alreadyUploaded?: Array<{ path: string }>;
    [key: string]: unknown;
  }>;
  search: (query: string, options?: { maxOutputLength?: number }) => Promise<string>;
  exportToFile: (filePath: string) => Promise<void>;
}

export interface LegacyContextFactory {
  create: () => Promise<LegacyContextInstance>;
  importFromFile: (filePath: string) => Promise<LegacyContextInstance>;
}

export interface LegacyDirectContextModule {
  DirectContext: LegacyContextFactory;
}

export type LegacyDirectContextModuleLoader = () => Promise<LegacyDirectContextModule>;

export interface LegacyRuntimeDependencies {
  loadFactory: () => Promise<LegacyContextFactory>;
  fileExists?: (filePath: string) => boolean;
  deleteFile?: (filePath: string) => void;
}

export interface LegacyRuntimeRestoreResult {
  context: LegacyContextInstance;
  restoredFromState: boolean;
}

export type LegacyRuntimeLifecycleStatus = 'restored' | 'created' | 'fallback_after_restore_failure';

export interface LegacyRuntimeLifecycleResult extends LegacyRuntimeRestoreResult {
  lifecycleStatus: LegacyRuntimeLifecycleStatus;
  hadStateFile?: boolean;
}

export interface LegacyRuntimeManagerOptions extends LegacyRuntimeDependencies {
  stateFilePath: string;
}

export interface LegacyRuntimeInitializeOptions {
  restoreFromState?: boolean;
  forceReinitialize?: boolean;
}

export interface LegacySemanticSearchOptions {
  maxOutputLength?: number;
}

export interface LegacySemanticSearchRuntimeDependencies {
  searchAndAsk: (searchQuery: string, prompt: string) => Promise<string>;
  keywordFallbackSearch: (query: string, topK: number) => Promise<SearchResult[]>;
}

export interface EnsureLegacyRuntimeContextOptions {
  manager: LegacyRuntimeManager;
  stateFilePath: string;
  offlineMode: boolean;
  apiUrl?: string;
  skipAutoIndexOnce: boolean;
  skipAutoIndex?: boolean;
  logger?: Pick<Console, 'error'>;
  onStatusError?: (message: string) => void;
  onRestoredFromState?: () => void;
  onAutoIndex?: () => Promise<void>;
  onAutoIndexSkip?: () => void;
  onAutoIndexFailure?: (error: unknown) => void;
}

export interface EnsureLegacyRuntimeContextResult {
  context: LegacyContextInstance;
  skipAutoIndexOnce: boolean;
}

const defaultFileExists = (filePath: string): boolean => fs.existsSync(filePath);
const defaultDeleteFile = (filePath: string): void => fs.unlinkSync(filePath);
const defaultLegacyDirectContextModuleLoader: LegacyDirectContextModuleLoader = async () => (
  await import('@augmentcode/auggie-sdk') as unknown as LegacyDirectContextModule
);

export function createLegacyContextFactoryFromDirectContext(directContext: LegacyContextFactory): LegacyContextFactory {
  return {
    create: () => directContext.create(),
    importFromFile: (filePath: string) => directContext.importFromFile(filePath),
  };
}

export async function loadLegacyContextFactory(
  loadModule: LegacyDirectContextModuleLoader = defaultLegacyDirectContextModuleLoader
): Promise<LegacyContextFactory> {
  const sdkModule = await loadModule();
  return createLegacyContextFactoryFromDirectContext(sdkModule.DirectContext);
}

export class LegacyRuntimeAdapter {
  private factoryPromise: Promise<LegacyContextFactory> | null = null;
  private readonly dependencies: {
    loadFactory: () => Promise<LegacyContextFactory>;
    fileExists: (filePath: string) => boolean;
    deleteFile: (filePath: string) => void;
  };

  constructor(dependencies: LegacyRuntimeDependencies) {
    this.dependencies = {
      loadFactory: dependencies.loadFactory,
      fileExists: dependencies.fileExists ?? defaultFileExists,
      deleteFile: dependencies.deleteFile ?? defaultDeleteFile,
    };
  }

  async restoreOrCreate(stateFilePath: string): Promise<LegacyRuntimeRestoreResult> {
    const result = await this.restoreOrCreateWithOutcome(stateFilePath);
    return {
      context: result.context,
      restoredFromState: result.restoredFromState,
    };
  }

  async restoreOrCreateWithOutcome(stateFilePath: string): Promise<LegacyRuntimeLifecycleResult> {
    const factory = await this.getFactory();
    const hadStateFile = this.dependencies.fileExists(stateFilePath);
    if (!hadStateFile) {
      return {
        context: await factory.create(),
        restoredFromState: false,
        lifecycleStatus: 'created',
        hadStateFile: false,
      };
    }

    try {
      return {
        context: await factory.importFromFile(stateFilePath),
        restoredFromState: true,
        lifecycleStatus: 'restored',
        hadStateFile: true,
      };
    } catch {
      this.tryDeleteStateFile(stateFilePath);
      return {
        context: await factory.create(),
        restoredFromState: false,
        lifecycleStatus: 'fallback_after_restore_failure',
        hadStateFile: true,
      };
    }
  }

  hasStateFile(stateFilePath: string): boolean {
    return this.dependencies.fileExists(stateFilePath);
  }

  async createContext(): Promise<LegacyContextInstance> {
    return (await this.getFactory()).create();
  }

  async saveState(context: LegacyContextInstance, stateFilePath: string): Promise<void> {
    await context.exportToFile(stateFilePath);
  }

  async search(
    context: LegacyContextInstance,
    query: string,
    options?: { maxOutputLength?: number }
  ): Promise<string> {
    return context.search(query, options);
  }

  async addToIndex(
    context: LegacyContextInstance,
    files: Array<{ path: string; contents: string }>,
    options?: { waitForIndexing?: boolean }
  ): Promise<{
    newlyUploaded?: Array<{ path: string }>;
    alreadyUploaded?: Array<{ path: string }>;
    [key: string]: unknown;
  }> {
    return context.addToIndex(files, options);
  }

  clearStateFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      if (!this.dependencies.fileExists(filePath)) {
        continue;
      }
      this.tryDeleteStateFile(filePath);
    }
  }

  private async getFactory(): Promise<LegacyContextFactory> {
    if (!this.factoryPromise) {
      this.factoryPromise = this.dependencies.loadFactory();
    }
    return this.factoryPromise;
  }

  private tryDeleteStateFile(filePath: string): void {
    try {
      this.dependencies.deleteFile(filePath);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export class LegacyRuntimeManager {
  private readonly adapter: LegacyRuntimeAdapter;
  private readonly stateFilePath: string;
  private context: LegacyContextInstance | null = null;
  private initPromise: Promise<LegacyRuntimeLifecycleResult> | null = null;
  private restoredFromState = false;
  private lastInitializeOutcome: LegacyRuntimeLifecycleResult | null = null;

  constructor(options: LegacyRuntimeManagerOptions) {
    this.stateFilePath = options.stateFilePath;
    this.adapter = new LegacyRuntimeAdapter(options);
  }

  async initialize(options?: LegacyRuntimeInitializeOptions): Promise<LegacyContextInstance> {
    return (await this.initializeWithOutcome(options)).context;
  }

  async initializeWithOutcome(options?: LegacyRuntimeInitializeOptions): Promise<LegacyRuntimeLifecycleResult> {
    if (options?.forceReinitialize) {
      this.clearInMemoryState();
    }

    if (this.context && this.lastInitializeOutcome) {
      return this.lastInitializeOutcome;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitializeWithOutcome(options).finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async getContext(options?: LegacyRuntimeInitializeOptions): Promise<LegacyContextInstance> {
    return this.initialize(options);
  }

  async createFreshContext(): Promise<LegacyContextInstance> {
    this.context = await this.adapter.createContext();
    this.restoredFromState = false;
    this.lastInitializeOutcome = {
      context: this.context,
      restoredFromState: false,
      lifecycleStatus: 'created',
    };
    return this.context;
  }

  async reload(options?: Omit<LegacyRuntimeInitializeOptions, 'forceReinitialize'>): Promise<LegacyContextInstance> {
    this.clearInMemoryState();
    return this.initialize(options);
  }

  async persistState(): Promise<boolean> {
    if (!this.context) {
      return false;
    }

    await this.adapter.saveState(this.context, this.stateFilePath);
    return true;
  }

  isInitialized(): boolean {
    return this.context !== null;
  }

  hasPersistedState(): boolean {
    return this.adapter.hasStateFile(this.stateFilePath);
  }

  wasRestoredFromState(): boolean {
    return this.restoredFromState;
  }

  clearPersistedState(): void {
    this.adapter.clearStateFiles([this.stateFilePath]);
  }

  clearInMemoryState(): void {
    this.context = null;
    this.initPromise = null;
    this.restoredFromState = false;
    this.lastInitializeOutcome = null;
  }

  clearAllState(): void {
    this.clearInMemoryState();
    this.clearPersistedState();
  }

  private async doInitializeWithOutcome(options?: LegacyRuntimeInitializeOptions): Promise<LegacyRuntimeLifecycleResult> {
    const shouldRestore = options?.restoreFromState ?? true;
    if (shouldRestore) {
      const result = await this.adapter.restoreOrCreateWithOutcome(this.stateFilePath);
      this.context = result.context;
      this.restoredFromState = result.restoredFromState;
      this.lastInitializeOutcome = result;
      return result;
    }

    const context = await this.createFreshContext();
    const result: LegacyRuntimeLifecycleResult = {
      context,
      restoredFromState: false,
      lifecycleStatus: 'created',
      hadStateFile: this.adapter.hasStateFile(this.stateFilePath),
    };
    this.lastInitializeOutcome = result;
    return result;
  }
}

function isRemoteApiUrl(apiUrl?: string): boolean {
  if (!apiUrl) return false;
  const normalized = apiUrl.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('http://localhost')) return false;
  if (normalized.startsWith('http://127.0.0.1')) return false;
  if (normalized.startsWith('http://0.0.0.0')) return false;
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

export async function ensureLegacyRuntimeContext(
  options: EnsureLegacyRuntimeContextOptions
): Promise<EnsureLegacyRuntimeContextResult> {
  const logger = options.logger ?? console;
  if (options.manager.isInitialized()) {
    return {
      context: await options.manager.getContext({ restoreFromState: true }),
      skipAutoIndexOnce: options.skipAutoIndexOnce,
    };
  }

  if (options.offlineMode && isRemoteApiUrl(options.apiUrl)) {
    const message = 'Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1) but AUGMENT_API_URL points to a remote endpoint. Set it to a local endpoint (e.g., http://localhost) or disable offline mode.';
    logger.error(message);
    options.onStatusError?.(message);
    throw new Error(message);
  }

  const hadStateFileBeforeInitialize = options.manager.hasPersistedState();
  if (options.offlineMode && !hadStateFileBeforeInitialize) {
    const message = `Offline mode is enabled but no saved index found at ${options.stateFilePath}. Connect online once to build the index or disable CONTEXT_ENGINE_OFFLINE_ONLY.`;
    logger.error(message);
    options.onStatusError?.(message);
    throw new Error(message);
  }

  if (hadStateFileBeforeInitialize) {
    logger.error(`Restoring context from ${options.stateFilePath}`);
  } else {
    logger.error('Creating new DirectContext');
  }

  let initOutcome: LegacyRuntimeLifecycleResult;
  try {
    initOutcome = await options.manager.initializeWithOutcome({ restoreFromState: true });
  } catch (createError) {
    if (!hadStateFileBeforeInitialize) {
      logger.error('Failed to create DirectContext:', createError);
      const errorMessage = String(createError);
      if (errorMessage.includes('invalid character') || errorMessage.includes('Login')) {
        logger.error('\n*** AUTHENTICATION ERROR ***');
        logger.error('The API returned an invalid response. Please check:');
        logger.error('1. AUGMENT_API_TOKEN is set correctly');
        logger.error('2. AUGMENT_API_URL is set correctly');
        logger.error('3. Your API token has not expired');
        logger.error('');
      }
    } else {
      logger.error('Failed to restore context state:', createError);
    }
    throw createError;
  }

  const context = initOutcome.context;
  const lifecycleStatus = initOutcome.lifecycleStatus;
  if (lifecycleStatus === 'restored') {
    logger.error('Context restored successfully');
    options.onRestoredFromState?.();
    return { context, skipAutoIndexOnce: options.skipAutoIndexOnce };
  }

  if (lifecycleStatus === 'fallback_after_restore_failure' && options.offlineMode) {
    options.manager.clearInMemoryState();
    const message = `Offline mode is enabled but no saved index found at ${options.stateFilePath}. Connect online once to build the index or disable CONTEXT_ENGINE_OFFLINE_ONLY.`;
    logger.error(message);
    options.onStatusError?.(message);
    throw new Error(message);
  }

  logger.error('DirectContext created successfully');

  let skipAutoIndexOnce = options.skipAutoIndexOnce;
  if (!skipAutoIndexOnce && !options.skipAutoIndex) {
    logger.error('No existing index found - auto-indexing workspace...');
    try {
      await options.onAutoIndex?.();
      logger.error('Auto-indexing completed');
    } catch (error) {
      logger.error('Auto-indexing failed (you can manually call index_workspace tool):', error);
      options.onAutoIndexFailure?.(error);
    }
  } else {
    skipAutoIndexOnce = false;
    options.onAutoIndexSkip?.();
  }

  return { context, skipAutoIndexOnce };
}

export async function searchWithLegacySemanticRuntime(
  query: string,
  topK: number,
  options: LegacySemanticSearchOptions | undefined,
  dependencies: LegacySemanticSearchRuntimeDependencies
): Promise<SearchResult[]> {
  const compatEmptyArrayFallbackEnabled = process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK === 'true';
  const normalizedQuery = query.trim();
  const queryTokens = normalizedQuery
    .split(/[^a-z0-9_./-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
  const hasStrongIdentifierToken = queryTokens.some((token) => token.length >= 12);
  const isSingleTokenQuery = queryTokens.length === 1;

  const prompt = buildLegacySemanticSearchPrompt(query, topK, options);
  const rawResponse = await dependencies.searchAndAsk(query, prompt);
  const parseResult = parseLegacyAIProviderSearchResults(rawResponse, topK);
  if (parseResult !== null) {
    if (parseResult.length > 0) {
      return parseResult;
    }
    if (compatEmptyArrayFallbackEnabled) {
      return dependencies.keywordFallbackSearch(query, topK);
    }
    return [];
  }

  const legacyParsedResults = parseLegacyFormattedResults(rawResponse, topK);
  if (legacyParsedResults.length > 0) {
    return legacyParsedResults;
  }

  if ((rawResponse && rawResponse.trim() !== '') || isSingleTokenQuery || hasStrongIdentifierToken) {
    return dependencies.keywordFallbackSearch(query, topK);
  }

  return [];
}

export function parseLegacyAIProviderSearchResults(raw: string, topK: number): SearchResult[] | null {
  const timestamp = new Date().toISOString();
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.trim() === '') {
    return null;
  }

  const normalized = raw
    .trim()
    .replace(/\\`/g, '`');
  const candidates: string[] = [];
  const fenceMatches = normalized.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of fenceMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }

  let sawExplicitEmptyArray = false;
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith('[') || !candidate.endsWith(']')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    if (parsed.length === 0) {
      sawExplicitEmptyArray = true;
      continue;
    }

    const results: SearchResult[] = [];
    for (let i = 0; i < parsed.length && results.length < topK; i += 1) {
      const item = parsed[i] as Record<string, unknown>;
      if (!item || typeof item !== 'object') continue;

      let rawPath = '';
      if (typeof item.path === 'string') {
        rawPath = item.path;
      } else if (typeof item.file === 'string') {
        rawPath = item.file;
      } else if (typeof item.file_path === 'string') {
        rawPath = item.file_path;
      }

      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!rawPath || !content) continue;

      const sanitizedPath = sanitizeLegacyResultPath(rawPath);
      if (!sanitizedPath) continue;

      const rawScore = typeof item.relevanceScore === 'number'
        ? item.relevanceScore
        : typeof item.score === 'number'
          ? item.score
          : 0;

      const result: SearchResult = {
        path: sanitizedPath,
        content,
        lines: typeof item.lines === 'string' && item.lines.trim() ? item.lines.trim() : undefined,
        relevanceScore: Number.isFinite(rawScore)
          ? Math.max(0, Math.min(1, rawScore))
          : undefined,
        matchType: typeof item.matchType === 'string' && (item.matchType === 'keyword' || item.matchType === 'hybrid' || item.matchType === 'semantic')
          ? item.matchType
          : 'semantic',
        retrievedAt: typeof item.retrievedAt === 'string' && item.retrievedAt.trim() ? item.retrievedAt.trim() : timestamp,
      };

      results.push(result);
    }

    if (results.length > 0) {
      return results;
    }
  }

  // Explicit empty array from provider means "no matches" and should not trigger fallback.
  if (sawExplicitEmptyArray) {
    return [];
  }

  // Any non-empty or malformed provider payload is treated as unparseable so non-strict mode
  // can apply legacy fallbacks while strict mode can short-circuit to [].
  return null;
}

export function buildLegacySemanticSearchPrompt(
  query: string,
  topK: number,
  options?: LegacySemanticSearchOptions
): string {
  const maxOutputLength = options?.maxOutputLength ?? topK * 2000;

  return [
    'You are a strict JSON-only retriever for the Context Engine.',
    `Query: ${query}`,
    `Return up to ${topK} results as a JSON array only. Do not include markdown, prose, or code fences.`,
    'Use this exact schema for every entry:',
    '{ "path": "relative/path.ts", "content": "snippet", "lines": "12-20", "relevanceScore": 0.83, "matchType": "semantic", "retrievedAt": "2026-..." }',
    `Limit content output so total response stays around ${Math.max(500, Math.min(4000, maxOutputLength))} characters.`,
    'Only include files that are likely relevant to the query.',
    'Prefer short snippets that include context around the match.',
    'If no matches are found, return [] exactly.',
  ].join('\n');
}

export function sanitizeLegacyResultPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return null;
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('..' + path.posix.sep)) return null;

  return normalized;
}

export function parseLegacyFormattedResults(formattedResults: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];

  if (!formattedResults || formattedResults.trim() === '') {
    return results;
  }

  const retrievedAt = new Date().toISOString();

  const hasPathPrefix = /^Path:\s*/m.test(formattedResults);
  const blockSplitter = hasPathPrefix ? /(?=^Path:\s*)/m : /(?=^##\s+)/m;

  // Split by detected prefix to get individual file blocks
  const pathBlocks = formattedResults.split(blockSplitter).filter(block => block.trim());

  for (const block of pathBlocks) {
    if (results.length >= topK) break;

    let filePath: string | null = null;
    let content = '';
    let lineRange: string | undefined;

    if (hasPathPrefix) {
      const pathMatch = block.match(/^Path:\s*(.+?)(?:\s*\n|$)/m);
      if (!pathMatch) continue;

      filePath = pathMatch[1].trim();

      const contentStart = block.indexOf('\n');
      if (contentStart === -1) continue;

      content = block.substring(contentStart + 1).trim();
    } else {
      const headingMatch = block.match(/^##\s+(.+?)(?:\s*$|\n)/m);
      if (!headingMatch) continue;
      filePath = headingMatch[1].trim();

      const linesMatch = block.match(/^Lines?\s+([0-9]+(?:-[0-9]+)?)/mi);
      if (linesMatch) {
        lineRange = linesMatch[1];
      }

      const fenceMatch = block.match(/```[a-zA-Z]*\n?([\s\S]*?)```/m);
      if (fenceMatch && fenceMatch[1]) {
        content = fenceMatch[1].trim();
      } else {
        const blankIndex = block.indexOf('\n\n');
        content = blankIndex !== -1
          ? block.substring(blankIndex).trim()
          : block.substring(block.indexOf('\n') + 1).trim();
      }
    }

    // Remove the "..." markers that indicate truncation
    content = content.replace(/^\.\.\.\s*$/gm, '').trim();

    // Remove line number prefixes (e.g., "   30  code" -> "code")
    const lines: number[] = [];
    const cleanedLines = content.split('\n').map(line => {
      const lineNumMatch = line.match(/^\s*(\d+)\s{2}(.*)$/);
      if (lineNumMatch) {
        lines.push(parseInt(lineNumMatch[1], 10));
        return lineNumMatch[2];
      }
      return line;
    });

    content = cleanedLines.join('\n').trim();
    if (!content || !filePath) continue;

    const sanitizedPath = sanitizeLegacyResultPath(filePath);
    if (!sanitizedPath) continue;

    // Use explicit line range if provided; otherwise infer from captured line numbers.
    if (!lineRange) {
      lineRange = lines.length > 0
        ? `${Math.min(...lines)}-${Math.max(...lines)}`
        : undefined;
    }

    results.push({
      path: sanitizedPath,
      content,
      lines: lineRange,
      relevanceScore: 1 - (results.length / topK), // Approximate relevance based on order
      matchType: 'semantic',
      retrievedAt,
    });
  }

  return results;
}
