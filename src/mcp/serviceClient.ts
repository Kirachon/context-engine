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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type { WorkerMessage } from '../worker/messages.js';
import { featureEnabled } from '../config/features.js';
import { envInt, envMs } from '../config/env.js';
import { incCounter, observeDurationMs, setGauge } from '../metrics/metrics.js';
import { JsonIndexStateStore, type IndexStateFile } from './indexStateStore.js';
import { createAIProvider, resolveAIProviderId } from '../ai/providers/factory.js';
import type { AIProvider, AIProviderId } from '../ai/providers/types.js';

type DirectContextLike = {
  addToIndex: (...args: unknown[]) => Promise<{
    newlyUploaded?: Array<{ path: string }>;
    alreadyUploaded?: Array<{ path: string }>;
    [key: string]: unknown;
  }>;
  search: (query: string, options?: { maxOutputLength?: number }) => Promise<string>;
  exportToFile: (filePath: string) => Promise<void>;
  [key: string]: unknown;
};

type DirectContextModule = {
  DirectContext: {
    create: () => Promise<DirectContextLike>;
    importFromFile: (filePath: string) => Promise<DirectContextLike>;
  };
};

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
  /**
   * Total number of indexable (non-ignored, supported) files discovered for the run.
   * Useful when indexing is optimized to skip unchanged files.
   */
  totalIndexable?: number;
  /** Number of files skipped because they were unchanged (when enabled). */
  unchangedSkipped?: number;
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
  /** Bypass caches (default: false). */
  bypassCache?: boolean;
}

export interface SearchDiagnostics {
  filters_applied: string[];
  filtered_paths_count: number;
  second_pass_used: boolean;
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
const CACHE_TTL_MS = envMs('CE_SEARCH_CACHE_TTL_MS', 60_000, { min: 0 });

/** Default timeout for AI API calls in milliseconds (2 minutes) */
const DEFAULT_API_TIMEOUT_MS = 120000;
const MIN_API_TIMEOUT_MS = 1_000;
const MAX_API_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 2;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1000;
const MIN_RATE_LIMIT_BACKOFF_MS = 100;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_SEARCH_QUEUE_MAX = 50;
const SEARCH_QUEUE_TIMEOUT_ADMISSION_DEPTH_THRESHOLD = 2;
const SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS = 2500;
const SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS = 2000;

/** State file name for persisting index state */
const STATE_FILE_NAME = '.augment-context-state.json';

/** Separate fingerprint file (stable across restarts; only changes when we save a new index). */
const INDEX_FINGERPRINT_FILE_NAME = '.augment-index-fingerprint.json';

/** File name for persisting semantic search cache (safe to delete). */
const SEARCH_CACHE_FILE_NAME = '.augment-search-cache.json';

/** File name for persisting context bundle cache (safe to delete). */
const CONTEXT_CACHE_FILE_NAME = '.augment-context-cache.json';

/** Persistent cache TTL (7 days). */
const PERSISTENT_CACHE_TTL_MS = envMs('CE_PERSISTENT_CACHE_TTL_MS', 7 * 24 * 60 * 60 * 1000, { min: 0 });

const PERSISTENT_SEARCH_CACHE_MAX_ENTRIES = envInt('CE_PERSIST_SEARCH_CACHE_MAX_ENTRIES', 500, { min: 0, max: 10000 });
const PERSISTENT_CONTEXT_CACHE_MAX_ENTRIES = envInt('CE_PERSIST_CONTEXT_CACHE_MAX_ENTRIES', 100, { min: 0, max: 5000 });

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
 *
 * Includes timeout protection to prevent indefinite hangs on API calls.
 */
class SearchQueueFullError extends Error {
  readonly code = 'SEARCH_QUEUE_FULL';

  constructor(maxQueueSize: number) {
    super(
      `Search queue is full (max ${maxQueueSize}). Try again later or increase CE_SEARCH_AND_ASK_QUEUE_MAX.`
    );
    this.name = 'SearchQueueFullError';
  }
}

class SearchQueuePressureTimeoutError extends Error {
  readonly code = 'SEARCH_QUEUE_PRESSURE_TIMEOUT';

  constructor(timeoutMs: number, queueDepth: number, minimumBudgetMs: number) {
    super(
      `searchAndAsk timeout budget (${timeoutMs}ms) is too small for current queue depth (${queueDepth}). ` +
      `Estimated minimum budget: ${minimumBudgetMs}ms. Retry with a larger timeout or when queue pressure is lower.`
    );
    this.name = 'SearchQueuePressureTimeoutError';
  }
}

class SearchQueue {
  private queue: Array<{
    execute: () => Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timeoutMs: number;
    settled: boolean;
    timer: NodeJS.Timeout;
  }> = [];
  private running = false;
  private maxQueueSize: number;

  constructor(maxQueueSize: number) {
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Create a promise that resolves with a timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms. Consider breaking down the query into smaller parts.`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Enqueue a searchAndAsk call for serialized execution with timeout protection
   * @param fn The function to execute
   * @param timeoutMs Timeout in milliseconds (default: 120000 = 2 minutes)
   */
  async enqueue(fn: () => Promise<string>, timeoutMs: number = DEFAULT_API_TIMEOUT_MS): Promise<string> {
    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new SearchQueueFullError(this.maxQueueSize));
    }
    return new Promise<string>((resolve, reject) => {
      const item = {
        execute: fn,
        resolve,
        reject,
        timeoutMs,
        settled: false,
        timer: setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          item.reject(
            new Error(
              `AI API request timed out after ${timeoutMs}ms (including queue wait time).`
            )
          );
        }, timeoutMs),
      };
      this.queue.push(item);
      this.processQueue();
    });
  }

  /**
   * Process the queue, executing one call at a time with timeout protection
   */
  private async processQueue(): Promise<void> {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;
    const item = this.queue.shift()!;
    if (item.settled) {
      this.running = false;
      if (this.queue.length > 0) {
        this.processQueue();
      }
      return;
    }

    try {
      // Wrap the execution with timeout protection
      const result = await this.withTimeout(
        item.execute(),
        item.timeoutMs,
        'AI API request'
      );
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.resolve(result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SearchQueue] Request failed: ${errorMessage}`);
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
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
   * Total in-flight + waiting requests.
   */
  get depth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /**
   * Check if a call is currently running
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Clear all pending items in the queue (for cleanup/shutdown)
   */
  clearPending(): number {
    const count = this.queue.length;
    for (const item of this.queue) {
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.reject(new Error('Queue cleared'));
      }
    }
    this.queue = [];
    return count;
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

  // === Context Engine Cache/State ===
  '.augment-search-cache.json',

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

  // ============================================================================
  // NEW EXTENSIONS (44 additions - 2025-12-22)
  // ============================================================================

  // === Functional Programming Languages ===
  '.ex', '.exs',            // Elixir (Phoenix framework, distributed systems)
  '.erl', '.hrl',           // Erlang (OTP, telecom, distributed systems)
  '.hs', '.lhs',            // Haskell (functional programming, Pandoc)
  '.clj', '.cljs', '.cljc', // Clojure (JVM functional, ClojureScript)
  '.ml', '.mli',            // OCaml (functional, type systems, compilers)

  // === Scientific & Data Languages ===
  '.r', '.R',               // R language (statistics, data science, academia)
  '.jl',                    // Julia (scientific computing, ML, high-performance)

  // === Scripting Languages ===
  '.lua',                   // Lua (game dev, Neovim, embedded scripting)
  '.pl', '.pm', '.pod',     // Perl (system admin, text processing, legacy)

  // === Modern Systems Languages ===
  '.zig',                   // Zig (modern C replacement, growing adoption)
  '.nim',                   // Nim (efficient, expressive, Python-like syntax)
  '.cr',                    // Crystal (Ruby-like syntax, compiled performance)
  '.v',                     // V language (simple, fast compilation)

  // === Build Systems ===
  '.cmake',                 // CMake (cross-platform C/C++ builds)
  '.mk', '.mak',            // Make (alternative Makefile extensions)
  '.bazel', '.bzl',         // Bazel (Google's build tool, monorepos)
  '.ninja',                 // Ninja (fast build system)
  '.sbt',                   // Scala Build Tool
  '.podspec',               // CocoaPods (iOS dependency management)

  // === Documentation Formats ===
  '.adoc', '.asciidoc',     // AsciiDoc (technical docs, books)
  '.tex', '.latex',         // LaTeX (academic papers, technical docs)
  '.org',                   // Org-mode (Emacs docs, literate programming)
  '.wiki',                  // Wiki markup

  // === Web Templates ===
  '.hbs', '.handlebars',    // Handlebars (template engine)
  '.ejs',                   // Embedded JavaScript templates
  '.pug', '.jade',          // Pug templates (Node.js, formerly Jade)
  '.jsp',                   // JavaServer Pages
  '.erb',                   // Embedded Ruby (Rails views)
  '.twig',                  // Twig (PHP/Symfony templates)

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

interface PersistentCacheFile {
  version: number;
  entries: Record<string, CacheEntry<SearchResult[]>>;
}

interface PersistentContextCacheFile {
  version: number;
  entries: Record<string, CacheEntry<ContextBundle>>;
}

interface IndexFingerprintFile {
  version: number;
  fingerprint: string;
  updatedAt: string;
}

// ============================================================================
// Context Service Client
// ============================================================================

export class ContextServiceClient {
  private workspacePath: string;
  private context: DirectContextLike | null = null;
  private directContextModulePromise: Promise<DirectContextModule> | null = null;
  private initPromise: Promise<void> | null = null;
  private indexChain: Promise<void> = Promise.resolve();
  private indexStateStore: JsonIndexStateStore | null = null;
  private restoredFromStateFile: boolean = false;

