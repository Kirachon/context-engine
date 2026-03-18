/**
 * Layer 2: Context Service Layer
 *
 * This layer adapts raw retrieval from the legacy runtime (Layer 1)
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
import {
  JsonIndexStateStore,
  type IndexStateFile,
  type IndexStateLoadMetadata,
} from './indexStateStore.js';
import { createAIProvider, resolveAIProviderId } from '../ai/providers/factory.js';
import type { AIProvider, AIProviderId } from '../ai/providers/types.js';
import { createRetrievalProvider } from '../retrieval/providers/factory.js';
import { resolveRetrievalProviderId, shouldRunShadowCompare } from '../retrieval/providers/env.js';
import {
  parseFormattedResults as parseFormattedSemanticResults,
  searchWithSemanticRuntime,
} from '../retrieval/providers/semanticRuntime.js';
import {
  buildConnectorFingerprint,
  createConnectorRegistry,
  formatConnectorHint,
} from '../internal/connectors/registry.js';
import { isOperationalDocsQuery } from '../retrieval/providers/queryHeuristics.js';
import type {
  RetrievalProviderCallbackContext,
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from '../retrieval/providers/types.js';

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
  /** Short reason this file was selected into the context pack. */
  selectionRationale?: string;
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
  /** Dependency map between selected files and related file suggestions. */
  dependencyMap?: Record<string, string[]>;
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
const FALLBACK_DISCOVER_FILES_CACHE_TTL_MS = envMs('CE_FALLBACK_DISCOVER_FILES_CACHE_TTL_MS', 30_000, {
  min: 0,
  max: 5 * 60_000,
});
const FALLBACK_SEARCH_READ_CONCURRENCY = envInt('CE_FALLBACK_SEARCH_READ_CONCURRENCY', 8, {
  min: 1,
  max: 16,
});
type SearchAndAskPriority = 'interactive' | 'background';
type SearchQueueRejectMode = 'observe' | 'shadow' | 'enforce';

function resolveSearchQueueRejectMode(raw: string | undefined): SearchQueueRejectMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'observe' || normalized === 'shadow' || normalized === 'enforce') {
    return normalized;
  }
  return 'enforce';
}

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
 * Queue for serializing searchAndAsk calls to prevent provider runtime concurrency issues.
 *
 * The active semantic retrieval runtime may not be thread-safe for concurrent
 * searchAndAsk calls. This queue ensures only one call runs at a time
 * while allowing other operations to continue.
 *
 * Includes timeout protection to prevent indefinite hangs on API calls.
 */
class SearchQueueFullError extends Error {
  readonly code = 'SEARCH_QUEUE_FULL';
  readonly retryAfterMs: number;

  constructor(
    maxQueueSize: number,
    lane: SearchAndAskPriority,
    envVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    retryAfterMs: number
  ) {
    super(
      `Search queue is full for ${lane} lane (max ${maxQueueSize}). Try again later or increase ${envVarName}. retry_after_ms=${retryAfterMs}`
    );
    this.name = 'SearchQueueFullError';
    this.retryAfterMs = retryAfterMs;
  }
}

class SearchQueuePressureTimeoutError extends Error {
  readonly code = 'SEARCH_QUEUE_PRESSURE_TIMEOUT';

