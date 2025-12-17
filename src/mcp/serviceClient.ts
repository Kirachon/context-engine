/**
 * Layer 2: Context Service Layer
 *
 * This layer adapts raw retrieval from the Auggie SDK (Layer 1)
 * into agent-friendly context bundles optimized for prompt enhancement.
 *
 * Responsibilities:
 * - Decide how much context to return
 * - Format snippets for optimal LLM consumption
 * - Deduplicate results by file path
 * - Enforce token/file limits
 * - Apply relevance scoring and ranking
 * - Generate context summaries and hints
 * - Manage token budgets for LLM context windows
 */

import { DirectContext } from '@augmentcode/auggie-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { Worker } from 'worker_threads';
import { WorkerMessage } from '../worker/messages.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SearchResult {
  path: string;
  content: string;
  score?: number;
  lines?: string;
  /** Relevance score normalized to 0-1 range */
  relevanceScore?: number;
  matchType?: 'semantic' | 'keyword' | 'hybrid';
  retrievedAt?: string;
  chunkId?: string;
}

export interface IndexStatus {
  workspace: string;
  status: 'idle' | 'indexing' | 'error';
  lastIndexed: string | null;
  fileCount: number;
  isStale: boolean;
  lastError?: string;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
  duration: number;
}

export interface WatcherStatus {
  enabled: boolean;
  watching: number;
  pendingChanges: number;
  lastFlush?: string;
}

export interface SnippetInfo {
  text: string;
  lines: string;
  /** Relevance score for this snippet (0-1) */
  relevance: number;
  /** Estimated token count */
  tokenCount: number;
  /** Type of code (function, class, import, etc.) */
  codeType?: string;
}

export interface FileContext {
  path: string;
  /** File extension for syntax highlighting hints */
  extension: string;
  /** High-level summary of what this file contains */
  summary: string;
  /** Relevance score for this file (0-1) */
  relevance: number;
  /** Estimated total token count for this file's context */
  tokenCount: number;
  snippets: SnippetInfo[];
  /** Related files that might be needed for full context */
  relatedFiles?: string[];
}

/** A memory entry retrieved from .memories/ directory */
export interface MemoryEntry {
  /** Category of the memory (preferences, decisions, facts) */
  category: string;
  /** Content of the memory */
  content: string;
  /** Relevance score (0-1) */
  relevanceScore: number;
}

export interface ContextBundle {
  /** High-level summary of the context */
  summary: string;
  /** Query that generated this context */
  query: string;
  /** Files with relevant context, ordered by relevance */
  files: FileContext[];
  /** Key insights and hints for the LLM */
  hints: string[];
  /** Relevant memories from .memories/ directory */
  memories?: MemoryEntry[];
  /** Metadata about the context bundle */
  metadata: {
    totalFiles: number;
    totalSnippets: number;
    totalTokens: number;
    tokenBudget: number;
    truncated: boolean;
    searchTimeMs: number;
    memoriesIncluded?: number;
  };
}

export interface ContextOptions {
  /** Maximum number of files to include (default: 5) */
  maxFiles?: number;
  /** Maximum tokens for the entire context (default: 8000) */
  tokenBudget?: number;
  /** Include related/dependency files (default: true) */
  includeRelated?: boolean;
  /** Minimum relevance score to include (0-1, default: 0.3) */
  minRelevance?: number;
  /** Include file summaries (default: true) */
  includeSummaries?: boolean;
  /** Include memories from .memories/ directory (default: true) */
  includeMemories?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum file size to read (1MB per best practices - larger files typically are generated/data) */
const MAX_FILE_SIZE = 1 * 1024 * 1024;

/** Special files to index by exact name (no extension-based matching) */
const INDEXABLE_FILES_BY_NAME = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'dockerfile',
  'Containerfile',
  'Jenkinsfile',
  'Vagrantfile',
  'Procfile',
  'Rakefile',
  'Gemfile',
  'Brewfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.npmignore',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.browserslistrc',
  '.editorconfig',
  'tsconfig.json',
  'jsconfig.json',
  'package.json',
  'composer.json',
  'pubspec.yaml',
  'analysis_options.yaml',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'build.gradle',
  'settings.gradle',
  'pom.xml',
  'CMakeLists.txt',
  'meson.build',
  'WORKSPACE',
  'BUILD',
  'BUILD.bazel',
]);

/** Default token budget for context */
const DEFAULT_TOKEN_BUDGET = 8000;

/** Approximate characters per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Cache TTL in milliseconds (1 minute) */
const CACHE_TTL_MS = 60000;

/** State file name for persisting index state */
const STATE_FILE_NAME = '.augment-context-state.json';

/** Context ignore file names (in order of preference) */
const CONTEXT_IGNORE_FILES = ['.contextignore', '.augment-ignore'];

/** Memory directory for persistent cross-session memories */
const MEMORIES_DIR = '.memories';

// ============================================================================
// Request Queue for Serializing SDK Calls
// ============================================================================

/**
 * Queue for serializing searchAndAsk calls to prevent SDK concurrency issues.
 *
 * The Auggie SDK's DirectContext may not be thread-safe for concurrent
 * searchAndAsk calls. This queue ensures only one call runs at a time
 * while allowing other operations to continue.
 */