  /** LRU cache for search results */
  private searchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();

  /** Maximum cache size */
  private readonly maxCacheSize = 100;

  /** Persistent semantic search cache (best-effort). */
  private persistentSearchCache: Map<string, CacheEntry<SearchResult[]>> = new Map();
  private persistentCacheLoaded = false;
  private persistentCacheWriteTimer: NodeJS.Timeout | null = null;

  /** Persistent context bundle cache (best-effort). */
  private persistentContextCache: Map<string, CacheEntry<ContextBundle>> = new Map();
  private persistentContextCacheLoaded = false;
  private persistentContextCacheWriteTimer: NodeJS.Timeout | null = null;

  /** Index status metadata */
  private indexStatus: IndexStatus;

  /** Whether lightweight disk hydration has already been attempted for this process. */
  private indexStatusDiskHydrated = false;

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
  private searchQueue: SearchQueue = new SearchQueue(
    envInt('CE_SEARCH_AND_ASK_QUEUE_MAX', DEFAULT_SEARCH_QUEUE_MAX)
  );

  // ============================================================================
  // Reactive Commit Cache (Phase 1)
  // ============================================================================

  /** Enable commit-based cache keying for reactive reviews */
  private commitCacheEnabled: boolean = false;

  /** Current commit hash for cache key generation */
  private currentCommitHash: string | null = null;

  /** Cache hit counter for telemetry */
  private cacheHits: number = 0;

  /** Cache miss counter for telemetry */
  private cacheMisses: number = 0;
  private readonly aiProviderId: AIProviderId;
  private aiProvider: AIProvider | null = null;
  private lastSearchDiagnostics: SearchDiagnostics | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.aiProviderId = resolveAIProviderId();
    this.indexStatus = {
      workspace: workspacePath,
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    };
  }

  getActiveAIProviderId(): AIProviderId {
    return this.aiProviderId;
  }

  getActiveAIModelLabel(): string {
    return this.getAIProvider().modelLabel;
  }

  getLastSearchDiagnostics(): SearchDiagnostics | null {
    if (!this.lastSearchDiagnostics) {
      return null;
    }
    return {
      filters_applied: [...this.lastSearchDiagnostics.filters_applied],
      filtered_paths_count: this.lastSearchDiagnostics.filtered_paths_count,
      second_pass_used: this.lastSearchDiagnostics.second_pass_used,
    };
  }

  private setLastSearchDiagnostics(next: SearchDiagnostics | null): void {
    this.lastSearchDiagnostics = next;
  }

  private async loadDirectContextModule(): Promise<DirectContextModule> {
    if (!this.directContextModulePromise) {
      this.directContextModulePromise = import('@augmentcode/auggie-sdk') as unknown as Promise<DirectContextModule>;
    }
    return this.directContextModulePromise;
  }

  private getAIProvider(): AIProvider {
    if (!this.aiProvider) {
      try {
        this.aiProvider = createAIProvider({
          providerId: this.aiProviderId,
          getAugmentContext: async () => {
            throw new Error('OpenAI-only provider policy: DirectContext provider path is disabled.');
          },
          maxRateLimitRetries: envInt('CE_AI_RATE_LIMIT_MAX_RETRIES', DEFAULT_RATE_LIMIT_MAX_RETRIES, {
            min: 0,
            max: 10,
          }),
          baseRateLimitBackoffMs: envMs('CE_AI_RATE_LIMIT_BACKOFF_MS', DEFAULT_RATE_LIMIT_BACKOFF_MS, {
            min: MIN_RATE_LIMIT_BACKOFF_MS,
            max: MAX_RATE_LIMIT_BACKOFF_MS,
          }),
          maxRateLimitBackoffMs: MAX_RATE_LIMIT_BACKOFF_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ContextServiceClient] Failed to initialize AI provider (${this.aiProviderId}): ${message}`);
        throw new Error(`AI provider initialization failed (${this.aiProviderId}): ${message}`);
      }
    }
    return this.aiProvider;
  }

  private getIndexStateStore(): JsonIndexStateStore | null {
    if (!featureEnabled('index_state_store')) {
      return null;
    }
    if (!this.indexStateStore) {
      this.indexStateStore = new JsonIndexStateStore(this.workspacePath);
    }
    return this.indexStateStore;
  }

  private normalizeEolForHash(contents: string): string {
    // Normalize CRLF/CR to LF for stable hashing across OSes.
    return contents.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  private hashContent(contents: string): string {
    const normalize = featureEnabled('hash_normalize_eol');
    const input = normalize ? this.normalizeEolForHash(contents) : contents;
    return crypto.createHash('sha256').update(input).digest('hex');
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
   * Resolve the next lastIndexed value while guarding against stale timestamp clobbering.
   * - `undefined`: keep current value
   * - `null`: explicitly clear current value
   * - `string`: keep the most recent valid timestamp between current and incoming
   */
  private resolveLastIndexed(nextValue: string | null | undefined): string | null {
    if (nextValue === undefined) {
      return this.indexStatus.lastIndexed;
    }
    if (nextValue === null) {
      return null;
    }

    const current = this.indexStatus.lastIndexed;
    if (!current) {
      return nextValue;
    }

    const currentMs = Date.parse(current);
    const nextMs = Date.parse(nextValue);

    if (Number.isNaN(currentMs)) {
      return nextValue;
    }
    if (Number.isNaN(nextMs)) {
      return current;
    }

    return nextMs >= currentMs ? nextValue : current;
  }

  /**
   * Update index status with staleness recompute
   */
  private updateIndexStatus(partial: Partial<IndexStatus>): void {
    const nextLastIndexed = this.resolveLastIndexed(partial.lastIndexed);
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
    const debugIndex = process.env.CE_DEBUG_INDEX === 'true';

    // Try to load .gitignore
    const gitignorePath = path.join(this.workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const patterns = this.parseIgnoreFile(content);
        this.ignorePatterns.push(...patterns);
        if (debugIndex) {
          console.error(`Loaded ${patterns.length} patterns from .gitignore`);
        }
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
          if (debugIndex) {
            console.error(`Loaded ${patterns.length} patterns from ${ignoreFileName}`);
          }
        } catch (error) {
          console.error(`Error loading ${ignoreFileName}:`, error);
        }
      }
    }

    if (debugIndex) {
      console.error(`Total ignore patterns loaded: ${this.ignorePatterns.length}`);
    }
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

  /**
   * Get the loaded ignore patterns for use by external components (e.g., FileWatcher).
   * Loads patterns from .gitignore and .contextignore if not already loaded.
   * Returns patterns suitable for chokidar's ignored option.
   */
  getIgnorePatterns(): string[] {
    this.loadIgnorePatterns();
    return [...this.ignorePatterns];
  }

  /**
   * Get the default excluded directories as an array.
   * Useful for file watchers that need to ignore these directories.
   */
  getExcludedDirectories(): string[] {
    return Array.from(DEFAULT_EXCLUDED_DIRS);
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
   * Best-effort, lightweight index status hydration from persisted files.
   * This intentionally avoids ensureInitialized()/SDK boot so callers like
   * getIndexStatus() can surface persisted metadata immediately after restart.
   */
  private hydrateIndexStatusFromDisk(): void {
    if (this.indexStatusDiskHydrated) {
      return;
    }
    this.indexStatusDiskHydrated = true;

    const nextStatus: Partial<IndexStatus> = {};

    try {
      const stateFilePath = this.getStateFilePath();
      if (fs.existsSync(stateFilePath)) {
        const stats = fs.statSync(stateFilePath);
        const restoredAt = stats.mtime.toISOString();
        if (this.indexStatus.status !== 'indexing') {
          nextStatus.status = 'idle';
          const resolvedLastIndexed = this.resolveLastIndexed(restoredAt);
          if (resolvedLastIndexed !== this.indexStatus.lastIndexed) {
            nextStatus.lastIndexed = resolvedLastIndexed;
          }
        }
      }
    } catch {
      // Best-effort only; keep existing in-memory status on any fs/stat failure.
    }

    if (!this.indexStatus.fileCount) {
      try {
        const store = new JsonIndexStateStore(this.workspacePath);
        const known = Object.keys(store.load().files).length;
        if (known > 0) {
          nextStatus.fileCount = known;
        }
      } catch {
        // Best-effort only; ignore parse/read errors.
      }
    }

    if (Object.keys(nextStatus).length > 0) {
      this.updateIndexStatus(nextStatus);
    }
  }

  /**
   * Initialize the DirectContext SDK
   * Tries to restore from saved state if available
   */
  private async ensureInitialized(options?: { skipAutoIndex?: boolean }): Promise<DirectContextLike> {
    if (this.context) {
      return this.context;
    }

    // Prevent concurrent initialization
    if (this.initPromise) {
      await this.initPromise;
      return this.context!;
    }

    this.initPromise = this.doInitialize(options).finally(() => {
      // Allow retries after failures and avoid holding on to a resolved promise forever.
      this.initPromise = null;
    });
    await this.initPromise;
    return this.context!;
  }

  private enqueueIndexing<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexChain.then(fn, fn);
    this.indexChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runIndexWorker(files?: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    return new Promise<IndexResult>((resolve, reject) => {
      const workerSpec = this.getIndexWorkerSpec();
      if (!workerSpec) {
        reject(new Error('Index worker unavailable: missing built worker (dist/worker/IndexWorker.js) and tsx loader is not installed/resolvable.'));
        return;
      }
      const worker = new Worker(workerSpec.url, {
        execArgv: workerSpec.execArgv,
        workerData: {
          workspacePath: this.workspacePath,
          files,
        },
      });

      let done = false;
      const finalize = async (fn: () => void): Promise<void> => {
        if (done) return;
        done = true;
        try {
          await worker.terminate();
        } catch {
          // ignore
        }
        fn();
      };

      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'index_complete') {
          void finalize(() => {
            resolve({
              indexed: message.count,
              skipped: message.skipped ?? 0,
              errors: message.errors ?? [],
              duration: message.duration ?? (Date.now() - startTime),
              totalIndexable: message.totalIndexable,
              unchangedSkipped: message.unchangedSkipped,
            });
          });
        } else if (message.type === 'index_error') {
          void finalize(() => {
            reject(new Error(message.error));
          });
        }
      });

      worker.on('error', (error) => {
        void finalize(() => {
          reject(error);
        });
      });

      worker.on('exit', (code) => {
        if (done) return;
        if (code !== 0) {
          void finalize(() => {
            reject(new Error(`Index worker exited with code ${code}`));
          });
        } else {
          void finalize(() => {
            resolve({
              indexed: 0,
              skipped: 0,
              errors: [],
              duration: Date.now() - startTime,
            });
          });
        }
      });
    });
  }

  private getIndexWorkerSpec(): { url: URL; execArgv?: string[] } | null {
    const jsUrl = new URL('../worker/IndexWorker.js', import.meta.url);
    const jsPath = fileURLToPath(jsUrl);
    if (fs.existsSync(jsPath)) {
      return { url: jsUrl };
    }

    // Development / tsx execution: spawn the TS worker with tsx loader.
    // Important: resolve tsx relative to THIS package, not process.cwd(),
    // since some clients (e.g. GUI wrappers) run with a different cwd.
    const require = createRequire(import.meta.url);
    let tsxEntrypoint: string | null = null;
    try {
      tsxEntrypoint = require.resolve('tsx');
    } catch {
      tsxEntrypoint = null;
    }

    if (!tsxEntrypoint) {
      return null;
    }

    return {
      url: new URL('../worker/IndexWorker.dev.ts', import.meta.url),
      execArgv: ['--import', tsxEntrypoint],
    };
  }

  private async doInitialize(options?: { skipAutoIndex?: boolean }): Promise<void> {
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
        const { DirectContext } = await this.loadDirectContextModule();
        this.context = await DirectContext.importFromFile(stateFilePath);
        this.restoredFromStateFile = true;
        console.error('Context restored successfully');
        this.hydrateIndexStatusFromDisk();
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
      const { DirectContext } = await this.loadDirectContextModule();
      this.context = await DirectContext.create();
      this.restoredFromStateFile = false;
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
    if (!this.skipAutoIndexOnce && !options?.skipAutoIndex) {
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
      this.writeIndexFingerprintFile(crypto.randomUUID());
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

    const debugIndex = process.env.CE_DEBUG_INDEX === 'true';

    const files: string[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(relativeTo, fullPath);

        // Skip hidden files/directories (starting with .) except for special dotfiles
        if (entry.name.startsWith('.') && !INDEXABLE_FILES_BY_NAME.has(entry.name)) {
          continue;
        }

        // Skip default excluded directories
        if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          if (debugIndex) {
            console.error(`Skipping excluded directory: ${relativePath}`);
          }
          continue;
        }

        // Check against loaded ignore patterns
        if (this.shouldIgnorePath(relativePath)) {
          if (debugIndex) {
            console.error(`Skipping ignored path: ${relativePath}`);
          }
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.discoverFiles(fullPath, relativeTo);
          files.push(...subFiles);
        } else if (entry.isFile() && this.shouldIndexFile(entry.name)) {
          files.push(relativePath);
        }
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError?.code === 'ENOENT') {
        if (debugIndex) {
          console.error(`[discoverFiles] Directory disappeared during scan (skipping): ${dirPath}`);
        }
      } else {
        console.error(`Error discovering files in ${dirPath}:`, error);
      }
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

  private async readFileContentsAsync(relativePath: string): Promise<string | null> {
    try {
      const fullPath = path.join(this.workspacePath, relativePath);
      const stats = await fs.promises.stat(fullPath);

      if (stats.size > MAX_FILE_SIZE) {
        console.error(`Skipping large file: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        return null;
      }

      const content = await fs.promises.readFile(fullPath, 'utf-8');

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
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  private isPersistentCacheEnabled(): boolean {
    if (process.env.JEST_WORKER_ID) return false;
    const raw = process.env.CE_PERSIST_SEARCH_CACHE;
    if (!raw) return true;
    const normalized = raw.toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off');
  }

  private getPersistentCachePath(): string {
    return path.join(this.workspacePath, SEARCH_CACHE_FILE_NAME);
  }

  private loadPersistentCacheIfNeeded(): void {
    if (!this.isPersistentCacheEnabled()) return;
    if (this.persistentCacheLoaded) return;
    this.persistentCacheLoaded = true;

    const cachePath = this.getPersistentCachePath();
    if (!fs.existsSync(cachePath)) return;

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistentCacheFile>;
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.version !== 1) return;
      if (!parsed.entries || typeof parsed.entries !== 'object') return;

      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const ts = (entry as any).timestamp;
        const data = (entry as any).data;
        if (typeof ts !== 'number' || !Array.isArray(data)) continue;
        if (now - ts > PERSISTENT_CACHE_TTL_MS) continue;
        this.persistentSearchCache.set(key, { timestamp: ts, data });
      }
    } catch {
      // Ignore corrupt cache files.
    }
  }