  constructor(timeoutMs: number, queueDepth: number, minimumBudgetMs: number, lane: SearchAndAskPriority) {
    super(
      `searchAndAsk timeout budget (${timeoutMs}ms) is too small for ${lane} lane queue depth (${queueDepth}). ` +
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
    removeAbortListener?: () => void;
  }> = [];
  private running = false;
  private maxQueueSize: number;
  private lane: SearchAndAskPriority;
  private maxQueueEnvVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND';
  private rejectMode: SearchQueueRejectMode;

  constructor(
    maxQueueSize: number,
    lane: SearchAndAskPriority,
    maxQueueEnvVarName: 'CE_SEARCH_AND_ASK_QUEUE_MAX' | 'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    rejectMode: SearchQueueRejectMode
  ) {
    this.maxQueueSize = maxQueueSize;
    this.lane = lane;
    this.maxQueueEnvVarName = maxQueueEnvVarName;
    this.rejectMode = rejectMode;
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
  async enqueue(
    fn: () => Promise<string>,
    timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(new Error('searchAndAsk request cancelled before queue admission.'));
    }
    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      const retryAfterMs =
        Math.max(1, this.queue.length) * SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS + SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS;
      if (this.rejectMode === 'enforce') {
        return Promise.reject(
          new SearchQueueFullError(this.maxQueueSize, this.lane, this.maxQueueEnvVarName, retryAfterMs)
        );
      }
      console.error(
        `[SearchQueue] ${this.rejectMode} mode: queue saturation observed for ${this.lane} lane; ` +
        `max=${this.maxQueueSize} current=${this.queue.length} retry_after_ms=${retryAfterMs}`
      );
    }
    return new Promise<string>((resolve, reject) => {
      const item: {
        execute: () => Promise<string>;
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timeoutMs: number;
        settled: boolean;
        timer: NodeJS.Timeout;
        removeAbortListener?: () => void;
      } = {
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
      const settleWithError = (error: Error): void => {
        if (item.settled) return;
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
        item.reject(error);
      };
      const onAbort = () => {
        settleWithError(new Error('searchAndAsk request cancelled while waiting in queue.'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        item.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
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
        item.removeAbortListener?.();
        item.resolve(result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SearchQueue] Request failed: ${errorMessage}`);
      if (!item.settled) {
        item.settled = true;
        clearTimeout(item.timer);
        item.removeAbortListener?.();
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
        item.removeAbortListener?.();
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
  '.thrift',    // Apache Thrift IDL
  '.avsc',      // Avro schema
  '.avdl',      // Avro IDL
  '.capnp',     // Cap'n Proto schema
  '.openapi', '.swagger',

  // === Shell Scripts ===
  '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd',

  // === Infrastructure & DevOps ===
  '.dockerfile',
  '.tf', '.hcl',  // Terraform
  '.nix',         // Nix configuration
  '.bicep',       // Azure Bicep templates
  '.rego',        // Open Policy Agent
  '.cue',         // CUE configuration language
  '.jsonnet', '.libsonnet', // Jsonnet
  '.http', '.rest', // API request collections

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
  '.tcl',                   // Tcl scripting

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
  '.sln',                   // Visual Studio solution

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

  // === Additional Enterprise/Scientific Languages ===
  '.kql',                   // Kusto query language
  '.sol',                   // Solidity
  '.sv', '.vh', '.vhd', '.vhdl', // Hardware description languages
  '.cob', '.cbl', '.cpy',   // COBOL
  '.f', '.f90', '.f95', '.f03', '.f08', // Fortran
  '.pas', '.pp',            // Pascal

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
  private indexChain: Promise<void> = Promise.resolve();
  private indexStateStore: JsonIndexStateStore | null = null;
  private indexStateProviderMismatchWarned = false;
  private indexStateSchemaWarningWarned = false;

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

  /** Loaded ignore patterns (from .gitignore and .contextignore) */
  private ignorePatterns: string[] = [];

  /** Flag to track if ignore patterns have been loaded */
  private ignorePatternsLoaded: boolean = false;

  /**
   * Queue lanes for serializing searchAndAsk calls to prevent SDK concurrency issues.
   * Interactive lane remains default behavior. Background lane isolates long-running
   * non-interactive work so it cannot starve user-facing requests.
   */
  private readonly searchQueueInteractiveMax = envInt('CE_SEARCH_AND_ASK_QUEUE_MAX', DEFAULT_SEARCH_QUEUE_MAX);
  private readonly searchQueueBackgroundMax = envInt(
    'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
    this.searchQueueInteractiveMax
  );
  private readonly searchQueueRejectMode = resolveSearchQueueRejectMode(process.env.CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE);
  private readonly searchQueues: Record<SearchAndAskPriority, SearchQueue> = {
    interactive: new SearchQueue(
      this.searchQueueInteractiveMax,
      'interactive',
      'CE_SEARCH_AND_ASK_QUEUE_MAX',
      this.searchQueueRejectMode
    ),
    background: new SearchQueue(
      this.searchQueueBackgroundMax,
      'background',
      'CE_SEARCH_AND_ASK_QUEUE_MAX_BACKGROUND',
      this.searchQueueRejectMode
    ),
  };

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
  private readonly retrievalProviderId: RetrievalProviderId;
  private readonly retrievalProvider: RetrievalProvider;
  private readonly connectorRegistry = createConnectorRegistry();
  private aiProvider: AIProvider | null = null;
  private lastSearchDiagnostics: SearchDiagnostics | null = null;
  private fallbackDiscoverFilesCache: {
    cacheKey: string;
    cachedAt: number;
    files: string[];
  } | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.aiProviderId = resolveAIProviderId();
    const activeRetrievalProviderId = resolveRetrievalProviderId();
    this.retrievalProvider = createRetrievalProvider({
      providerId: activeRetrievalProviderId,
      callbacks: this.createRetrievalProviderCallbacks(),
    });
    this.retrievalProviderId = this.retrievalProvider.id;
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

  getActiveRetrievalProviderId(): RetrievalProviderId {
    return this.retrievalProviderId;
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

  private createRetrievalProviderCallbacks(): RetrievalProviderCallbacks {
    return {
      localNative: {
        search: (
          query: string,
          topK: number,
          options?: { bypassCache?: boolean; maxOutputLength?: number }
        ) => this.searchWithProviderRuntime(query, topK, options),
        indexWorkspace: () => this.indexWorkspaceLocalNativeFallback(),
        indexFiles: (filePaths: string[]) => this.indexFilesLocalNativeFallback(filePaths),
        clearIndex: () => this.clearIndexWithProviderRuntime({ localNative: true }),
        getIndexStatus: async () => this.getIndexStatus(),
        health: async (context?: RetrievalProviderCallbackContext) => ({
          ok: true,
          details: `retrieval_provider=${this.getRetrievalProviderCallbackProviderId(context)}`,
        }),
      },
    };
  }

  private getRetrievalProviderCallbackProviderId(
    context?: RetrievalProviderCallbackContext
  ): RetrievalProviderId {
    return context?.providerId ?? this.retrievalProviderId;
  }

  private getFallbackDiscoverFilesCacheKey(): string {
    return this.workspacePath;
  }

  private async getCachedFallbackFiles(): Promise<string[]> {
    const cacheKey = this.getFallbackDiscoverFilesCacheKey();
    const now = Date.now();
    const cached = this.fallbackDiscoverFilesCache;
    if (
      cached
      && cached.cacheKey === cacheKey
      && (now - cached.cachedAt) <= FALLBACK_DISCOVER_FILES_CACHE_TTL_MS
    ) {
      return cached.files;
    }

    const files = await this.discoverFiles(this.workspacePath);
    this.fallbackDiscoverFilesCache = {
      cacheKey,
      cachedAt: now,
      files,
    };
    return files;
  }

  private getAIProvider(): AIProvider {
    if (!this.aiProvider) {
      try {
        this.aiProvider = createAIProvider({
          providerId: this.aiProviderId,
          getProviderContext: async () => {
            throw new Error('OpenAI-only provider policy: legacy retrieval runtime path is disabled.');
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

  private warnIndexStateLoadMetadata(metadata: IndexStateLoadMetadata): void {
    if (metadata.warnings.length === 0 || this.indexStateSchemaWarningWarned) {
      return;
    }
    this.indexStateSchemaWarningWarned = true;
    console.warn(`[ContextServiceClient] ${metadata.warnings[0]}`);
  }

  private loadIndexStateForActiveProvider(store: JsonIndexStateStore): IndexStateFile {
    const loaded = store.loadWithMetadata();
    this.warnIndexStateLoadMetadata(loaded.metadata);

    if (typeof loaded.metadata.unsupported_schema_version === 'number') {
      return {
        ...loaded.state,
        provider_id: this.retrievalProviderId,
        files: {},
      };
    }

    if (loaded.state.provider_id === this.retrievalProviderId) {
      return loaded.state;
    }

    if (!this.indexStateProviderMismatchWarned) {
      this.indexStateProviderMismatchWarned = true;
      console.warn(
        `[ContextServiceClient] Ignoring index state entries for provider "${loaded.state.provider_id}" while active provider is "${this.retrievalProviderId}".`
      );
    }

    return {
      ...loaded.state,
      provider_id: this.retrievalProviderId,
      files: {},
    };
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
    const isSuccessfulIndexCycle =
      this.indexStatus.status === 'indexing' &&
      partial.status === 'idle' &&
      partial.lastIndexed !== undefined &&
      partial.lastIndexed !== null;
    const shouldClearLastError = Object.prototype.hasOwnProperty.call(partial, 'lastError')
      && partial.lastError === undefined
      && isSuccessfulIndexCycle;
    const normalizedPartial: Partial<IndexStatus> = { ...partial };
    if (
      !shouldClearLastError &&
      Object.prototype.hasOwnProperty.call(normalizedPartial, 'lastError') &&
      normalizedPartial.lastError === undefined
    ) {
      delete normalizedPartial.lastError;
    }
    const nextLastIndexed = this.resolveLastIndexed(partial.lastIndexed);
    const nextIsStale =
      normalizedPartial.isStale !== undefined
        ? normalizedPartial.isStale
        : this.computeIsStale(nextLastIndexed);

    this.indexStatus = {
      ...this.indexStatus,
      ...normalizedPartial,
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
        const known = Object.keys(this.loadIndexStateForActiveProvider(store).files).length;
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
    this.fallbackDiscoverFilesCache = null;
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
  private getCommitAwareCacheKey(query: string, topK: number, providerId?: RetrievalProviderId): string {
    const retrievalProvider = providerId ?? this.getActiveRetrievalProviderId();
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

  private isLocalNativeRetrievalProvider(): boolean {
    return this.retrievalProviderId === 'local_native';
  }

  private writeLocalNativeStateMarker(indexedAtIso: string): void {
    const stateFilePath = this.getStateFilePath();
    const payload = {
      version: 1,
      provider: this.retrievalProviderId,
      indexedAt: indexedAtIso,
    };
    try {
      fs.writeFileSync(stateFilePath, JSON.stringify(payload), 'utf-8');
    } catch {
      // Best-effort; index status can still be derived from in-memory metadata.
    }
  }

  private async indexWorkspaceLocalNativeFallback(): Promise<IndexResult> {
    const startTime = Date.now();
    this.loadIgnorePatterns();
    const filePaths = await this.discoverFiles(this.workspacePath);
    const indexedAtIso = new Date().toISOString();
    if (filePaths.length === 0) {
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

    const store = this.getIndexStateStore();
    const prior = store ? this.loadIndexStateForActiveProvider(store) : null;
    const nextFiles: Record<string, { hash: string; indexed_at: string }> = {};
    let indexed = 0;
    let skipped = 0;
    let unchangedSkipped = 0;
    const skipUnchanged = Boolean(store) && featureEnabled('skip_unchanged_indexing');

    for (const relativePath of filePaths) {
      const contents = await this.readFileContentsAsync(relativePath);
      if (contents === null) {
        skipped += 1;
        continue;
      }

      const nextHash = this.hashContent(contents);
      if (skipUnchanged) {
        const previous = prior?.files[relativePath];
        if (previous?.hash === nextHash) {
          unchangedSkipped += 1;
          nextFiles[relativePath] = previous;
          continue;
        }
      }

      indexed += 1;
      if (store) {
        nextFiles[relativePath] = {
          hash: nextHash,
          indexed_at: indexedAtIso,
        };
      }
    }

    if (store) {
      store.save({
        version: typeof prior?.version === 'number' ? prior.version + 1 : 2,
        provider_id: this.retrievalProviderId,
        updated_at: indexedAtIso,
        files: nextFiles,
      });
    }

    this.writeLocalNativeStateMarker(indexedAtIso);
    this.writeIndexFingerprintFile(crypto.randomUUID());
    this.updateIndexStatus({
      status: 'idle',
      lastIndexed: indexedAtIso,
      fileCount: store ? Object.keys(nextFiles).length : filePaths.length - skipped,
      lastError: undefined,
    });
    this.clearCache();

    return {
      indexed,
      skipped: skipped + unchangedSkipped,
      errors: [],
      duration: Date.now() - startTime,
      totalIndexable: filePaths.length - skipped,
      unchangedSkipped,
    };
  }

  private async indexFilesLocalNativeFallback(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    this.loadIgnorePatterns();
    const uniquePaths = Array.from(new Set(filePaths));
    const normalizedPaths: string[] = [];
    let skipped = 0;

    for (const rawPath of uniquePaths) {
      const relativePath = path.isAbsolute(rawPath)
        ? path.relative(this.workspacePath, rawPath)
        : rawPath;
      if (!relativePath || relativePath.startsWith('..')) {
        skipped += 1;
        continue;
      }
      if (this.shouldIgnorePath(relativePath) || !this.shouldIndexFile(relativePath)) {
        skipped += 1;
        continue;
      }
      normalizedPaths.push(relativePath);
    }

    if (normalizedPaths.length === 0) {
      this.updateIndexStatus({
        status: 'error',
        lastError: 'No indexable file changes provided',
      });
      this.clearCache();
      return {
        indexed: 0,
        skipped,
        errors: ['No indexable file changes provided'],
        duration: Date.now() - startTime,
      };
    }

    const indexedAtIso = new Date().toISOString();
    const store = this.getIndexStateStore();
    const prior = store ? this.loadIndexStateForActiveProvider(store) : null;
    const nextFiles: Record<string, { hash: string; indexed_at: string }> = prior ? { ...prior.files } : {};
    let indexed = 0;

    for (const relativePath of normalizedPaths) {
      const contents = await this.readFileContentsAsync(relativePath);
      if (contents === null) {
        skipped += 1;
        if (store) {
          delete nextFiles[relativePath];
        }
        continue;
      }
      indexed += 1;
      if (store) {
        nextFiles[relativePath] = {
          hash: this.hashContent(contents),
          indexed_at: indexedAtIso,
        };
      }
    }

    if (store && prior) {
      store.save({
        version: typeof prior.version === 'number' ? prior.version + 1 : 2,
        provider_id: this.retrievalProviderId,
        updated_at: indexedAtIso,
        files: nextFiles,
      });
    }

    this.writeLocalNativeStateMarker(indexedAtIso);
    this.writeIndexFingerprintFile(crypto.randomUUID());
    this.updateIndexStatus({
      status: indexed > 0 ? 'idle' : 'error',
      lastIndexed: indexed > 0 ? indexedAtIso : undefined,
      fileCount: store ? Object.keys(nextFiles).length : Math.max(this.indexStatus.fileCount, indexed),
      lastError: indexed > 0 ? undefined : 'No indexable file changes provided',
    });
    this.clearCache();

    return {
      indexed,
      skipped,
      errors: indexed > 0 ? [] : ['No indexable file changes provided'],
      duration: Date.now() - startTime,
    };
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * Index the workspace directory via the active retrieval provider.
   */
  async indexWorkspace(): Promise<IndexResult> {
    return this.retrievalProvider.indexWorkspace();
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

    if (this.isLocalNativeRetrievalProvider()) {
      await this.indexWorkspace();
      return;
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

            this.clearCache();

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
    return this.retrievalProvider.indexFiles(filePaths);
  }

  /**
   * Clear index state and caches
   */
  async clearIndex(): Promise<void> {
    await this.retrievalProvider.clearIndex();
  }

  private async clearIndexWithProviderRuntime(options?: { localNative?: boolean }): Promise<void> {
    if (options?.localNative) {
      console.error('[clearIndex] Clearing local_native retrieval metadata.');
    }
    this.indexStatusDiskHydrated = false;

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

    const stateFilePath = this.getStateFilePath();
    if (fs.existsSync(stateFilePath)) {
      try {
        fs.unlinkSync(stateFilePath);
        console.error(`Deleted retrieval state marker file: ${stateFilePath}`);
      } catch (error) {
        console.error('Failed to delete retrieval state marker file:', error);
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
    const retrievalProvider = this.getActiveRetrievalProviderId();
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
      searchResults = await this.retrievalProvider.search(query, topK, options);

      if (!bypassCache) {
        // Cache results
        this.setCachedSearch(memoryCacheKey, searchResults);
        if (persistentCacheKey) {
          this.setPersistentSearch(persistentCacheKey, searchResults);
        }
      }
      this.maybeRunRetrievalShadowCompare(query, topK, searchResults);
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

  private async searchWithProviderRuntime(
    query: string,
    topK: number,
    options?: { bypassCache?: boolean; maxOutputLength?: number }
  ): Promise<SearchResult[]> {
    const semanticTimeoutMs = envMs('CE_SEMANTIC_SEARCH_AI_TIMEOUT_MS', 30_000, {
      min: MIN_API_TIMEOUT_MS,
      max: MAX_API_TIMEOUT_MS,
    });
    const parallelFallback = process.env.CE_SEMANTIC_PARALLEL_FALLBACK === 'true';
    return searchWithSemanticRuntime(query, topK, {
      ...options,
      timeoutMs: semanticTimeoutMs,
      parallelFallback,
    }, {
      searchAndAsk: (searchQuery, prompt, runtimeOptions) =>
        this.searchAndAsk(searchQuery, prompt, {
          timeoutMs: runtimeOptions?.timeoutMs ?? semanticTimeoutMs,
          priority: 'interactive',
        }),
      keywordFallbackSearch: (fallbackQuery, fallbackTopK) =>
        this.keywordFallbackSearch(fallbackQuery, fallbackTopK),
    });
  }

  /**
   * Deterministic local retrieval path for internal callers that should not depend on provider output format.
   */
  async localKeywordSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    return this.keywordFallbackSearch(query, topK);
  }

  private maybeRunRetrievalShadowCompare(query: string, topK: number, primaryResults: SearchResult[]): void {
    const rawSampleRate = Number.parseFloat(process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE ?? '0');
    const sampleRate = Number.isFinite(rawSampleRate)
      ? Math.max(0, Math.min(1, rawSampleRate))
      : 0;
    if (!shouldRunShadowCompare({
      shadowCompareEnabled: process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED === 'true',
      shadowSampleRate: sampleRate,
    })) {
      return;
    }

    setImmediate(() => {
      void this.runRetrievalShadowCompare(query, topK, primaryResults, sampleRate);
    });
  }

  private async runRetrievalShadowCompare(
    query: string,
    topK: number,
    primaryResults: SearchResult[],
    sampleRate: number
  ): Promise<void> {
    const previousDiagnostics = this.getLastSearchDiagnostics();
    try {
      const shadowResults = await this.keywordFallbackSearch(query, topK);
      const primaryPaths = new Set(primaryResults.map((result) => result.path));
      const shadowPaths = new Set(shadowResults.map((result) => result.path));
      let overlap = 0;
      for (const candidate of primaryPaths) {
        if (shadowPaths.has(candidate)) {
          overlap += 1;
        }
      }

      const queryHash = crypto.createHash('sha1').update(query).digest('hex').slice(0, 10);
      console.error(
        `[retrieval_shadow_compare] provider=${this.getActiveRetrievalProviderId()} sample_rate=${sampleRate.toFixed(2)} ` +
        `query_hash=${queryHash} primary=${primaryResults.length} shadow=${shadowResults.length} overlap=${overlap}`
      );
    } catch {
      // Shadow compare is best-effort only and must not affect primary retrieval.
    } finally {
      this.setLastSearchDiagnostics(previousDiagnostics);
    }
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
    options?: { timeoutMs?: number; priority?: SearchAndAskPriority; signal?: AbortSignal }
  ): Promise<string> {
    const metricsStart = Date.now();
    const providerId = this.getActiveAIProviderId();
    const priority: SearchAndAskPriority = options?.priority === 'background' ? 'background' : 'interactive';
    const searchQueue = this.searchQueues[priority];
    if (this.isOfflineMode()) {
      throw new Error(
        'Offline mode enforced (CONTEXT_ENGINE_OFFLINE_ONLY=1) does not allow CE_AI_PROVIDER=openai_session. Disable offline mode to use openai_session.'
      );
    }

    this.publishSearchQueueDepthMetrics();
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
      const admissionTimeoutError = this.getQueueTimeoutAdmissionError(timeoutMs, priority);
      if (admissionTimeoutError) {
        throw admissionTimeoutError;
      }

      const response = await searchQueue.enqueue(async () => {
        try {
          const queueLength = searchQueue.length;
          console.error(
            `[searchAndAsk] Provider=${providerId}; lane=${priority}; query=${searchQuery}${queueLength > 0 ? ` (queue: ${queueLength} waiting)` : ''}`
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
      }, timeoutMs, options?.signal);
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
      this.publishSearchQueueDepthMetrics();
    }
  }

  private publishSearchQueueDepthMetrics(): void {
    const interactiveDepth = this.searchQueues.interactive.depth;
    const backgroundDepth = this.searchQueues.background.depth;
    const helpText = 'Number of searchAndAsk requests in-flight or waiting in the queue.';

    setGauge('context_engine_search_and_ask_queue_depth', undefined, interactiveDepth + backgroundDepth, helpText);
    setGauge('context_engine_search_and_ask_queue_depth', { lane: 'interactive' }, interactiveDepth, helpText);
    setGauge('context_engine_search_and_ask_queue_depth', { lane: 'background' }, backgroundDepth, helpText);
  }

  /**
   * Conservative queue-admission heuristic for fast-fail timeout budgeting.
   * This avoids spending very small request budgets in high queue pressure scenarios.
   */
  private getQueueTimeoutAdmissionError(
    timeoutMs: number,
    priority: SearchAndAskPriority
  ): SearchQueuePressureTimeoutError | null {
    const queueDepth = this.searchQueues[priority].depth;
    if (queueDepth < SEARCH_QUEUE_TIMEOUT_ADMISSION_DEPTH_THRESHOLD) {
      return null;
    }

    const estimatedQueueDelayMs = Math.max(0, queueDepth - 1) * SEARCH_QUEUE_TIMEOUT_ADMISSION_SLOT_MS;
    const minimumBudgetMs = estimatedQueueDelayMs + SEARCH_QUEUE_TIMEOUT_EXECUTION_FLOOR_MS;
    if (timeoutMs >= minimumBudgetMs) {
      return null;
    }

    return new SearchQueuePressureTimeoutError(timeoutMs, queueDepth, minimumBudgetMs, priority);
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

    const files = await this.getCachedFallbackFiles();
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

      const scoreCandidate = async (
        candidate: { filePath: string; score: number }
      ): Promise<(SearchResult & { __score: number }) | null> => {
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
          if (matchIndex === -1) return null;

          const snippetStart = Math.max(0, matchIndex - 200);
          const snippetEnd = Math.min(content.length, matchIndex + 400);
          const snippet = content.substring(snippetStart, snippetEnd).trim();
          if (!snippet) return null;

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
            if (/\/ai\/providers\//.test(normalizedPath)) {
              finalScore += 14;
            }
            if (/\/factory\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
              finalScore += hasFactoryIntent ? 70 : 30;
            }
            if (/\/factory\.test\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
              finalScore += hasFactoryIntent ? 65 : 25;
              if (hasTestIntent) {
                finalScore += 30;
              }
            }
            if (hasProviderIntent && /\/providers\//.test(normalizedPath)) {
              finalScore += 18;
            }
          }

          const startLine = content.slice(0, snippetStart).split('\n').length;
          const endLine = startLine + Math.max(0, snippet.split('\n').length - 1);

          return {
            path: candidate.filePath.replace(/\\/g, '/'),
            content: snippet,
            lines: `${startLine}-${Math.max(startLine, endLine)}`,
            relevanceScore: undefined,
            matchType: 'keyword',
            retrievedAt,
            __score: finalScore,
          };
        } catch {
          // Skip files that cannot be read in fallback mode.
          return null;
        }
      };

      const concurrency = Math.max(1, Math.min(FALLBACK_SEARCH_READ_CONCURRENCY, candidates.length));
      for (let index = 0; index < candidates.length; index += concurrency) {
        const batch = candidates.slice(index, index + concurrency);
        const batchResults = await Promise.all(batch.map((candidate) => scoreCandidate(candidate)));
        for (const result of batchResults) {
          if (result) {
            scoredResults.push(result);
          }
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

  private parseFormattedResults(formattedResults: string, topK: number): SearchResult[] {
    return parseFormattedSemanticResults(formattedResults, topK);
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
    const connectorSignals = await this.connectorRegistry.collectSignals(this.workspacePath);
    const connectorFingerprint = buildConnectorFingerprint(connectorSignals);
    const persistentCacheKey = (indexFingerprint !== 'no-state' && indexFingerprint !== 'unknown')
      ? `${indexFingerprint}:${connectorFingerprint}:${commitPrefix}context:${query}:${JSON.stringify(normalizedCacheOptions)}`
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

    const useLocalKeywordSearchFirst = isOperationalDocsQuery(query);
    const searchResultsPromise = useLocalKeywordSearchFirst
      ? this.localKeywordSearch(query, maxFiles * 3)
          .then(results => (results.length > 0 ? results : semanticSearch(query, maxFiles * 3)))
          .catch(() => semanticSearch(query, maxFiles * 3))
      : semanticSearch(query, maxFiles * 3);

    // Perform search and memory retrieval in parallel
    const [searchResults, memories] = await Promise.all([
      searchResultsPromise,
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
        selectionRationale: `Top relevance ${(fileRelevance.get(filePath) || 0).toFixed(2)} with ${snippets.length} snippet(s)` +
          (summary ? `; ${summary}` : ''),
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

    if (connectorSignals.length > 0) {
      for (const signal of connectorSignals) {
        hints.push(formatConnectorHint(signal));
      }
    }

    // Build context summary
    const summary = this.generateContextSummary(query, files);

    const searchTimeMs = Date.now() - startTime;

    const bundle: ContextBundle = {
      summary,
      query,
      files,
      hints,
      dependencyMap: includeRelated
        ? Object.fromEntries(
            files
              .filter((file) => (file.relatedFiles?.length ?? 0) > 0)
              .map((file) => [file.path, file.relatedFiles ?? []])
          )
        : undefined,
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