class SearchQueue {
  private queue: Array<{
    execute: () => Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private running = false;

  /**
   * Enqueue a searchAndAsk call for serialized execution
   */
  async enqueue(fn: () => Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ execute: fn, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process the queue, executing one call at a time
   */
  private async processQueue(): Promise<void> {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;
    const item = this.queue.shift()!;

    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.running = false;
      // Process next item if available
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }

  /**
   * Get current queue length (for monitoring/debugging)
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if a call is currently running
   */
  get isRunning(): boolean {
    return this.running;
  }
}

/** Default directories to always exclude - organized by category */
const DEFAULT_EXCLUDED_DIRS = new Set([
  // === Package/Dependency Directories ===
  'node_modules',
  'vendor',          // Go, PHP, Ruby
  'Pods',            // iOS/CocoaPods
  '.pub-cache',      // Dart pub cache
  'packages',        // Some package managers

  // === Build Output Directories ===
  'dist',
  'build',
  'out',
  'target',          // Rust, Java/Maven
  'bin',             // Go, .NET
  'obj',             // .NET
  'release',
  'debug',
  '.output',

  // === Version Control ===
  '.git',
  '.svn',
  '.hg',
  '.fossil',

  // === Python Virtual Environments & Caches ===
  '__pycache__',
  'venv',
  '.venv',
  'env',
  '.env',            // Also a directory in some cases
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'htmlcov',
  '.eggs',
  '*.egg-info',

  // === Flutter/Dart Specific ===
  '.dart_tool',      // Dart tooling cache (critical to exclude)
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  'ephemeral',       // Flutter platform ephemeral directories
  '.symlinks',       // iOS Flutter symlinks

  // === Gradle/Android ===
  '.gradle',

  // === IDE & Editor Directories ===
  '.idea',
  '.vscode',
  '.vs',
  '.fleet',
  '.zed',
  '.cursor',
  'resources',       // IDE resources (e.g., Antigravity)
  'extensions',      // IDE extensions

  // === Test Coverage & Reports ===
  'coverage',
  '.nyc_output',
  'test-results',
  'reports',

  // === Modern Build Tools ===
  '.next',           // Next.js
  '.nuxt',           // Nuxt.js
  '.svelte-kit',     // SvelteKit
  '.astro',          // Astro
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.angular',
  '.webpack',
  '.esbuild',
  '.rollup.cache',

  // === Temporary & Generated ===
  'tmp',
  'temp',
  '.tmp',
  '.temp',
  'logs',
]);

/** Default file patterns to always exclude - organized by category */
const DEFAULT_EXCLUDED_PATTERNS = [
  // === Minified/Bundled Files ===
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.chunk.js',

  // === Source Maps ===
  '*.map',
  '*.js.map',
  '*.css.map',

  // === Lock Files (auto-generated, verbose, low AI value) ===
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'pubspec.lock',      // Flutter/Dart
  'bun.lockb',         // Bun (binary)
  'shrinkwrap.yaml',

  // === Generated Code - Dart/Flutter ===
  '*.g.dart',          // json_serializable, build_runner
  '*.freezed.dart',    // freezed package
  '*.mocks.dart',      // mockito
  '*.gr.dart',         // auto_route
  '*.pb.dart',         // protobuf
  '*.pbjson.dart',     // protobuf JSON
  '*.pbserver.dart',   // protobuf server

  // === Generated Code - Other Languages ===
  '*.generated.ts',
  '*.generated.js',
  '*.pb.go',           // Go protobuf
  '*.pb.cc',           // C++ protobuf
  '*.pb.h',
  '*_pb2.py',          // Python protobuf
  '*_pb2_grpc.py',

  // === Logs & Temporary Files ===
  '*.log',
  '*.tmp',
  '*.temp',
  '*.bak',
  '*.swp',
  '*.swo',
  '*~',                // Backup files

  // === Compiled Python ===
  '*.pyc',
  '*.pyo',
  '*.pyd',

  // === Compiled Java/JVM ===
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',

  // === Compiled Binaries & Libraries ===
  '*.dll',
  '*.exe',
  '*.so',
  '*.dylib',
  '*.a',
  '*.lib',
  '*.o',
  '*.obj',
  '*.wasm',
  '*.dill',            // Dart kernel

  // === Binary Images ===
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.webp',
  '*.ico',
  '*.icns',
  '*.tiff',
  '*.tif',
  '*.svg',             // Often large, sometimes useful
  '*.psd',
  '*.ai',
  '*.sketch',

  // === Fonts ===
  '*.ttf',
  '*.otf',
  '*.woff',
  '*.woff2',
  '*.eot',

  // === Media Files ===
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.ogg',
  '*.webm',
  '*.mov',
  '*.avi',
  '*.flv',
  '*.m4a',
  '*.m4v',

  // === Documents & Archives ===
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.ppt',
  '*.pptx',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',

  // === Secrets & Credentials (security) ===
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '*.key',
  '*.pem',
  '*.p12',
  '*.jks',
  '*.keystore',
  'secrets.yaml',
  'secrets.json',

  // === IDE-specific Files ===
  '*.iml',
  '.project',
  '.classpath',

  // === OS Files ===
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',

  // === Flutter-specific Generated ===
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  '*.stamp',
];

/** File extensions to index - organized by category for maintainability */
const INDEXABLE_EXTENSIONS = new Set([
  // === TypeScript/JavaScript ===
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',

  // === Python ===
  '.py', '.pyw', '.pyi',  // Added .pyi for type stubs

  // === JVM Languages ===
  '.java', '.kt', '.kts', '.scala', '.groovy',

  // === Go ===
  '.go',

  // === Rust ===
  '.rs',

  // === C/C++ ===
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',

  // === .NET ===
  '.cs', '.fs', '.fsx',  // Added F#

  // === Ruby ===
  '.rb', '.rake', '.gemspec',

  // === PHP ===
  '.php',

  // === Mobile Development ===
  '.swift',
  '.m', '.mm',  // Objective-C
  '.dart',      // Flutter/Dart (Essential per best practices)
  '.arb',       // Flutter internationalization files

  // === Frontend Frameworks ===
  '.vue', '.svelte', '.astro',

  // === Web Templates & Styles ===
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.styl',

  // === Configuration Files ===
  '.json', '.yaml', '.yml', '.toml',
  '.xml',       // Android manifests, Maven configs, etc.
  '.plist',     // iOS configuration files
  '.gradle',    // Android build files
  '.properties', // Java properties files
  '.ini', '.cfg', '.conf',
  '.editorconfig',
  '.env.example', '.env.template', '.env.sample',  // Environment templates (NOT actual .env)

  // === Documentation ===
  '.md', '.mdx', '.txt', '.rst',

  // === Database ===
  '.sql', '.prisma',

  // === API/Schema Definitions ===
  '.graphql', '.gql',
  '.proto',     // Protocol Buffers
  '.openapi', '.swagger',

  // === Shell Scripts ===
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd',

  // === Infrastructure & DevOps ===
  '.dockerfile',
  '.tf', '.hcl',  // Terraform
  '.nix',         // Nix configuration

  // === Build Files (by name, not extension - handled separately) ===
  // Makefile, Dockerfile, Jenkinsfile - handled in shouldIndexFile
]);

// ============================================================================
// Cache Entry Type
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// ============================================================================
// Context Service Client
// ============================================================================

export class ContextServiceClient {
  private workspacePath: string;
  private context: DirectContext | null = null;
  private initPromise: Promise<void> | null = null;

  /** LRU cache for search results */
  private searchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();

  /** Maximum cache size */
  private readonly maxCacheSize = 100;

  /** Index status metadata */
  private indexStatus: IndexStatus;

  /** Skip auto-index on next initialization (used after clearing state) */
  private skipAutoIndexOnce = false;

  /** Loaded ignore patterns (from .gitignore and .contextignore) */
  private ignorePatterns: string[] = [];

  /** Flag to track if ignore patterns have been loaded */
  private ignorePatternsLoaded: boolean = false;

  /**
   * Queue for serializing searchAndAsk calls to prevent SDK concurrency issues.
   * This ensures only one AI call runs at a time while allowing other operations
   * to proceed in parallel.
   */
  private searchQueue: SearchQueue = new SearchQueue();

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.indexStatus = {
      workspace: workspacePath,
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    };
  }

  /**
   * Get the workspace path for this client
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Compute staleness based on last indexed timestamp (stale if >24h or missing)
   */
  private computeIsStale(lastIndexed: string | null): boolean {
    if (!lastIndexed) return true;
    const last = Date.parse(lastIndexed);
    if (Number.isNaN(last)) return true;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    return Date.now() - last > ONE_DAY_MS;
  }

  /**
   * Update index status with staleness recompute
   */
  private updateIndexStatus(partial: Partial<IndexStatus>): void {
    const nextLastIndexed = partial.lastIndexed ?? this.indexStatus.lastIndexed;
    const nextIsStale =
      partial.isStale !== undefined
        ? partial.isStale
        : this.computeIsStale(nextLastIndexed);

    this.indexStatus = {
      ...this.indexStatus,
      ...partial,
      lastIndexed: nextLastIndexed,
      isStale: nextIsStale,
    };
  }

  /**
   * Load ignore patterns from .gitignore and .contextignore files
   */
  private loadIgnorePatterns(): void {
    if (this.ignorePatternsLoaded) return;

    this.ignorePatterns = [...DEFAULT_EXCLUDED_PATTERNS];

    // Try to load .gitignore
    const gitignorePath = path.join(this.workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const patterns = this.parseIgnoreFile(content);
        this.ignorePatterns.push(...patterns);
        console.error(`Loaded ${patterns.length} patterns from .gitignore`);
      } catch (error) {
        console.error('Error loading .gitignore:', error);
      }
    }

    // Try to load context ignore files (.contextignore or .augment-ignore)
    for (const ignoreFileName of CONTEXT_IGNORE_FILES) {
      const contextIgnorePath = path.join(this.workspacePath, ignoreFileName);
      if (fs.existsSync(contextIgnorePath)) {
        try {
          const content = fs.readFileSync(contextIgnorePath, 'utf-8');
          const patterns = this.parseIgnoreFile(content);
          this.ignorePatterns.push(...patterns);
          console.error(`Loaded ${patterns.length} patterns from ${ignoreFileName}`);
        } catch (error) {
          console.error(`Error loading ${ignoreFileName}:`, error);
        }
      }
    }

    console.error(`Total ignore patterns loaded: ${this.ignorePatterns.length}`);
    this.ignorePatternsLoaded = true;
  }