  private schedulePersistentCacheWrite(): void {
    if (!this.isPersistentCacheEnabled()) return;
    if (this.persistentCacheWriteTimer) return;

    this.persistentCacheWriteTimer = setTimeout(() => {
      this.persistentCacheWriteTimer = null;
      void this.writePersistentCacheToDisk();
    }, 250);
  }

  private async writePersistentCacheToDisk(): Promise<void> {
    try {
      const cachePath = this.getPersistentCachePath();
      const tmpPath = `${cachePath}.tmp`;

      const entries: Record<string, CacheEntry<SearchResult[]>> = {};
      for (const [key, value] of this.persistentSearchCache.entries()) {
        entries[key] = value;
      }

      const payload: PersistentCacheFile = { version: 1, entries };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
      await fs.promises.rename(tmpPath, cachePath);
    } catch {
      // Best-effort cache; ignore failures.
    }
  }

  private writeIndexFingerprintFile(fingerprint: string): void {
    const fingerprintPath = path.join(this.workspacePath, INDEX_FINGERPRINT_FILE_NAME);
    try {
      const tmpPath = `${fingerprintPath}.tmp`;
      const payload: IndexFingerprintFile = {
        version: 1,
        fingerprint,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmpPath, fingerprintPath);
    } catch {
      // Best-effort; ignore failures.
    }
  }

  private getIndexFingerprint(): string {
    try {
      const statePath = this.getStateFilePath();
      if (!fs.existsSync(statePath)) return 'no-state';

      const fingerprintPath = path.join(this.workspacePath, INDEX_FINGERPRINT_FILE_NAME);
      if (fs.existsSync(fingerprintPath)) {
        try {
          const raw = fs.readFileSync(fingerprintPath, 'utf-8');
          const parsed = JSON.parse(raw) as Partial<IndexFingerprintFile>;
          const fp = (parsed as any)?.fingerprint;
          if (parsed?.version === 1 && typeof fp === 'string' && fp.length > 0) {
            return `fingerprint:${fp}`;
          }
        } catch {
          // Ignore parse errors; we'll recreate below.
        }
      }

      // Fingerprint file missing/corrupt: create one. This stays stable across restarts
      // even if the SDK touches the state file timestamps.
      const fingerprint = crypto.randomUUID();
      this.writeIndexFingerprintFile(fingerprint);
      return `fingerprint:${fingerprint}`;
    } catch {
      return 'unknown';
    }
  }

  private getPersistentSearch(cacheKey: string): SearchResult[] | null {
    if (!this.isPersistentCacheEnabled()) return null;
    this.loadPersistentCacheIfNeeded();
    const entry = this.persistentSearchCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PERSISTENT_CACHE_TTL_MS) {
      this.persistentSearchCache.delete(cacheKey);
      return null;
    }
    // Touch for LRU behavior.
    this.persistentSearchCache.delete(cacheKey);
    this.persistentSearchCache.set(cacheKey, entry);
    return entry.data;
  }

  private setPersistentSearch(cacheKey: string, results: SearchResult[]): void {
    if (!this.isPersistentCacheEnabled()) return;
    this.loadPersistentCacheIfNeeded();
    // Cap persistent cache size to avoid unbounded growth.
    if (this.persistentSearchCache.size >= PERSISTENT_SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = this.persistentSearchCache.keys().next().value;
      if (oldestKey) {
        this.persistentSearchCache.delete(oldestKey);
      }
    }
    this.persistentSearchCache.set(cacheKey, { data: results, timestamp: Date.now() });
    this.schedulePersistentCacheWrite();
  }

  // ==========================================================================
  // Persistent Context Bundle Cache (Phase 1A)
  // ==========================================================================

  private isPersistentContextCacheEnabled(): boolean {
    if (process.env.JEST_WORKER_ID) return false;
    const raw = process.env.CE_PERSIST_CONTEXT_CACHE;
    if (!raw) return true;
    const normalized = raw.toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off');
  }

  private getPersistentContextCachePath(): string {
    return path.join(this.workspacePath, CONTEXT_CACHE_FILE_NAME);
  }

  private loadPersistentContextCacheIfNeeded(): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    if (this.persistentContextCacheLoaded) return;
    this.persistentContextCacheLoaded = true;

    const cachePath = this.getPersistentContextCachePath();
    if (!fs.existsSync(cachePath)) return;

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistentContextCacheFile>;
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.version !== 1) return;
      if (!parsed.entries || typeof parsed.entries !== 'object') return;

      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const ts = (entry as any).timestamp;
        const data = (entry as any).data;
        if (typeof ts !== 'number' || !data || typeof data !== 'object') continue;
        if (now - ts > PERSISTENT_CACHE_TTL_MS) continue;
        this.persistentContextCache.set(key, { timestamp: ts, data: data as ContextBundle });
      }
    } catch {
      // Ignore corrupt cache files.
    }
  }

  private schedulePersistentContextCacheWrite(): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    if (this.persistentContextCacheWriteTimer) return;

    this.persistentContextCacheWriteTimer = setTimeout(() => {
      this.persistentContextCacheWriteTimer = null;
      void this.writePersistentContextCacheToDisk();
    }, 250);
  }

  private async writePersistentContextCacheToDisk(): Promise<void> {
    try {
      const cachePath = this.getPersistentContextCachePath();
      const tmpPath = `${cachePath}.tmp`;

      const entries: Record<string, CacheEntry<ContextBundle>> = {};
      for (const [key, value] of this.persistentContextCache.entries()) {
        entries[key] = value;
      }

      const payload: PersistentContextCacheFile = { version: 1, entries };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
      await fs.promises.rename(tmpPath, cachePath);
    } catch {
      // Best-effort cache; ignore failures.
    }
  }

  private getPersistentContextBundle(cacheKey: string): ContextBundle | null {
    if (!this.isPersistentContextCacheEnabled()) return null;
    this.loadPersistentContextCacheIfNeeded();
    const entry = this.persistentContextCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PERSISTENT_CACHE_TTL_MS) {
      this.persistentContextCache.delete(cacheKey);
      return null;
    }
    // Touch for LRU behavior.
    this.persistentContextCache.delete(cacheKey);
    this.persistentContextCache.set(cacheKey, entry);
    return entry.data;
  }

  private setPersistentContextBundle(cacheKey: string, bundle: ContextBundle): void {
    if (!this.isPersistentContextCacheEnabled()) return;
    this.loadPersistentContextCacheIfNeeded();

    if (this.persistentContextCache.size >= PERSISTENT_CONTEXT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.persistentContextCache.keys().next().value;
      if (oldestKey) {
        this.persistentContextCache.delete(oldestKey);
      }
    }
    this.persistentContextCache.set(cacheKey, { data: bundle, timestamp: Date.now() });
    this.schedulePersistentContextCacheWrite();
  }

  // ==========================================================================
  // Reactive Commit Cache Methods (Phase 1)
  // ==========================================================================

  /**
   * Enable commit-based cache keying for reactive mode.
   * When enabled, cache keys are prefixed with the commit hash for consistency.
   * 
   * @param commitHash Git commit hash to use as cache key prefix
   */
  enableCommitCache(commitHash: string): void {
    if (process.env.REACTIVE_COMMIT_CACHE !== 'true') {
      console.error('[ContextServiceClient] Commit cache feature flag not enabled (set REACTIVE_COMMIT_CACHE=true)');
      return;
    }
    this.commitCacheEnabled = true;
    this.currentCommitHash = commitHash;
    console.error(`[ContextServiceClient] Commit cache enabled for ${commitHash.substring(0, 12)}`);
  }

  /**
   * Disable commit-based cache keying and clear the current commit hash.
   */
  disableCommitCache(): void {
    if (this.commitCacheEnabled) {
      console.error('[ContextServiceClient] Commit cache disabled');
    }
    this.commitCacheEnabled = false;
    this.currentCommitHash = null;
  }

  /**
   * Generate cache key with optional commit hash prefix.
   * Used internally by semanticSearch when commit cache is enabled.
   * 
   * @param query Search query
   * @param topK Number of results
   * @returns Cache key string
   */
  private getCommitAwareCacheKey(query: string, topK: number, providerId?: AIProviderId): string {
    const retrievalProvider = providerId ?? this.getActiveAIProviderId();
    const baseKey = `${retrievalProvider}:${query}:${topK}`;
    if (this.commitCacheEnabled && this.currentCommitHash) {
      return `${this.currentCommitHash.substring(0, 12)}:${baseKey}`;
    }
    return baseKey;
  }

  /**
   * Prefetch context for files in background (non-blocking).
   * Useful for warming the cache before a review starts.
   * 
   * @param filePaths Array of file paths to prefetch
   * @param commitHash Optional commit hash for cache keying
   */
  async prefetchFilesContext(filePaths: string[], commitHash?: string): Promise<void> {
    if (commitHash) {
      this.enableCommitCache(commitHash);
    }

    // Use setImmediate to avoid blocking the event loop
    setImmediate(async () => {
      console.error(`[prefetch] Starting prefetch for ${filePaths.length} files`);
      const startTime = Date.now();
      let successCount = 0;

      for (const filePath of filePaths) {
        try {
          await this.semanticSearch(`file:${filePath}`, 5);
          successCount++;
        } catch (e) {
          console.error(`[prefetch] Failed for ${filePath}:`, e);
        }
      }

      const elapsed = Date.now() - startTime;
      console.error(`[prefetch] Completed: ${successCount}/${filePaths.length} files in ${elapsed}ms`);
    });
  }

  /**
   * Invalidate cache entries for a specific commit or all entries.
   * 
   * @param commitHash Optional commit hash to invalidate (all if not provided)
   */
  invalidateCommitCache(commitHash?: string): void {
    if (!commitHash) {
      this.clearCache();
      console.error('[ContextServiceClient] Cleared entire cache');
      return;
    }

    const prefix = commitHash.substring(0, 12);
    let invalidated = 0;

    for (const key of this.searchCache.keys()) {
      if (key.startsWith(prefix)) {
        this.searchCache.delete(key);
        invalidated++;
      }
    }

    console.error(`[ContextServiceClient] Invalidated ${invalidated} cache entries for commit ${prefix}`);
  }

  /**
   * Get cache statistics for telemetry and monitoring.
   * 
   * @returns Cache statistics object
   */
  getCacheStats(): { size: number; hitRate: number; commitKeyed: boolean; currentCommit: string | null; hits: number; misses: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.searchCache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      commitKeyed: this.commitCacheEnabled,
      currentCommit: this.currentCommitHash,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * Index the workspace directory using DirectContext SDK
   */
  async indexWorkspace(): Promise<IndexResult> {
    return this.enqueueIndexing(async () => {
      const startTime = Date.now();
      let metricsResult: 'success' | 'error' = 'success';
      try {

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

      const debugIndex = process.env.CE_DEBUG_INDEX === 'true';

      const useWorker =
        process.env.CE_INDEX_USE_WORKER !== 'false' &&
        // Avoid worker-based indexing in Jest unit tests (worker won't inherit mocks).
        !process.env.JEST_WORKER_ID;

      if (useWorker) {
        let result: IndexResult | null = null;
        try {
          result = await this.runIndexWorker();
        } catch (e) {
          console.error('[indexWorkspace] Worker indexing unavailable; falling back to in-process indexing:', e);
          result = null;
        }

        if (!result) {
          // fall through to in-process path
        } else {
          // If the worker does not provide totalIndexable (older worker builds), avoid
          // clobbering a previously-known fileCount with a small per-run indexed count.
          const nextFileCount =
            result.totalIndexable ??
            (this.indexStatus.fileCount > 0 ? this.indexStatus.fileCount : result.indexed);

          if (result.indexed > 0) {
            this.updateIndexStatus({
              status: result.errors.length ? 'error' : 'idle',
              lastIndexed: new Date().toISOString(),
              fileCount: nextFileCount,
              lastError: result.errors.length ? result.errors[result.errors.length - 1] : undefined,
            });
          } else {
            this.updateIndexStatus({
              status: result.errors.length ? 'error' : 'idle',
              lastIndexed: new Date().toISOString(),
              fileCount: nextFileCount,
              lastError: result.errors[0],
            });
          }

          // Ensure the in-memory context reflects the worker-written state file.
          this.context = null;
          this.initPromise = null;
          this.clearCache();
          await this.ensureInitialized({ skipAutoIndex: true });

          return result;
        }
      }

      const context = await this.ensureInitialized({ skipAutoIndex: true });

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

    if (debugIndex) {
      // Log all discovered files for debugging (only first 50 to avoid log spam)
      console.error('Files to index (showing first 50):');
      for (const fp of filePaths.slice(0, 50)) {
        console.error(`  - ${fp}`);
      }
      if (filePaths.length > 50) {
        console.error(`  ... and ${filePaths.length - 50} more files`);
      }
    }

    // STREAMING APPROACH: Read and index files in batches to minimize memory usage
    // Instead of loading all files into memory, we read files just-in-time for each batch
    const BATCH_SIZE = Number.parseInt(process.env.CE_INDEX_BATCH_SIZE ?? '10', 10) || 10;
    const totalBatches = Math.ceil(filePaths.length / BATCH_SIZE);
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let unchangedSkippedCount = 0;
    const errors: string[] = [];
    const successfulPaths: Set<string> = new Set();
    const contentHashes: Map<string, string> = new Map();

    const store = this.getIndexStateStore();
    // Skipping unchanged files is only safe when we have an existing context restored from disk.
    // Otherwise we could "skip" everything and end up with an empty index.
    const skipUnchanged =
      Boolean(store) && featureEnabled('skip_unchanged_indexing') && this.restoredFromStateFile;
    const indexState: IndexStateFile | null = skipUnchanged && store ? store.load() : null;
    const indexedAtIso = new Date().toISOString();

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batchPaths = filePaths.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const isLastBatch = i + BATCH_SIZE >= filePaths.length;

      // Read file contents for this batch only (streaming approach)
      const batch: Array<{ path: string; contents: string }> = [];
      const contentsByPath = await Promise.all(
        batchPaths.map(async (relativePath) => ({
          relativePath,
          contents: await this.readFileContentsAsync(relativePath),
        }))
      );

      for (const { relativePath, contents } of contentsByPath) {
        if (contents === null) {
          skippedCount++;
          continue;
        }

        const hash = store ? this.hashContent(contents) : null;
        if (hash) {
          contentHashes.set(relativePath, hash);
        }

        if (skipUnchanged && indexState) {
          const previous = indexState.files[relativePath]?.hash;
          if (previous && previous === hash) {
            unchangedSkippedCount++;
            continue;
          }
        }

        batch.push({ path: relativePath, contents });
      }

      if (batch.length === 0) {
        console.error(`  Batch ${batchNum}/${totalBatches}: All files skipped`);
        continue;
      }

      if (debugIndex) {
        console.error(`\nIndexing batch ${batchNum}/${totalBatches}:`);
        for (const file of batch) {
          console.error(`  - ${file.path} (${file.contents.length} chars)`);
        }
      }

      try {
        // Don't wait for indexing on intermediate batches
        await context.addToIndex(batch, { waitForIndexing: isLastBatch });
        successCount += batch.length;
        for (const file of batch) {
          successfulPaths.add(file.path);
        }
        if (debugIndex) {
          console.error(`  ✓ Batch ${batchNum} indexed successfully`);
        }
      } catch (error) {
        errors.push(`Batch ${batchNum}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`  ✗ Batch ${batchNum} failed:`, error);

        // Try indexing files individually to isolate the problematic file
        if (debugIndex) {
          console.error(`  Attempting individual file indexing for batch ${batchNum}...`);
        }
        for (const file of batch) {
          try {
            await context.addToIndex([file], { waitForIndexing: false });
            successCount++;
            successfulPaths.add(file.path);
            if (debugIndex) {
              console.error(`    ✓ ${file.path}`);
            }
          } catch (fileError) {
            errorCount++;
            if (debugIndex) {
              console.error(`    ✗ ${file.path} FAILED:`, fileError);
            } else {
              console.error(`    ✗ ${file.path} FAILED`);
            }
            errors.push(`${file.path}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
          }
        }
      }

      // Allow GC to reclaim memory from this batch before loading the next
      // The batch array goes out of scope at end of loop iteration
    }

    // Check if any files were actually indexed
    const totalIndexable = filePaths.length - skippedCount;
    const allUnchanged = successCount === 0 && unchangedSkippedCount > 0 && errorCount === 0;
    if (successCount === 0 && !allUnchanged) {
      console.error('No files were successfully indexed');
      this.updateIndexStatus({
        status: 'error',
        lastError: errors[0] || 'No files could be indexed',
        fileCount: 0,
      });
      return {
        indexed: 0,
        skipped: skippedCount + errorCount + unchangedSkippedCount,
        errors: errors.length > 0 ? errors : ['No files could be indexed'],
        duration: Date.now() - startTime,
        totalIndexable,
        unchangedSkipped: unchangedSkippedCount,
      };
    }

    console.error(`\nIndexing complete: ${successCount} succeeded, ${errorCount} had errors, ${skippedCount} skipped`);

    if (store && successfulPaths.size > 0) {
      const prior = store.load();
      const nextFiles: Record<string, { hash: string; indexed_at: string }> = {};
      const existingPaths = new Set(filePaths);

      // Carry forward entries for files that still exist.
      for (const [p, entry] of Object.entries(prior.files)) {
        if (!existingPaths.has(p)) continue;
        nextFiles[p] = entry;
      }

      // Update entries for successfully indexed files.
      for (const p of successfulPaths) {
        const hash = contentHashes.get(p);
        if (!hash) continue;
        nextFiles[p] = { hash, indexed_at: indexedAtIso };
      }

      store.save({
        version: typeof prior.version === 'number' ? prior.version + 1 : 2,
        updated_at: new Date().toISOString(),
        files: nextFiles,
      });
    }

    // Save state after indexing (even if some files failed)
    if (successCount > 0) {
      await this.saveState();
      console.error('Context state saved');

      this.updateIndexStatus({
        status: errorCount > 0 ? 'error' : 'idle',
        lastIndexed: new Date().toISOString(),
        fileCount: totalIndexable,
        lastError: errors.length ? errors[errors.length - 1] : undefined,
      });
    } else {
      // Nothing to write, but treat as a successful no-op when everything is unchanged.
      this.updateIndexStatus({
        status: errorCount > 0 ? 'error' : 'idle',
        lastIndexed: new Date().toISOString(),
        fileCount: totalIndexable,
        lastError: errors.length ? errors[errors.length - 1] : undefined,
      });
    }

    // Clear cache after reindexing
    this.clearCache();
    console.error('Workspace indexing finished');

	      return {
	        indexed: successCount,
	        skipped: skippedCount + errorCount + unchangedSkippedCount,
	        errors,
	        duration: Date.now() - startTime,
          totalIndexable,
          unchangedSkipped: unchangedSkippedCount,
	      };
      } catch (e) {
        metricsResult = 'error';
        throw e;
      } finally {
        incCounter(
          'context_engine_index_workspace_runs_total',
          { result: metricsResult },
          1,
          'Total indexWorkspace runs.'
        );
        observeDurationMs(
          'context_engine_index_workspace_duration_seconds',
          { result: metricsResult },
          Date.now() - startTime,
          { help: 'indexWorkspace end-to-end duration in seconds.' }
        );
      }
    });
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

    const workerSpec = this.getIndexWorkerSpec();
    if (!workerSpec) {
      console.error('[indexWorkspaceInBackground] Index worker unavailable; falling back to in-process indexing.');
      await this.indexWorkspace();
      return;
    }

    return new Promise((resolve, reject) => {
      this.updateIndexStatus({ status: 'indexing', lastError: undefined });
      const worker = new Worker(workerSpec.url, {
        execArgv: workerSpec.execArgv,
        workerData: {
          workspacePath: this.workspacePath,
        },
      });

      let settled = false;
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'index_complete') {
          void (async () => {
            if (settled) return;
            settled = true;

            const nextFileCount =
              message.totalIndexable ??
              (this.indexStatus.fileCount > 0 ? this.indexStatus.fileCount : message.count);

            this.updateIndexStatus({
              status: message.errors?.length ? 'error' : 'idle',
              lastIndexed: new Date().toISOString(),
              fileCount: nextFileCount,
              lastError: message.errors?.[message.errors.length - 1],
            });

            // Worker updates the persisted state file, but this instance holds an in-memory context.
            // Reset and reload so subsequent searches use the fresh index.
            this.context = null;
            this.initPromise = null;
            this.clearCache();
            await this.ensureInitialized();

            await worker.terminate();
            resolve();
          })().catch(async (e) => {
            try {
              await worker.terminate();
            } catch {
              // ignore
            }
            reject(e);
          });
        } else if (message.type === 'index_error') {
          if (settled) return;
          settled = true;
          this.updateIndexStatus({
            status: 'error',
            lastError: message.error,
          });
          void worker.terminate().finally(() => {
            reject(new Error(message.error));
          });
        }
      });

      worker.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.updateIndexStatus({ status: 'error', lastError: String(error) });
        void worker.terminate().finally(() => {
          reject(error);
        });
      });

      worker.on('exit', (code) => {
        if (settled) return;
        settled = true;
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
    this.hydrateIndexStatusFromDisk();
    // Refresh staleness dynamically based on lastIndexed
    this.updateIndexStatus({});
    return { ...this.indexStatus };
  }

  /**
   * Incrementally index a list of file paths (relative to workspace)
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.enqueueIndexing(async () => {
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

      const uniquePaths = Array.from(new Set(filePaths));
      const useWorker =
        process.env.CE_INDEX_USE_WORKER !== 'false' &&
        // Avoid worker-based indexing in Jest unit tests (worker won't inherit mocks).
        !process.env.JEST_WORKER_ID;
      const threshold =
        Number.parseInt(process.env.CE_INDEX_FILES_WORKER_THRESHOLD ?? '200', 10) || 200;

      if (useWorker && uniquePaths.length >= threshold) {
        this.updateIndexStatus({ status: 'indexing', lastError: undefined });
        let result: IndexResult | null = null;
        try {
          result = await this.runIndexWorker(uniquePaths);
        } catch (e) {
          console.error('[indexFiles] Worker indexing unavailable; falling back to in-process indexing:', e);
          result = null;
        }

        if (!result) {
          // fall through to in-process path
        } else {

          if (result.indexed > 0) {
            this.updateIndexStatus({
              status: result.errors.length ? 'error' : 'idle',
              lastIndexed: new Date().toISOString(),
              fileCount: Math.max(this.indexStatus.fileCount, result.indexed),
              lastError: result.errors.length ? result.errors[result.errors.length - 1] : undefined,
            });
          } else {
            this.updateIndexStatus({
              status: 'error',
              lastError: result.errors[0] || 'Incremental indexing failed',
            });
          }

          // Ensure the in-memory context reflects the worker-written state file.
          this.context = null;
          this.initPromise = null;
          this.clearCache();
          await this.ensureInitialized({ skipAutoIndex: true });

          return result;
        }
      }

      this.updateIndexStatus({ status: 'indexing', lastError: undefined });
      const context = await this.ensureInitialized({ skipAutoIndex: true });
      this.loadIgnorePatterns();

      const errors: string[] = [];
      let skipped = 0;
      let unchangedSkippedCount = 0;
      const successfulPaths: Set<string> = new Set();
      const contentHashes: Map<string, string> = new Map();

      const store = this.getIndexStateStore();
      const skipUnchanged =
        Boolean(store) && featureEnabled('skip_unchanged_indexing') && this.restoredFromStateFile;
      const indexState: IndexStateFile | null = skipUnchanged && store ? store.load() : null;
      const indexedAtIso = new Date().toISOString();

      const normalizedPaths: string[] = [];
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

        normalizedPaths.push(relativePath);
      }

      let successCount = 0;
      const BATCH_SIZE = Number.parseInt(process.env.CE_INDEX_BATCH_SIZE ?? '10', 10) || 10;
      for (let i = 0; i < normalizedPaths.length; i += BATCH_SIZE) {
        const batchPaths = normalizedPaths.slice(i, i + BATCH_SIZE);
        const isLastBatch = i + BATCH_SIZE >= normalizedPaths.length;

        const contentsByPath = await Promise.all(
          batchPaths.map(async (relativePath) => ({
            relativePath,
            contents: await this.readFileContentsAsync(relativePath),
          }))
        );

        const batch: Array<{ path: string; contents: string }> = [];
        for (const { relativePath, contents } of contentsByPath) {
          if (contents === null) {
            skipped++;
            continue;
          }

          const hash = store ? this.hashContent(contents) : null;
          if (hash) {
            contentHashes.set(relativePath, hash);
          }

          if (skipUnchanged && indexState) {
            const previous = indexState.files[relativePath]?.hash;
            if (previous && previous === hash) {
              unchangedSkippedCount++;
              continue;
            }
          }

          batch.push({ path: relativePath, contents });
        }

        if (batch.length === 0) {
          continue;
        }

        try {
          await context.addToIndex(batch, { waitForIndexing: isLastBatch });
          successCount += batch.length;
          for (const file of batch) {
            successfulPaths.add(file.path);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // Attempt per-file indexing
          for (const file of batch) {
            try {
              await context.addToIndex([file], { waitForIndexing: false });
              successCount++;
              successfulPaths.add(file.path);
            } catch (fileError) {
              errors.push(`${file.path}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
            }
          }
        }
      }

      if (successCount === 0 && unchangedSkippedCount > 0 && errors.length === 0) {
        // Successful no-op (all requested files unchanged or otherwise skipped by optimization).
        this.updateIndexStatus({
          status: 'idle',
          lastIndexed: new Date().toISOString(),
        });
        this.clearCache();
        return {
          indexed: 0,
          skipped: skipped + unchangedSkippedCount,
          errors: [],
          duration: Date.now() - startTime,
          unchangedSkipped: unchangedSkippedCount,
        };
      }

      if (successCount === 0 && errors.length === 0) {
        this.updateIndexStatus({
          status: 'error',
          lastError: 'No indexable file changes provided',
        });
        this.clearCache();
        return {
          indexed: 0,
          skipped: skipped + unchangedSkippedCount,
          errors: ['No indexable file changes provided'],
          duration: Date.now() - startTime,
          unchangedSkipped: unchangedSkippedCount,
        };
      }

      if (store && successfulPaths.size > 0) {
        const prior = store.load();
        const nextFiles: Record<string, { hash: string; indexed_at: string }> = { ...prior.files };

        for (const p of successfulPaths) {
          const hash = contentHashes.get(p);
          if (!hash) continue;
          nextFiles[p] = { hash, indexed_at: indexedAtIso };
        }

        store.save({
          version: typeof prior.version === 'number' ? prior.version + 1 : 2,
          updated_at: new Date().toISOString(),
          files: nextFiles,
        });
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
        if (unchangedSkippedCount > 0 && errors.length === 0) {
          // Successful no-op (all requested files unchanged).
          this.updateIndexStatus({
            status: 'idle',
            lastIndexed: new Date().toISOString(),
          });
        } else {
          this.updateIndexStatus({
            status: 'error',
            lastError: errors[0] || 'Incremental indexing failed',
          });
        }
      }

      this.clearCache();

      return {
        indexed: successCount,
        skipped: skipped + unchangedSkippedCount,
        errors,
        duration: Date.now() - startTime,
        unchangedSkipped: unchangedSkippedCount,
      };
    });
  }

  /**
   * Clear index state and caches
   */
  async clearIndex(): Promise<void> {
    // Reset SDK instances
    this.context = null;
    this.initPromise = null;
    this.restoredFromStateFile = false;
    this.indexStatusDiskHydrated = false;
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

    const fingerprintPath = path.join(this.workspacePath, INDEX_FINGERPRINT_FILE_NAME);
    if (fs.existsSync(fingerprintPath)) {
      try {
        fs.unlinkSync(fingerprintPath);
        console.error(`Deleted index fingerprint file: ${fingerprintPath}`);
      } catch (error) {
        console.error('Failed to delete index fingerprint file:', error);
      }
    }

    const stateStorePath = path.join(this.workspacePath, '.augment-index-state.json');
    if (fs.existsSync(stateStorePath)) {
      try {
        fs.unlinkSync(stateStorePath);
        console.error(`Deleted index state store file: ${stateStorePath}`);
      } catch (error) {
        console.error('Failed to delete index state store file:', error);
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
   * Perform semantic search using the active retrieval provider.
   */
  async semanticSearch(
    query: string,
    topK: number = 10,
    options?: { bypassCache?: boolean; maxOutputLength?: number }
  ): Promise<SearchResult[]> {
    const metricsStart = Date.now();
    const debugSearch = process.env.CE_DEBUG_SEARCH === 'true';
    const bypassCache = options?.bypassCache ?? false;
    const retrievalProvider = this.getActiveAIProviderId();
    this.setLastSearchDiagnostics(null);

    // Use commit-aware cache key when reactive mode is enabled
    const memoryCacheKey = this.getCommitAwareCacheKey(query, topK, retrievalProvider);

    if (!bypassCache) {
      const cached = this.getCachedSearch(memoryCacheKey);
      if (cached) {
        this.cacheHits++;
        incCounter(
          'context_engine_semantic_search_total',
          { cache: 'memory', bypass: bypassCache ? 'true' : 'false' },
          1,
          'Total semanticSearch calls (labeled by cache path).'
        );
        observeDurationMs(
          'context_engine_semantic_search_duration_seconds',
          { cache: 'memory', bypass: bypassCache ? 'true' : 'false' },
          Date.now() - metricsStart,
          { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
        );
        if (debugSearch) {
          console.error(`[semanticSearch] Cache hit for query: ${query}`);
        }
        return cached;
      }
    }

    const retrieveFromAIProvider = async (): Promise<SearchResult[]> => {
      const compatEmptyArrayFallbackEnabled = process.env.CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK === 'true';
      const normalizedQuery = query.trim();
      const queryTokens = normalizedQuery
        .split(/[^a-z0-9_./-]+/i)
        .map((token) => token.trim())
        .filter(Boolean);
      const hasStrongIdentifierToken = queryTokens.some((token) => token.length >= 12);
      const isSingleTokenQuery = queryTokens.length === 1;

      const prompt = this.buildSemanticSearchPrompt(query, topK, options);
      const rawResponse = await this.searchAndAsk(query, prompt);
      const parseResult = this.parseAIProviderSearchResults(rawResponse, topK);
      if (parseResult !== null) {
        if (parseResult.length > 0) {
          return parseResult;
        }
        // Explicit [] from the provider is authoritative by default.
        // Temporary compatibility mode can re-enable keyword fallback.
        if (compatEmptyArrayFallbackEnabled) {
          return this.keywordFallbackSearch(query, topK);
        }
        return [];
      }

      let searchResults = this.parseFormattedResults(rawResponse, topK);

      if (searchResults.length > 0) {
        return searchResults;
      }

      if ((rawResponse && rawResponse.trim() !== '') || isSingleTokenQuery || hasStrongIdentifierToken) {
        return this.keywordFallbackSearch(query, topK);
      }

      return [];
    };

    const indexFingerprint = this.getIndexFingerprint();
    const persistentCacheKey = (indexFingerprint !== 'no-state' && indexFingerprint !== 'unknown')
      ? `${indexFingerprint}:${memoryCacheKey}`
      : null;

    if (!bypassCache && persistentCacheKey) {
      const persistent = this.getPersistentSearch(persistentCacheKey);
      if (persistent) {
        this.cacheHits++;
        incCounter(
          'context_engine_semantic_search_total',
          { cache: 'persistent', bypass: bypassCache ? 'true' : 'false' },
          1,
          'Total semanticSearch calls labeled by cache path.'
        );
        observeDurationMs(
          'context_engine_semantic_search_duration_seconds',
          { cache: 'persistent', bypass: bypassCache ? 'true' : 'false' },
          Date.now() - metricsStart,
          { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
        );
        return persistent;
      }
    }

    let searchResults: SearchResult[] = [];
    try {
      searchResults = await retrieveFromAIProvider();

      if (!bypassCache) {
        // Cache results
        this.setCachedSearch(memoryCacheKey, searchResults);
        if (persistentCacheKey) {
          this.setPersistentSearch(persistentCacheKey, searchResults);
        }
      }
      incCounter(
        'context_engine_semantic_search_total',
        { cache: 'miss', bypass: bypassCache ? 'true' : 'false' },
        1,
        'Total semanticSearch calls labeled by cache path.'
      );
      observeDurationMs(
        'context_engine_semantic_search_duration_seconds',
        { cache: 'miss', bypass: bypassCache ? 'true' : 'false' },
        Date.now() - metricsStart,
        { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
      );
      return searchResults;
    } catch (error) {
      console.error('Search failed:', error);
      incCounter(
        'context_engine_semantic_search_total',
        { cache: 'error', bypass: bypassCache ? 'true' : 'false' },
        1,
        'Total semanticSearch calls labeled by cache path.'
      );
      observeDurationMs(
        'context_engine_semantic_search_duration_seconds',
        { cache: 'error', bypass: bypassCache ? 'true' : 'false' },
        Date.now() - metricsStart,
        { help: 'semanticSearch end-to-end duration in seconds (includes cache hits).' }
      );
      try {
        return await this.keywordFallbackSearch(query, topK);
      } catch {
        return [];
      }
    }
  }

  /**
   * Deterministic local retrieval path for internal callers that should not depend on provider output format.
   */
  async localKeywordSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    return this.keywordFallbackSearch(query, topK);
  }

  private parseAIProviderSearchResults(raw: string, topK: number): SearchResult[] | null {
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

        const sanitizedPath = this.sanitizeResultPath(rawPath);
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

  /**
   * Perform AI-powered search + ask using the active provider.
   *
   * @param searchQuery - Semantic query to guide provider context.
   * @param prompt - Optional prompt to send to the provider.
   * @returns Provider response text.
   * @throws Error if provider invocation fails or authentication is invalid.
   */
  async searchAndAsk(
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number }
  ): Promise<string> {
    const metricsStart = Date.now();
    const providerId = this.getActiveAIProviderId();
    if (this.isOfflineMode()) {
      throw new Error(
        'Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1) does not allow CE_AI_PROVIDER=openai_session. Disable offline mode to use openai_session.'
      );
    }

    setGauge(
      'context_engine_search_and_ask_queue_depth',
      undefined,
      this.searchQueue.depth,
      'Number of searchAndAsk requests in-flight or waiting in the queue.'
    );
    incCounter('context_engine_search_and_ask_total', undefined, 1, 'Total searchAndAsk calls.');

    // Use the search queue to serialize searchAndAsk calls
    // This prevents potential SDK concurrency issues while allowing
    // other operations (file reads, semantic search) to run in parallel
    const defaultTimeoutMs = envMs('CE_AI_REQUEST_TIMEOUT_MS', DEFAULT_API_TIMEOUT_MS, {
      min: MIN_API_TIMEOUT_MS,
      max: MAX_API_TIMEOUT_MS,
    });
    const timeoutCandidate = options?.timeoutMs ?? defaultTimeoutMs;
    const requestedTimeoutMs = Number.isFinite(timeoutCandidate) ? timeoutCandidate : defaultTimeoutMs;
    const timeoutMs = Math.max(MIN_API_TIMEOUT_MS, Math.min(MAX_API_TIMEOUT_MS, requestedTimeoutMs));
    try {
      const admissionTimeoutError = this.getQueueTimeoutAdmissionError(timeoutMs);
      if (admissionTimeoutError) {
        throw admissionTimeoutError;
      }

      const response = await this.searchQueue.enqueue(async () => {
        try {
          const queueLength = this.searchQueue.length;
          console.error(
            `[searchAndAsk] Provider=${providerId}; query=${searchQuery}${queueLength > 0 ? ` (queue: ${queueLength} waiting)` : ''}`
          );

          const provider = this.getAIProvider();
          const innerResponse = await provider.call({
            searchQuery,
            prompt,
            timeoutMs,
            workspacePath: this.workspacePath,
          });
          if (!innerResponse || typeof innerResponse !== 'object' || typeof innerResponse.text !== 'string') {
            throw new Error(
              `AI provider (${provider.id}) returned invalid response: expected object with string text property`
            );
          }
          console.error(`[searchAndAsk] Response length: ${innerResponse.text.length}`);
          return innerResponse.text;
        } catch (error) {
          console.error('[searchAndAsk] Failed:', error);
          throw error;
        }
      }, timeoutMs);
      observeDurationMs(
        'context_engine_search_and_ask_duration_seconds',
        { result: 'success' },
        Date.now() - metricsStart,
        { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
      );
      return response;
    } catch (e) {
      if (e instanceof SearchQueueFullError) {
        incCounter(
          'context_engine_search_and_ask_rejected_total',
          { reason: 'queue_full' },
          1,
          'Total searchAndAsk calls rejected before execution.'
        );
        observeDurationMs(
          'context_engine_search_and_ask_duration_seconds',
          { result: 'queue_full' },
          Date.now() - metricsStart,
          { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
        );
      } else if (e instanceof SearchQueuePressureTimeoutError) {
        incCounter(
          'context_engine_search_and_ask_rejected_total',
          { reason: 'queue_timeout_budget' },
          1,
          'Total searchAndAsk calls rejected before execution.'
        );
        observeDurationMs(
          'context_engine_search_and_ask_duration_seconds',
          { result: 'queue_timeout_budget' },
          Date.now() - metricsStart,
          { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
        );
      } else {
        incCounter('context_engine_search_and_ask_errors_total', undefined, 1, 'Total searchAndAsk failures.');
        observeDurationMs(
          'context_engine_search_and_ask_duration_seconds',
          { result: 'error' },
          Date.now() - metricsStart,
          { help: 'searchAndAsk end-to-end duration in seconds (includes queue wait time).' }
        );
      }
      throw e;
    } finally {
      setGauge(
        'context_engine_search_and_ask_queue_depth',
        undefined,
        this.searchQueue.depth,
        'Number of searchAndAsk requests in-flight or waiting in the queue.'
      );
    }
  }

  /**
   * Conservative queue-admission heuristic for fast-fail timeout budgeting.
   * This avoids spending very small request budgets in high queue pressure scenarios.
   */
  private getQueueTimeoutAdmissionError(timeoutMs: number): SearchQueuePressureTimeoutError | null {
    const queueDepth = this.searchQueue.depth;
    if (queueDepth < SEARCH_QUEUE_TIMEOUT_ADMISSION_DEPTH_THRESHOLD) {
      return null;
    }

    const estimatedQueueDelayMs = Math.max(0, queueDepth - 1) * SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS;
    const minimumBudgetMs = estimatedQueueDelayMs + SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS;
    if (timeoutMs >= minimumBudgetMs) {
      return null;
    }

    return new SearchQueuePressureTimeoutError(timeoutMs, queueDepth, minimumBudgetMs);
  }

  /**
   * Fallback retrieval path when semantic formatting changes and no structured snippets can be parsed.
   * This performs a bounded keyword scan across indexable files to preserve tool usability.
   */
  private async keywordFallbackSearch(query: string, topK: number): Promise<SearchResult[]> {
    const rawQuery = query.trim();
    const includeArtifacts = /\binclude:artifacts\b/i.test(rawQuery);
    const includeDocs = /\binclude:docs\b/i.test(rawQuery);
    const includeJson = /\binclude:json\b/i.test(rawQuery);
    const cleanedQuery = rawQuery.replace(/\binclude:(artifacts|docs|json)\b/gi, ' ').trim();
    const normalizedQuery = cleanedQuery.toLowerCase();
    if (!normalizedQuery) return [];

    const stopwords = new Set(['and', 'the', 'for', 'with', 'from', 'that', 'this', 'where']);
    const queryTokens = Array.from(
      new Set(
        normalizedQuery
          .split(/[^a-z0-9_./-]+/i)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && !stopwords.has(token))
      )
    );
    if (queryTokens.length === 0) return [];

    const symbolTokens = Array.from(
      new Set(
        cleanedQuery
          .split(/[^A-Za-z0-9_./-]+/g)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3 && (/[A-Z_]/.test(token) || token.length >= 12))
          .map((token) => token.toLowerCase())
      )
    );

    const identifierLikeToken = cleanedQuery
      .split(/[^A-Za-z0-9_./-]+/g)
      .map((token) => token.trim())
      .filter(Boolean)
      .some((token) => /[A-Z_]/.test(token) || token.length >= 12);
    const codeIntent = /\b(function|class|interface|test|factory|provider|handler|module|api|implementation|code|file)\b/i.test(cleanedQuery)
      || identifierLikeToken;
    const opsEvidenceIntent = /\b(benchmark|report|receipt|metrics?|snapshot|artifact|baseline|json)\b/i.test(cleanedQuery);
    const pureCodeIntent = codeIntent && !opsEvidenceIntent;

    const files = await this.discoverFiles(this.workspacePath);
    if (files.length === 0) return [];
    const filtersApplied: string[] = [];
    if (pureCodeIntent && !includeArtifacts) filtersApplied.push('exclude:artifacts');
    if (codeIntent && !includeDocs) filtersApplied.push('deprioritize:docs');
    if (codeIntent && !includeJson) filtersApplied.push('deprioritize:json');

    const runPass = async (allowHardExclusions: boolean): Promise<{
      rankedResults: Array<SearchResult & { __score: number }>;
      filteredPathsCount: number;
    }> => {
      let filteredPathsCount = 0;
      const ranked = files
        .map((filePath) => {
          const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
          if (allowHardExclusions && pureCodeIntent && !includeArtifacts && normalizedPath.startsWith('artifacts/')) {
            filteredPathsCount += 1;
            return null;
          }

          const lowerPath = filePath.toLowerCase();
          let score = 0;
          if (lowerPath.includes(normalizedQuery)) score += 8;
          for (const token of queryTokens) {
            if (lowerPath.includes(token)) score += 2;
          }
          if (codeIntent) {
            if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('test/') || normalizedPath.startsWith('tests/')) {
              score += 8;
            }
            if (/\/__tests__\//.test(normalizedPath)) {
              score += 4;
            }
            if (!includeDocs && /^(docs|benchmark|bench|tmp|coverage|dist|build)\//.test(normalizedPath)) {
              score -= 8;
            }
            if (!includeJson && normalizedPath.endsWith('.json')) {
              score -= 5;
            } else if (!includeDocs && normalizedPath.endsWith('.md')) {
              score -= 3;
            }
          }
          return { filePath, score };
        })
        .filter((candidate): candidate is { filePath: string; score: number } => candidate !== null)
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

      const scanLimit = Math.min(
        Math.max(topK * 30, 120),
        ranked.length
      );
      const candidates = ranked.slice(0, scanLimit);
      const retrievedAt = new Date().toISOString();
      const scoredResults: Array<SearchResult & { __score: number }> = [];

      for (const candidate of candidates) {
        try {
          const content = await this.getFile(candidate.filePath);
          const lowerContent = content.toLowerCase();
          let matchIndex = lowerContent.indexOf(normalizedQuery);
          if (matchIndex === -1) {
            for (const token of queryTokens) {
              const idx = lowerContent.indexOf(token);
              if (idx !== -1) {
                matchIndex = idx;
                break;
              }
            }
          }
          if (matchIndex === -1) continue;

          const snippetStart = Math.max(0, matchIndex - 200);
          const snippetEnd = Math.min(content.length, matchIndex + 400);
          const snippet = content.substring(snippetStart, snippetEnd).trim();
          if (!snippet) continue;

          const normalizedPath = candidate.filePath.replace(/\\/g, '/').toLowerCase();
          let finalScore = candidate.score;
          const hasFactoryIntent = queryTokens.includes('factory');
          const hasProviderIntent = queryTokens.includes('provider');
          const hasTestIntent = queryTokens.includes('test') || queryTokens.includes('tests');
          if (lowerContent.includes(normalizedQuery)) {
            finalScore += 16;
          }
          for (const token of queryTokens) {
            if (lowerContent.includes(token)) {
              finalScore += 2;
            }
          }
          let symbolHitCount = 0;
          for (const symbol of symbolTokens) {
            if (lowerContent.includes(symbol)) {
              finalScore += 28;
              symbolHitCount += 1;
            }
            if (normalizedPath.includes(symbol)) {
              finalScore += 16;
            }
          }
          if (codeIntent) {
            if (symbolHitCount > 0) {
              finalScore += 70 * symbolHitCount;
            }
            if (/\/ai\/providers\//.test(normalizedPath)) finalScore += 14;
            if (/\/factory\.(ts|tsx|js|jsx)$/.test(normalizedPath)) finalScore += hasFactoryIntent ? 70 : 30;
            if (/\/factory\.test\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
              finalScore += hasFactoryIntent ? 65 : 25;
              if (hasTestIntent) finalScore += 30;
            }
            if (hasProviderIntent && /\/providers\//.test(normalizedPath)) {
              finalScore += 18;
            }
          }

          const startLine = content.slice(0, snippetStart).split('\n').length;
          const endLine = startLine + Math.max(0, snippet.split('\n').length - 1);

          scoredResults.push({
            path: candidate.filePath.replace(/\\/g, '/'),
            content: snippet,
            lines: `${startLine}-${Math.max(startLine, endLine)}`,
            relevanceScore: undefined,
            matchType: 'keyword',
            retrievedAt,
            __score: finalScore,
          });
        } catch {
          // Skip files that cannot be read in fallback mode.
        }
      }

      return {
        rankedResults: scoredResults
          .sort((a, b) => b.__score - a.__score || a.path.localeCompare(b.path))
          .slice(0, topK),
        filteredPathsCount,
      };
    };

    const firstPass = await runPass(true);
    let rankedResults = firstPass.rankedResults;
    let secondPassUsed = false;
    let filteredPathsCount = firstPass.filteredPathsCount;

    if (rankedResults.length === 0 && firstPass.filteredPathsCount > 0) {
      secondPassUsed = true;
      const secondPass = await runPass(false);
      rankedResults = secondPass.rankedResults;
      filteredPathsCount += secondPass.filteredPathsCount;
    }

    this.setLastSearchDiagnostics({
      filters_applied: filtersApplied,
      filtered_paths_count: filteredPathsCount,
      second_pass_used: secondPassUsed,
    });

    if (rankedResults.length === 0) {
      return [];
    }

    const maxScore = Math.max(...rankedResults.map((item) => item.__score));
    const minScore = Math.min(...rankedResults.map((item) => item.__score));
    const scoreRange = Math.max(1, maxScore - minScore);

    return rankedResults.map(({ __score, ...result }) => ({
      ...result,
      relevanceScore: Math.max(0, Math.min(1, 0.4 + (0.6 * (__score - minScore)) / scoreRange)),
    }));
  }

  private buildSemanticSearchPrompt(query: string, topK: number, options?: { maxOutputLength?: number }): string {
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
    ].join('\\n');
  }

  private sanitizeResultPath(rawPath: string): string | null {
    const normalized = rawPath.trim().replace(/\\\\/g, '/');
    if (!normalized) return null;
    if (path.isAbsolute(normalized)) return null;
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('..' + path.posix.sep)) return null;

    return normalized;
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
      bypassCache = false,
    } = options;

    const normalizedCacheOptions = {
      maxFiles,
      tokenBudget,
      includeRelated,
      minRelevance,
      includeSummaries,
      includeMemories,
    };

    const commitPrefix = (this.commitCacheEnabled && this.currentCommitHash)
      ? `${this.currentCommitHash.substring(0, 12)}:`
      : '';
    const indexFingerprint = this.getIndexFingerprint();
    const persistentCacheKey = (indexFingerprint !== 'no-state' && indexFingerprint !== 'unknown')
      ? `${indexFingerprint}:${commitPrefix}context:${query}:${JSON.stringify(normalizedCacheOptions)}`
      : null;

    if (!bypassCache) {
      if (persistentCacheKey) {
        const persistent = this.getPersistentContextBundle(persistentCacheKey);
        if (persistent) {
          incCounter(
            'context_engine_get_context_for_prompt_total',
            { cache: 'persistent' },
            1,
            'Total getContextForPrompt calls (labeled by cache path).'
          );
          observeDurationMs(
            'context_engine_get_context_for_prompt_duration_seconds',
            { cache: 'persistent' },
            Date.now() - startTime,
            { help: 'getContextForPrompt end-to-end duration in seconds (includes cache hits).' }
          );
          return persistent;
        }
      }
    }

    const semanticSearch = (q: string, k: number) =>
      bypassCache
        ? this.semanticSearch(q, k, { bypassCache: true })
        : this.semanticSearch(q, k);

    // Perform semantic search and memory retrieval in parallel
    const [searchResults, memories] = await Promise.all([
      semanticSearch(query, maxFiles * 3),
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

    const bundle: ContextBundle = {
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

    if (!bypassCache && persistentCacheKey) {
      this.setPersistentContextBundle(persistentCacheKey, bundle);
    }
    incCounter(
      'context_engine_get_context_for_prompt_total',
      { cache: 'miss' },
      1,
      'Total getContextForPrompt calls (labeled by cache path).'
    );
    observeDurationMs(
      'context_engine_get_context_for_prompt_duration_seconds',
      { cache: 'miss' },
      Date.now() - startTime,
      { help: 'getContextForPrompt end-to-end duration in seconds (includes cache hits).' }
    );
    return bundle;
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