  /**
   * Parse an ignore file content into patterns
   */
  private parseIgnoreFile(content: string): string[] {
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
  }

  // ==========================================================================
  // Policy / Environment Checks
  // ==========================================================================

  /**
   * Determine whether offline-only policy is enabled via env var.
   */
  private isOfflineMode(): boolean {
    const flag = process.env.CONTEXT_ENGINE_OFFLINE_ONLY;
    if (!flag) return false;
    const normalized = flag.toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  /**
   * Treat any non-local/non-file API URL as remote.
   */
  private isRemoteApiUrl(apiUrl: string | undefined): boolean {
    if (!apiUrl) return true; // Default SDK endpoint is remote
    const lower = apiUrl.toLowerCase();
    if (lower.startsWith('http://localhost') || lower.startsWith('https://localhost')) return false;
    if (lower.startsWith('http://127.0.0.1') || lower.startsWith('https://127.0.0.1')) return false;
    if (lower.startsWith('file://')) return false;
    return true;
  }

  /**
   * Check if a path should be ignored based on loaded patterns
   *
   * Handles gitignore-style patterns:
   * - Patterns starting with / are anchored to root
   * - Patterns ending with / only match directories
   * - Other patterns match anywhere in the path
   */
  private shouldIgnorePath(relativePath: string): boolean {
    // Normalize path separators
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const fileName = path.basename(normalizedPath);

    for (const rawPattern of this.ignorePatterns) {
      let pattern = rawPattern;

      // Skip negation patterns (gitignore !pattern)
      if (pattern.startsWith('!')) continue;

      // Handle root-anchored patterns (starting with /)
      const isRootAnchored = pattern.startsWith('/');
      if (isRootAnchored) {
        pattern = pattern.slice(1);
      }

      // Handle directory-only patterns (ending with /)
      const isDirOnly = pattern.endsWith('/');
      if (isDirOnly) {
        pattern = pattern.slice(0, -1);
      }

      // For simple patterns without wildcards or slashes, match against filename
      if (!pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
        if (fileName === pattern || normalizedPath === pattern) {
          return true;
        }
        continue;
      }

      // For glob patterns, use minimatch
      try {
        // If root-anchored, match from the start
        if (isRootAnchored) {
          if (minimatch(normalizedPath, pattern, { dot: true })) {
            return true;
          }
        } else {
          // Match anywhere in path (using matchBase for simple patterns)
          if (minimatch(normalizedPath, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
            return true;
          }
          // Also try matching with ** prefix for patterns without it
          if (!pattern.startsWith('**') && minimatch(normalizedPath, `**/${pattern}`, { dot: true })) {
            return true;
          }
        }
      } catch {
        // Invalid pattern, skip
      }
    }
    return false;
  }

  // ==========================================================================
  // SDK Initialization
  // ==========================================================================

  /**
   * Get the state file path for this workspace
   */
  private getStateFilePath(): string {
    return path.join(this.workspacePath, STATE_FILE_NAME);
  }

  /**
   * Initialize the DirectContext SDK
   * Tries to restore from saved state if available
   */
  private async ensureInitialized(): Promise<DirectContext> {
    if (this.context) {
      return this.context;
    }

    // Prevent concurrent initialization
    if (this.initPromise) {
      await this.initPromise;
      return this.context!;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
    return this.context!;
  }

  private async doInitialize(): Promise<void> {
    const stateFilePath = this.getStateFilePath();
    const offlineMode = this.isOfflineMode();
    const apiUrl = process.env.AUGMENT_API_URL;

    if (offlineMode && this.isRemoteApiUrl(apiUrl)) {
      const message = 'Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1) but AUGMENT_API_URL points to a remote endpoint. Set it to a local endpoint (e.g., http://localhost) or disable offline mode.';
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    try {
      // Try to restore from saved state
      if (fs.existsSync(stateFilePath)) {
        console.error(`Restoring context from ${stateFilePath}`);
        this.context = await DirectContext.importFromFile(stateFilePath);
        console.error('Context restored successfully');
        try {
          const stats = fs.statSync(stateFilePath);
          const restoredAt = stats.mtime.toISOString();
          this.updateIndexStatus({
            status: 'idle',
            lastIndexed: restoredAt,
          });
        } catch {
          // ignore stat errors, keep defaults
        }
        return;
      }
    } catch (error) {
      console.error('Failed to restore context state, creating new context:', error);
      // Delete corrupted state file
      try {
        fs.unlinkSync(stateFilePath);
        console.error('Deleted corrupted state file');
      } catch {
        // Ignore deletion errors
      }
    }

    if (offlineMode) {
      const message = `Offline mode is enabled but no saved index found at ${stateFilePath}. Connect online once to build the index or disable CONTEXT_ENGINE_OFFLINE_ONLY.`;
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    // Create new context
    console.error('Creating new DirectContext');
    try {
      this.context = await DirectContext.create();
      console.error('DirectContext created successfully');
    } catch (createError) {
      console.error('Failed to create DirectContext:', createError);
      // Check if this is an API/authentication error
      const errorMessage = String(createError);
      if (errorMessage.includes('invalid character') || errorMessage.includes('Login')) {
        console.error('\n*** AUTHENTICATION ERROR ***');
        console.error('The API returned an invalid response. Please check:');
        console.error('1. AUGMENT_API_TOKEN is set correctly');
        console.error('2. AUGMENT_API_URL is set correctly');
        console.error('3. Your API token has not expired');
        console.error('');
      }
      throw createError;
    }

    // Auto-index workspace if no state file exists (unless skipped)
    if (!this.skipAutoIndexOnce) {
      console.error('No existing index found - auto-indexing workspace...');
      try {
        await this.indexWorkspace();
        console.error('Auto-indexing completed');
      } catch (error) {
        console.error('Auto-indexing failed (you can manually call index_workspace tool):', error);
        // Don't throw - allow server to start even if auto-indexing fails
        // User can manually trigger indexing later
        this.updateIndexStatus({
          status: 'error',
          lastError: String(error),
        });
      }
    } else {
      this.skipAutoIndexOnce = false;
      this.updateIndexStatus({ status: 'idle' });
    }
  }

  /**
   * Save the current context state to disk
   */
  private async saveState(): Promise<void> {
    if (!this.context) return;

    try {
      const stateFilePath = this.getStateFilePath();
      await this.context.exportToFile(stateFilePath);
      console.error(`Context state saved to ${stateFilePath}`);
    } catch (error) {
      console.error('Failed to save context state:', error);
    }
  }

  // ==========================================================================
  // File Discovery
  // ==========================================================================

  /**
   * Check if a file should be indexed based on extension or name
   */
  private shouldIndexFile(filePath: string): boolean {
    const fileName = path.basename(filePath);

    // Check if file matches by exact name first (Makefile, Dockerfile, etc.)
    if (INDEXABLE_FILES_BY_NAME.has(fileName)) {
      return true;
    }

    // Then check by extension
    const ext = path.extname(filePath).toLowerCase();
    return INDEXABLE_EXTENSIONS.has(ext);
  }

  /**
   * Recursively discover all indexable files in a directory
   */
  private async discoverFiles(dirPath: string, relativeTo: string = dirPath): Promise<string[]> {
    // Load ignore patterns on first call
    this.loadIgnorePatterns();

    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(relativeTo, fullPath);

        // Skip hidden files/directories (starting with .) except for special dotfiles
        if (entry.name.startsWith('.') && !INDEXABLE_FILES_BY_NAME.has(entry.name)) {
          continue;
        }

        // Skip default excluded directories
        if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          console.error(`Skipping excluded directory: ${relativePath}`);
          continue;
        }

        // Check against loaded ignore patterns
        if (this.shouldIgnorePath(relativePath)) {
          console.error(`Skipping ignored path: ${relativePath}`);
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.discoverFiles(fullPath, relativeTo);
          files.push(...subFiles);
        } else if (entry.isFile() && this.shouldIndexFile(entry.name)) {
          // Early file size check during discovery for performance
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size > MAX_FILE_SIZE) {
              console.error(`Skipping large file during discovery: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`);
              continue;
            }
          } catch {
            // If stat fails, we'll catch it later during reading
          }
          files.push(relativePath);
        }
      }
    } catch (error) {
      console.error(`Error discovering files in ${dirPath}:`, error);
    }

    return files;
  }

  /**
   * Check if file content appears to be binary
   */
  private isBinaryContent(content: string): boolean {
    // Check for null bytes or high concentration of non-printable characters
    const nonPrintableCount = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    const ratio = nonPrintableCount / content.length;
    return ratio > 0.1 || content.includes('\x00');
  }

  /**
   * Read file contents with size limit check
   */
  private readFileContents(relativePath: string): string | null {
    try {
      const fullPath = path.join(this.workspacePath, relativePath);
      const stats = fs.statSync(fullPath);

      if (stats.size > MAX_FILE_SIZE) {
        console.error(`Skipping large file: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        return null;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check for binary content
      if (this.isBinaryContent(content)) {
        console.error(`Skipping binary file: ${relativePath}`);
        return null;
      }

      return content;
    } catch (error) {
      console.error(`Error reading file ${relativePath}:`, error);
      return null;
    }
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Get cached search results if valid
   */
  private getCachedSearch(cacheKey: string): SearchResult[] | null {
    const entry = this.searchCache.get(cacheKey);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
    // Remove stale entry
    if (entry) {
      this.searchCache.delete(cacheKey);
    }
    return null;
  }

  /**
   * Cache search results with LRU eviction
   */
  private setCachedSearch(cacheKey: string, results: SearchResult[]): void {
    // LRU eviction if cache is full
    if (this.searchCache.size >= this.maxCacheSize) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey) {
        this.searchCache.delete(oldestKey);
      }
    }
    this.searchCache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the search cache
   */
  clearCache(): void {
    this.searchCache.clear();
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * Index the workspace directory using DirectContext SDK
   */
  async indexWorkspace(): Promise<IndexResult> {
    const startTime = Date.now();

    if (this.isOfflineMode()) {
      const message = 'Indexing is disabled while CONTEXT_ENGINE_OFFLINE_ONLY is enabled.';
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    this.updateIndexStatus({ status: 'indexing', lastError: undefined });
    console.error(`Indexing workspace: ${this.workspacePath}`);
    console.error(`API URL: ${process.env.AUGMENT_API_URL || '(default)'}`);
    console.error(`API Token: ${process.env.AUGMENT_API_TOKEN ? '(set)' : '(NOT SET)'}`);

    const context = await this.ensureInitialized();

    // Discover all indexable files
    const filePaths = await this.discoverFiles(this.workspacePath);
    console.error(`Found ${filePaths.length} files to index`);

    if (filePaths.length === 0) {
      console.error('No indexable files found');
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable files found',
        fileCount: 0,
      });
      return {
        indexed: 0,
        skipped: 0,
        errors: ['No indexable files found'],
        duration: Date.now() - startTime,
      };
    }

    // Log all discovered files for debugging
    console.error('Files to index:');
    for (const fp of filePaths) {
      console.error(`  - ${fp}`);
    }

    // Read file contents and prepare for indexing
    const files: Array<{ path: string; contents: string }> = [];
    let skippedCount = 0;
    for (const relativePath of filePaths) {
      const contents = this.readFileContents(relativePath);
      if (contents !== null) {
        files.push({ path: relativePath, contents });
      } else {
        skippedCount++;
      }
    }

    console.error(`Prepared ${files.length} files for indexing (skipped ${skippedCount})`);

    if (files.length === 0) {
      console.error('No files to index after filtering');
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable files found',
        fileCount: 0,
      });
      return {
        indexed: 0,
        skipped: skippedCount,
        errors: ['No indexable files found'],
        duration: Date.now() - startTime,
      };
    }

    // Add files to index in batches with error handling
    const BATCH_SIZE = 10; // Reduced batch size for better error isolation
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(files.length / BATCH_SIZE);

      console.error(`\nIndexing batch ${batchNum}/${totalBatches}:`);
      for (const file of batch) {
        console.error(`  - ${file.path} (${file.contents.length} chars)`);
      }

      try {
        // Don't wait for indexing on intermediate batches
        const isLastBatch = i + BATCH_SIZE >= files.length;
        await context.addToIndex(batch, { waitForIndexing: isLastBatch });
        successCount += batch.length;
        console.error(`  ✓ Batch ${batchNum} indexed successfully`);
      } catch (error) {
        errorCount += batch.length;
        errors.push(`Batch ${batchNum}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`  ✗ Batch ${batchNum} failed:`, error);

        // Try indexing files individually to isolate the problematic file
        console.error(`  Attempting individual file indexing for batch ${batchNum}...`);
        for (const file of batch) {
          try {
            await context.addToIndex([file], { waitForIndexing: false });
            successCount++;
            console.error(`    ✓ ${file.path}`);
          } catch (fileError) {
            console.error(`    ✗ ${file.path} FAILED:`, fileError);
            // Log file content preview for debugging
            const preview = file.contents.substring(0, 200).replace(/\n/g, '\\n');
            console.error(`      Content preview: ${preview}...`);
            errors.push(`${file.path}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
          }
        }
      }
    }

    console.error(`\nIndexing complete: ${successCount} succeeded, ${errorCount} had errors`);

    // Save state after indexing (even if some files failed)
    if (successCount > 0) {
      await this.saveState();
      console.error('Context state saved');

      this.updateIndexStatus({
        status: errorCount > 0 ? 'error' : 'idle',
        lastIndexed: new Date().toISOString(),
        fileCount: successCount,
        lastError: errors.length ? errors[errors.length - 1] : undefined,
      });
    } else {
      this.updateIndexStatus({
        status: 'error',
        lastError: errors[0] || 'Indexing failed',
        fileCount: 0,
      });
    }

    // Clear cache after reindexing
    this.clearCache();
    console.error('Workspace indexing finished');

    return {
      indexed: successCount,
      skipped: skippedCount + errorCount,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Run workspace indexing in a background worker thread
   */
  async indexWorkspaceInBackground(): Promise<void> {
    if (this.isOfflineMode()) {
      const message = 'Background indexing is disabled while CONTEXT_ENGINE_OFFLINE_ONLY is enabled.';
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    return new Promise((resolve, reject) => {
      this.updateIndexStatus({ status: 'indexing', lastError: undefined });
      const worker = new Worker(new URL('../worker/IndexWorker.js', import.meta.url), {
        workerData: {
          workspacePath: this.workspacePath,
        },
      });

      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'index_complete') {
          this.updateIndexStatus({
            status: message.errors?.length ? 'error' : 'idle',
            lastIndexed: new Date().toISOString(),
            fileCount: message.count,
            lastError: message.errors?.[message.errors.length - 1],
          });
          resolve();
        } else if (message.type === 'index_error') {
          this.updateIndexStatus({
            status: 'error',
            lastError: message.error,
          });
          reject(new Error(message.error));
        }
      });

      worker.on('error', (error) => {
        this.updateIndexStatus({ status: 'error', lastError: String(error) });
        reject(error);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          const err = new Error(`Index worker exited with code ${code}`);
          this.updateIndexStatus({ status: 'error', lastError: err.message });
          reject(err);
        }
      });
    });
  }

  /**
   * Get current index status metadata
   */
  getIndexStatus(): IndexStatus {
    // Refresh staleness dynamically based on lastIndexed
    this.updateIndexStatus({});
    return { ...this.indexStatus };
  }

  /**
   * Incrementally index a list of file paths (relative to workspace)
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();

    if (this.isOfflineMode()) {
      const message = 'Incremental indexing is disabled while CONTEXT_ENGINE_OFFLINE_ONLY is enabled.';
      console.error(message);
      this.updateIndexStatus({ status: 'error', lastError: message });
      throw new Error(message);
    }

    if (!filePaths || filePaths.length === 0) {
      return { indexed: 0, skipped: 0, errors: ['No files provided'], duration: 0 };
    }

    this.updateIndexStatus({ status: 'indexing', lastError: undefined });
    const context = await this.ensureInitialized();
    this.loadIgnorePatterns();

    const uniquePaths = Array.from(new Set(filePaths));
    const files: Array<{ path: string; contents: string }> = [];
    const errors: string[] = [];
    let skipped = 0;

    for (const rawPath of uniquePaths) {
      // Normalize and ensure path stays within workspace
      const relativePath = path.isAbsolute(rawPath)
        ? path.relative(this.workspacePath, rawPath)
        : rawPath;

      if (!relativePath || relativePath.startsWith('..')) {
        skipped++;
        continue;
      }

      if (this.shouldIgnorePath(relativePath)) {
        skipped++;
        continue;
      }

      if (!this.shouldIndexFile(relativePath)) {
        skipped++;
        continue;
      }

      const contents = this.readFileContents(relativePath);
      if (contents !== null) {
        files.push({ path: relativePath, contents });
      } else {
        skipped++;
      }
    }

    if (files.length === 0) {
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable file changes provided',
      });
      return {
        indexed: 0,
        skipped,
        errors: ['No indexable file changes provided'],
        duration: Date.now() - startTime,
      };
    }

    let successCount = 0;
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const isLastBatch = i + BATCH_SIZE >= files.length;
      try {
        await context.addToIndex(batch, { waitForIndexing: isLastBatch });
        successCount += batch.length;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        // Attempt per-file indexing
        for (const file of batch) {
          try {
            await context.addToIndex([file], { waitForIndexing: false });
            successCount++;
          } catch (fileError) {
            errors.push(`${file.path}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
          }
        }
      }
    }

    if (successCount > 0) {
      await this.saveState();
      this.updateIndexStatus({
        status: errors.length ? 'error' : 'idle',
        lastIndexed: new Date().toISOString(),
        fileCount: Math.max(this.indexStatus.fileCount, successCount),
        lastError: errors[errors.length - 1],
      });
    } else {
      this.updateIndexStatus({
        status: 'error',
        lastError: errors[0] || 'Incremental indexing failed',
      });
    }

    this.clearCache();

    return {
      indexed: successCount,
      skipped,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Clear index state and caches
   */
  async clearIndex(): Promise<void> {
    // Reset SDK instances
    this.context = null;
    this.initPromise = null;
    this.skipAutoIndexOnce = true;

    // Delete persisted state file if it exists
    const stateFilePath = this.getStateFilePath();
    if (fs.existsSync(stateFilePath)) {
      try {
        fs.unlinkSync(stateFilePath);
        console.error(`Deleted state file: ${stateFilePath}`);
      } catch (error) {
        console.error('Failed to delete state file:', error);
      }
    }

    // Clear caches
    this.clearCache();
    this.ignorePatternsLoaded = false;
    this.ignorePatterns = [];

    this.updateIndexStatus({
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      lastError: undefined,
    });
  }

  /**
   * Perform semantic search using DirectContext SDK
   */
  async semanticSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    // Check cache first
    const cacheKey = `${query}:${topK}`;
    const cached = this.getCachedSearch(cacheKey);
    if (cached) {
      console.error(`[semanticSearch] Cache hit for query: ${query}`);
      return cached;
    }

    const context = await this.ensureInitialized();

    try {
      console.error(`[semanticSearch] Searching for: ${query}`);

      // Use the SDK's search method
      const formattedResults = await context.search(query, {
        maxOutputLength: topK * 2000, // Approximate output length based on topK
      });

      console.error(`[semanticSearch] Raw results length: ${formattedResults?.length || 0}`);
      console.error(`[semanticSearch] Raw results preview: ${formattedResults?.substring(0, 200) || '(empty)'}`);

      // Parse the formatted results into SearchResult objects
      const searchResults = this.parseFormattedResults(formattedResults, topK);

      console.error(`[semanticSearch] Parsed ${searchResults.length} results`);

      // Cache results
      this.setCachedSearch(cacheKey, searchResults);
      return searchResults;
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  }

  /**
   * Perform AI-powered search and ask using DirectContext SDK
   *
   * This method combines semantic search with an LLM call to answer questions
   * about the codebase. It uses Augment's backend LLM API.
   *
   * @param searchQuery - The semantic search query to find relevant code
   * @param prompt - Optional prompt to ask the LLM about the search results
   * @returns The LLM's response as a string
   * @throws Error if the API call fails or authentication is invalid
   */
  async searchAndAsk(searchQuery: string, prompt?: string): Promise<string> {
    const context = await this.ensureInitialized();

    // Use the search queue to serialize searchAndAsk calls
    // This prevents potential SDK concurrency issues while allowing
    // other operations (file reads, semantic search) to run in parallel
    return this.searchQueue.enqueue(async () => {
      try {
        const queueLength = this.searchQueue.length;
        console.error(`[searchAndAsk] Searching for: ${searchQuery}${queueLength > 0 ? ` (queue: ${queueLength} waiting)` : ''}`);
        console.error(`[searchAndAsk] Prompt: ${prompt?.substring(0, 100) || '(using search query)'}`);

        // Use the SDK's searchAndAsk method
        const response = await context.searchAndAsk(searchQuery, prompt);

        console.error(`[searchAndAsk] Response length: ${response?.length || 0}`);

        return response;
      } catch (error) {
        console.error('[searchAndAsk] Failed:', error);
        throw error;
      }
    });
  }

  /**
   * Parse the formatted search results from DirectContext into SearchResult objects
   *
   * The SDK returns results in this format:
   * ```
   * The following code sections were retrieved:
   * Path: src/file.ts
   * ...
   *     1  code line 1
   *     2  code line 2
   * ...
   * Path: src/other.ts
   * ...
   * ```
   */
  private parseFormattedResults(formattedResults: string, topK: number): SearchResult[] {
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

      // Determine line range
      if (!lineRange) {
        lineRange = lines.length > 0
          ? `${Math.min(...lines)}-${Math.max(...lines)}`
          : undefined;
      }

      if (content && filePath) {
        results.push({
          path: filePath.replace(/\\/g, '/'), // Normalize path separators
          content,
          lines: lineRange,
          relevanceScore: 1 - (results.length / topK), // Approximate relevance based on order
          matchType: 'semantic',
          retrievedAt,
        });
      }
    }

    return results;
  }

  // ==========================================================================
  // File Operations with Security
  // ==========================================================================

  /**
   * Validate file path to prevent path traversal attacks
   */
  private validateFilePath(filePath: string): string {
    // Normalize the path
    const normalized = path.normalize(filePath);

    // Reject absolute paths (must be relative to workspace)
    if (path.isAbsolute(normalized)) {
      throw new Error(`Invalid path: absolute paths not allowed. Use paths relative to workspace.`);
    }

    // Reject path traversal attempts
    if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
      throw new Error(`Invalid path: path traversal not allowed.`);
    }

    // Build full path safely
    const fullPath = path.resolve(this.workspacePath, normalized);

    // Ensure the resolved path is still within workspace
    if (!fullPath.startsWith(path.resolve(this.workspacePath))) {
      throw new Error(`Invalid path: path must be within workspace.`);
    }

    return fullPath;
  }

  /**
   * Get file contents with security checks
   */
  async getFile(filePath: string): Promise<string> {
    const fullPath = this.validateFilePath(filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Check file size
    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`);
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  // ==========================================================================
  // Token Estimation Utilities
  // ==========================================================================

  /**
   * Estimate token count for a string (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Detect the type of code in a snippet
   */
  private detectCodeType(content: string): string {
    const trimmed = content.trim();

    // Common patterns
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)) return 'function';
    if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)) return 'class';
    if (/^(export\s+)?interface\s+\w+/.test(trimmed)) return 'interface';
    if (/^(export\s+)?type\s+\w+/.test(trimmed)) return 'type';
    if (/^(export\s+)?const\s+\w+/.test(trimmed)) return 'constant';
    if (/^import\s+/.test(trimmed)) return 'import';
    if (/^(export\s+)?enum\s+\w+/.test(trimmed)) return 'enum';
    if (/^\s*\/\*\*/.test(trimmed)) return 'documentation';
    if (/^(describe|it|test)\s*\(/.test(trimmed)) return 'test';

    return 'code';
  }

  /**
   * Generate a summary for a file based on its path and content patterns
   */
  private generateFileSummary(filePath: string, snippets: SnippetInfo[]): string {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    const dirname = path.dirname(filePath);

    // Analyze code types in snippets
    const codeTypes = snippets.map(s => s.codeType).filter(Boolean);
    const uniqueTypes = [...new Set(codeTypes)];

    // Generate contextual summary
    let summary = '';

    // Infer purpose from path
    if (dirname.includes('test') || basename.includes('.test') || basename.includes('.spec')) {
      summary = `Test file for ${basename.replace(/\.(test|spec)$/, '')}`;
    } else if (dirname.includes('types') || basename.includes('types')) {
      summary = 'Type definitions';
    } else if (dirname.includes('utils') || basename.includes('util')) {
      summary = 'Utility functions';
    } else if (dirname.includes('components')) {
      summary = `UI component: ${basename}`;
    } else if (dirname.includes('hooks')) {
      summary = `React hook: ${basename}`;
    } else if (dirname.includes('api') || dirname.includes('routes')) {
      summary = `API endpoint: ${basename}`;
    } else if (basename === 'index') {
      summary = `Entry point for ${dirname}`;
    } else {
      summary = `${basename} module`;
    }

    // Add code type info
    if (uniqueTypes.length > 0) {
      summary += ` (contains: ${uniqueTypes.slice(0, 3).join(', ')})`;
    }

    return summary;
  }

  // ==========================================================================
  // Enhanced Prompt Context Engine
  // ==========================================================================

  /**
   * Find related files based on imports and references
   */
  private async findRelatedFiles(filePath: string, existingPaths: Set<string>): Promise<string[]> {
    try {
      const content = await this.getFile(filePath);
      const relatedFiles: string[] = [];

      // Extract imports (TypeScript/JavaScript)
      const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        // Skip node_modules imports
        if (!importPath.startsWith('.')) continue;

        // Resolve the import path
        const dir = path.dirname(filePath);
        let resolvedPath = path.join(dir, importPath);

        // Try common extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
        for (const ext of extensions) {
          const testPath = resolvedPath + ext;
          if (!existingPaths.has(testPath)) {
            try {
              await this.getFile(testPath);
              relatedFiles.push(testPath);
              break;
            } catch {
              // File doesn't exist with this extension
            }
          }
        }
      }

      return relatedFiles.slice(0, 3); // Limit related files
    } catch {
      return [];
    }
  }

  /**
   * Smart snippet extraction - get the most relevant parts of content
   */
  private extractSmartSnippet(content: string, maxTokens: number): string {
    const lines = content.split('\n');

    // If content fits, return as-is
    if (this.estimateTokens(content) <= maxTokens) {
      return content;
    }

    // Priority: function/class definitions, then imports, then other
    const priorityLines: { line: string; index: number; priority: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let priority = 0;

      // High priority: function/class definitions
      if (/^(export\s+)?(async\s+)?function\s+\w+/.test(line.trim())) priority = 10;
      else if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(line.trim())) priority = 10;
      else if (/^(export\s+)?interface\s+\w+/.test(line.trim())) priority = 9;
      else if (/^(export\s+)?type\s+\w+/.test(line.trim())) priority = 8;
      // Medium priority: exports and constants
      else if (/^export\s+(const|let|var)\s+/.test(line.trim())) priority = 7;
      // Lower priority: imports (useful for context)
      else if (/^import\s+/.test(line.trim())) priority = 5;
      // Documentation comments
      else if (/^\s*\/\*\*/.test(line) || /^\s*\*/.test(line)) priority = 4;
      // Regular code
      else if (line.trim().length > 0) priority = 1;

      priorityLines.push({ line, index: i, priority });
    }

    // Sort by priority (descending) then by original order
    priorityLines.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.index - b.index;
    });

    // Build snippet within token budget
    const selectedLines: { line: string; index: number }[] = [];
    let tokenCount = 0;

    for (const { line, index, priority } of priorityLines) {
      const lineTokens = this.estimateTokens(line + '\n');
      if (tokenCount + lineTokens > maxTokens) break;
      selectedLines.push({ line, index });
      tokenCount += lineTokens;
    }

    // Sort by original order and join
    selectedLines.sort((a, b) => a.index - b.index);

    // Add ellipsis indicators for gaps
    let result = '';
    let lastIndex = -1;
    for (const { line, index } of selectedLines) {
      if (lastIndex !== -1 && index > lastIndex + 1) {
        result += '\n// ... (lines omitted) ...\n';
      }
      result += line + '\n';
      lastIndex = index;
    }

    return result.trim();
  }

  /**
   * Retrieve relevant memories from .memories/ directory
   * Memories are searched semantically alongside code context
   */
  private async getRelevantMemories(query: string, maxMemories: number = 5): Promise<MemoryEntry[]> {
    const memoriesPath = path.join(this.workspacePath, MEMORIES_DIR);

    // Check if memories directory exists
    if (!fs.existsSync(memoriesPath)) {
      return [];
    }

    const memories: MemoryEntry[] = [];

    // Search for memories in the indexed content
    try {
      const searchResults = await this.semanticSearch(query, maxMemories * 2);

      // Filter to only memory files
      const memoryResults = searchResults.filter(r =>
        r.path.startsWith(MEMORIES_DIR + '/') || r.path.startsWith(MEMORIES_DIR + '\\')
      );

      // Extract category from file path and build memory entries
      for (const result of memoryResults.slice(0, maxMemories)) {
        const fileName = path.basename(result.path, '.md');
        memories.push({
          category: fileName,
          content: result.content,
          relevanceScore: result.relevanceScore || 0.5,
        });
      }
    } catch (error) {
      console.error('[getRelevantMemories] Error searching memories:', error);
    }

    return memories;
  }

  /**
   * Get enhanced context bundle for prompt enhancement
   * This is the primary method for Layer 2 - Context Service
   */
  async getContextForPrompt(query: string, options?: ContextOptions): Promise<ContextBundle>;
  async getContextForPrompt(query: string, maxFiles?: number): Promise<ContextBundle>;
  async getContextForPrompt(
    query: string,
    optionsOrMaxFiles?: ContextOptions | number
  ): Promise<ContextBundle> {
    const startTime = Date.now();

    // Parse options
    const options: ContextOptions = typeof optionsOrMaxFiles === 'number'
      ? { maxFiles: optionsOrMaxFiles }
      : optionsOrMaxFiles || {};

    const {
      maxFiles = 5,
      tokenBudget = DEFAULT_TOKEN_BUDGET,
      includeRelated = true,
      minRelevance = 0.3,
      includeSummaries = true,
      includeMemories = true,
    } = options;

    // Perform semantic search and memory retrieval in parallel
    const [searchResults, memories] = await Promise.all([
      this.semanticSearch(query, maxFiles * 3),
      includeMemories ? this.getRelevantMemories(query, 5) : Promise.resolve([]),
    ]);

    // Filter by minimum relevance
    const relevantResults = searchResults.filter(
      r => (r.relevanceScore || 0) >= minRelevance
    );

    // Deduplicate and group by file path
    const fileMap = new Map<string, SearchResult[]>();
    for (const result of relevantResults) {
      if (!fileMap.has(result.path)) {
        fileMap.set(result.path, []);
      }
      fileMap.get(result.path)!.push(result);
    }

    // Calculate file-level relevance (max of snippet relevances)
    const fileRelevance = new Map<string, number>();
    for (const [filePath, results] of fileMap) {
      const maxRelevance = Math.max(...results.map(r => r.relevanceScore || 0));
      fileRelevance.set(filePath, maxRelevance);
    }

    // Sort files by relevance and take top files
    const sortedFiles = Array.from(fileMap.entries())
      .sort((a, b) => (fileRelevance.get(b[0]) || 0) - (fileRelevance.get(a[0]) || 0))
      .slice(0, maxFiles);

    // Track token usage
    let truncated = false;
    const existingPaths = new Set(sortedFiles.map(([p]) => p));

    // Calculate per-file budget upfront for parallel processing
    const perFileBudget = Math.floor(tokenBudget / maxFiles);

    // =========================================================================
    // PARALLELIZATION: Process all files concurrently using Promise.all
    // This replaces the sequential for-loop with parallel file processing,
    // significantly reducing context retrieval time (estimated 2-4 seconds saved)
    // =========================================================================

    /**
     * Process a single file's context (snippets, related files, summary)
     * This function is designed to run in parallel for multiple files
     */
    const processFileContext = async (
      filePath: string,
      results: SearchResult[]
    ): Promise<FileContext | null> => {
      // Build snippets with smart extraction
      const snippets: SnippetInfo[] = [];
      let fileTokens = 0;

      for (const result of results) {
        const snippetBudget = Math.floor(perFileBudget / results.length);
        const smartContent = this.extractSmartSnippet(result.content, snippetBudget);
        const tokenCount = this.estimateTokens(smartContent);

        if (fileTokens + tokenCount > perFileBudget) {
          break;
        }

        snippets.push({
          text: smartContent,
          lines: result.lines || 'unknown',
          relevance: result.relevanceScore || 0,
          tokenCount,
          codeType: this.detectCodeType(smartContent),
        });

        fileTokens += tokenCount;
      }

      // Skip files with no snippets
      if (snippets.length === 0) {
        return null;
      }

      // Find related files in parallel (if enabled)
      // Note: Each file's related files are found independently
      const relatedFilesPromise = includeRelated
        ? this.findRelatedFiles(filePath, existingPaths)
        : Promise.resolve(undefined);

      // Generate file summary (CPU-bound, runs immediately)
      const summary = includeSummaries
        ? this.generateFileSummary(filePath, snippets)
        : '';

      // Wait for related files (I/O-bound operation)
      const relatedFiles = await relatedFilesPromise;

      return {
        path: filePath,
        extension: path.extname(filePath),
        summary,
        relevance: fileRelevance.get(filePath) || 0,
        tokenCount: fileTokens,
        snippets,
        relatedFiles: relatedFiles?.length ? relatedFiles : undefined,
      };
    };

    // Process all files in parallel
    const fileContextResults = await Promise.all(
      sortedFiles.map(([filePath, results]) => processFileContext(filePath, results))
    );

    // Filter out null results and collect valid file contexts
    const files: FileContext[] = fileContextResults.filter(
      (fc): fc is FileContext => fc !== null
    );

    // Calculate total tokens after parallel processing
    let totalTokens = files.reduce((sum, f) => sum + f.tokenCount, 0);

    // Check if we exceeded the budget (mark as truncated)
    if (totalTokens > tokenBudget) {
      truncated = true;
      // Trim files to fit budget (keeping highest relevance first - already sorted)
      totalTokens = 0;
      const trimmedFiles: FileContext[] = [];
      for (const file of files) {
        if (totalTokens + file.tokenCount <= tokenBudget) {
          trimmedFiles.push(file);
          totalTokens += file.tokenCount;
        } else {
          break;
        }
      }
      files.length = 0;
      files.push(...trimmedFiles);
    }

    // Update existing paths with related files discovered during parallel processing
    for (const file of files) {
      if (file.relatedFiles) {
        file.relatedFiles.forEach(p => existingPaths.add(p));
      }
    }

    // Generate intelligent hints
    const hints = this.generateContextHints(query, files, searchResults.length);

    // Add memory hint if memories were found
    if (memories.length > 0) {
      const categories = [...new Set(memories.map(m => m.category))];
      hints.push(`Memories: ${memories.length} relevant entries from ${categories.join(', ')}`);
    }

    // Build context summary
    const summary = this.generateContextSummary(query, files);

    const searchTimeMs = Date.now() - startTime;

    return {
      summary,
      query,
      files,
      hints,
      memories: memories.length > 0 ? memories : undefined,
      metadata: {
        totalFiles: files.length,
        totalSnippets: files.reduce((sum, f) => sum + f.snippets.length, 0),
        totalTokens,
        tokenBudget,
        truncated,
        searchTimeMs,
        memoriesIncluded: memories.length,
      },
    };
  }

  /**
   * Generate intelligent hints based on the context
   */
  private generateContextHints(
    query: string,
    files: FileContext[],
    totalResults: number
  ): string[] {
    const hints: string[] = [];

    // File type distribution
    const extensions = new Map<string, number>();
    for (const file of files) {
      const ext = file.extension || 'unknown';
      extensions.set(ext, (extensions.get(ext) || 0) + 1);
    }
    if (extensions.size > 0) {
      const extList = Array.from(extensions.entries())
        .map(([ext, count]) => `${ext} (${count})`)
        .join(', ');
      hints.push(`File types: ${extList}`);
    }

    // Code type distribution
    const codeTypes = new Map<string, number>();
    for (const file of files) {
      for (const snippet of file.snippets) {
        if (snippet.codeType) {
          codeTypes.set(snippet.codeType, (codeTypes.get(snippet.codeType) || 0) + 1);
        }
      }
    }
    if (codeTypes.size > 0) {
      const typeList = Array.from(codeTypes.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([type, count]) => `${type} (${count})`)
        .join(', ');
      hints.push(`Code patterns: ${typeList}`);
    }

    // Related files hint
    const relatedFiles = files.flatMap(f => f.relatedFiles || []);
    if (relatedFiles.length > 0) {
      hints.push(`Related files to consider: ${relatedFiles.slice(0, 3).join(', ')}`);
    }

    // Coverage hint
    if (totalResults > files.length) {
      hints.push(`Showing ${files.length} of ${totalResults} matching files`);
    }

    // High relevance hint
    const highRelevanceFiles = files.filter(f => f.relevance > 0.7);
    if (highRelevanceFiles.length > 0) {
      hints.push(`Highly relevant: ${highRelevanceFiles.map(f => path.basename(f.path)).join(', ')}`);
    }

    return hints;
  }

  /**
   * Generate a high-level summary of the context
   */
  private generateContextSummary(query: string, files: FileContext[]): string {
    if (files.length === 0) {
      return `No relevant code found for: "${query}"`;
    }

    // Get the most common directory
    const dirs = files.map(f => path.dirname(f.path));
    const dirCounts = new Map<string, number>();
    for (const dir of dirs) {
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
    const topDir = Array.from(dirCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Get the dominant code types
    const allCodeTypes = files.flatMap(f => f.snippets.map(s => s.codeType)).filter(Boolean);
    const dominantType = allCodeTypes.length > 0
      ? allCodeTypes.sort((a, b) =>
          allCodeTypes.filter(t => t === b).length - allCodeTypes.filter(t => t === a).length
        )[0]
      : 'code';

    return `Context for "${query}": ${files.length} files from ${topDir || 'multiple directories'}, primarily containing ${dominantType} definitions`;
  }
}
