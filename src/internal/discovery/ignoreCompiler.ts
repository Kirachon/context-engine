/**
 * R3a — canonical discovery ignore compiler.
 *
 * Compiles the full set of inputs that decide whether a workspace path is
 * eligible for indexing (default excluded directories, default excluded
 * file patterns, `.gitignore`, `.contextignore`/`.augment-ignore`, and any
 * caller-supplied overrides) into one deterministic, order-preserving rule
 * set with proper gitignore-style negation semantics.
 *
 * This module is intentionally standalone: it does not read from or write
 * to any existing consumer (service client, watcher, chunk/vector stores,
 * or the graph store). It exists so `discoveryManifest.ts` can produce one
 * canonical eligible-file manifest without those consumers being migrated
 * yet (see R3b1-3).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

/**
 * Bump whenever the *semantics* of ignore-rule compilation or matching
 * change (not when the default lists below change -- those are covered by
 * the rule fingerprint itself). This feeds the manifest's schema
 * fingerprint so consumers can detect a behavior-affecting engine change
 * even when the on-disk ignore files are byte-identical.
 */
export const IGNORE_RULE_ENGINE_VERSION = 'discovery-ignore-v1';

/** Directories that are always excluded and can never be re-included via negation. */
export const DEFAULT_EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  // Package/dependency directories
  'node_modules', 'vendor', 'Pods', '.pub-cache', 'packages',
  // Build output directories
  'dist', 'build', 'out', 'target', 'bin', 'obj', 'release', 'debug', '.output',
  // Version control
  '.git', '.svn', '.hg', '.fossil',
  // Python virtual environments & caches
  '__pycache__', 'venv', '.venv', 'env', '.env', '.tox', '.nox', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'htmlcov', '.eggs',
  // Flutter/Dart
  '.dart_tool', '.flutter-plugins', '.flutter-plugins-dependencies', 'ephemeral', '.symlinks',
  // Gradle/Android
  '.gradle',
  // IDE & editor directories
  '.idea', '.vscode', '.vs', '.fleet', '.zed', '.cursor',
  // Test coverage & reports
  'coverage', '.nyc_output', 'test-results', 'reports',
  // Modern build tools
  '.next', '.nuxt', '.svelte-kit', '.astro', '.cache', '.parcel-cache', '.turbo',
  '.angular', '.webpack', '.esbuild', '.rollup.cache',
  // Context Engine own state
  '.context-engine-memory-suggestions', '.context-engine-graph', '.context-engine-lancedb', '.memories',
  // Temporary & generated
  'tmp', 'temp', '.tmp', '.temp', 'logs',
];

/** File-name glob patterns that are always excluded by default (gitignore-style, negatable). */
export const DEFAULT_EXCLUDED_FILE_PATTERNS: readonly string[] = [
  '*.min.js', '*.min.css', '*.bundle.js', '*.chunk.js',
  '*.map', '*.js.map', '*.css.map',
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock', 'pubspec.lock', 'bun.lockb', 'shrinkwrap.yaml',
  '*.g.dart', '*.freezed.dart', '*.mocks.dart', '*.gr.dart', '*.pb.dart', '*.pbjson.dart', '*.pbserver.dart',
  '*.generated.ts', '*.generated.js', '*.pb.go', '*.pb.cc', '*.pb.h', '*_pb2.py', '*_pb2_grpc.py',
  '*.log', '*.tmp', '*.temp', '*.bak', '*.swp', '*.swo', '*~',
  '.context-engine-search-cache.json', '.augment-search-cache.json',
  '*.pyc', '*.pyo', '*.pyd',
  '*.class', '*.jar', '*.war', '*.ear',
  '*.dll', '*.exe', '*.so', '*.dylib', '*.a', '*.lib', '*.o', '*.obj', '*.wasm', '*.dill',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.bmp', '*.webp', '*.ico', '*.icns', '*.tiff', '*.tif',
  '*.svg', '*.psd', '*.ai', '*.sketch',
  '*.ttf', '*.otf', '*.woff', '*.woff2', '*.eot',
  '*.mp3', '*.mp4', '*.wav', '*.ogg', '*.webm', '*.mov', '*.avi', '*.flv', '*.m4a', '*.m4v',
  '*.pdf', '*.doc', '*.docx', '*.xls', '*.xlsx', '*.ppt', '*.pptx', '*.zip', '*.tar', '*.gz', '*.rar', '*.7z',
  '.env', '.env.local', '.env.development', '.env.production', '.env.staging',
  '*.key', '*.pem', '*.p12', '*.jks', '*.keystore', 'secrets.yaml', 'secrets.json',
  '*.iml', '.project', '.classpath',
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '*.stamp',
];

/** Hidden (dot-prefixed) entry names that remain eligible despite the default hidden-entry rule. */
export const HIDDEN_ENTRY_ALLOWLIST: readonly string[] = [
  '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc', '.npmignore',
  '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc', '.editorconfig',
  '.contextignore', '.augment-ignore',
];

export const GITIGNORE_FILE_NAME = '.gitignore';
export const CONTEXT_IGNORE_FILE_NAMES: readonly string[] = ['.contextignore', '.augment-ignore'];

export type IgnoreEntryKind = 'file' | 'directory';

export interface CompiledIgnoreRule {
  /** Original pattern line, unmodified (used for diagnostics/fingerprinting only). */
  readonly raw: string;
  readonly negated: boolean;
  readonly rootAnchored: boolean;
  readonly directoryOnly: boolean;
  /** Pattern with leading `!`, leading `/`, and trailing `/` stripped. */
  readonly pattern: string;
  readonly source: string;
}

export interface IgnoreCompilerOptions {
  readonly workspacePath: string;
  /**
   * Extra ignore-file names to read from the workspace root, evaluated
   * after `.gitignore` and the built-in context-ignore file names, in the
   * order given. Enables deterministic "custom ignore" fixtures without
   * relying on the two hard-coded default file names.
   */
  readonly extraIgnoreFileNames?: readonly string[];
  /** Additional literal ignore-pattern lines, applied after every file-based source. */
  readonly additionalPatterns?: readonly string[];
  /** Additional hard-excluded (non-negatable) directory names. */
  readonly additionalExcludedDirectoryNames?: readonly string[];
  /** Additional hidden-entry names to allow despite the default hidden-entry rule. */
  readonly additionalHiddenAllowlist?: readonly string[];
}

export interface CompiledIgnoreRules {
  readonly excludedDirectoryNames: ReadonlySet<string>;
  readonly hiddenAllowlist: ReadonlySet<string>;
  readonly rules: readonly CompiledIgnoreRule[];
  /**
   * Deterministic fingerprint of every rule input (defaults, ignore-file
   * contents, and programmatic overrides). Independent of the filesystem's
   * actual file list -- two workspaces with identical ignore configuration
   * but different files share this fingerprint.
   */
  readonly ruleFingerprint: string;
  /** True when `name` is a hard-excluded directory name (never negatable). */
  isDirectoryNameExcluded(name: string): boolean;
  /** True when `name` is a hidden (dot-prefixed) entry that is not allowlisted. */
  isHiddenEntryExcluded(name: string): boolean;
  /**
   * Evaluate the ordered rule list against one path segment (file or
   * directory), honoring gitignore-style "last match wins" negation.
   * `relativePath` must be POSIX-normalized and relative to the workspace.
   */
  matchesIgnoreRule(relativePath: string, kind: IgnoreEntryKind): boolean;
}

function parseIgnoreFileContent(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function readIgnoreFile(workspacePath: string, fileName: string): string[] {
  const filePath = path.join(workspacePath, fileName);
  try {
    if (!fs.existsSync(filePath)) return [];
    return parseIgnoreFileContent(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function compileRule(raw: string, source: string): CompiledIgnoreRule | null {
  let pattern = raw;
  const negated = pattern.startsWith('!');
  if (negated) {
    pattern = pattern.slice(1);
  }
  if (pattern.length === 0) return null;

  const rootAnchored = pattern.startsWith('/');
  if (rootAnchored) {
    pattern = pattern.slice(1);
  }

  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) return null;

  return { raw, negated, rootAnchored, directoryOnly, pattern, source };
}

function matchesSinglePattern(relativePath: string, rule: CompiledIgnoreRule): boolean {
  const fileName = path.basename(relativePath);
  const { pattern, rootAnchored } = rule;

  if (!pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
    if (rootAnchored) {
      return relativePath === pattern;
    }
    return fileName === pattern || relativePath === pattern;
  }

  try {
    if (rootAnchored) {
      return minimatch(relativePath, pattern, { dot: true });
    }
    if (minimatch(relativePath, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
      return true;
    }
    if (!pattern.startsWith('**') && minimatch(relativePath, `**/${pattern}`, { dot: true })) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Stable JSON-based hash used across discovery modules. Callers must
 * construct payload objects with a fixed key order so the hash is
 * reproducible across runs and platforms.
 */
export function stableHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function normalizeDiscoveryPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim();
}

export function compileIgnoreRules(options: IgnoreCompilerOptions): CompiledIgnoreRules {
  const workspacePath = options.workspacePath;

  const excludedDirectoryNames = new Set<string>([
    ...DEFAULT_EXCLUDED_DIRECTORY_NAMES,
    ...(options.additionalExcludedDirectoryNames ?? []),
  ]);
  const hiddenAllowlist = new Set<string>([
    ...HIDDEN_ENTRY_ALLOWLIST,
    ...(options.additionalHiddenAllowlist ?? []),
  ]);

  const rules: CompiledIgnoreRule[] = [];
  const fileSources: Array<{ name: string; lines: string[] }> = [];

  for (const rawPattern of DEFAULT_EXCLUDED_FILE_PATTERNS) {
    const rule = compileRule(rawPattern, 'default');
    if (rule) rules.push(rule);
  }

  const gitignoreLines = readIgnoreFile(workspacePath, GITIGNORE_FILE_NAME);
  fileSources.push({ name: GITIGNORE_FILE_NAME, lines: gitignoreLines });
  for (const rawPattern of gitignoreLines) {
    const rule = compileRule(rawPattern, GITIGNORE_FILE_NAME);
    if (rule) rules.push(rule);
  }

  const contextIgnoreFileNames = [
    ...CONTEXT_IGNORE_FILE_NAMES,
    ...(options.extraIgnoreFileNames ?? []),
  ];
  for (const ignoreFileName of contextIgnoreFileNames) {
    const lines = readIgnoreFile(workspacePath, ignoreFileName);
    fileSources.push({ name: ignoreFileName, lines });
    for (const rawPattern of lines) {
      const rule = compileRule(rawPattern, ignoreFileName);
      if (rule) rules.push(rule);
    }
  }

  for (const rawPattern of options.additionalPatterns ?? []) {
    const rule = compileRule(rawPattern, 'custom');
    if (rule) rules.push(rule);
  }

  const ruleFingerprint = stableHash({
    ruleEngineVersion: IGNORE_RULE_ENGINE_VERSION,
    excludedDirectoryNames: [...excludedDirectoryNames].sort(),
    hiddenAllowlist: [...hiddenAllowlist].sort(),
    defaultPatterns: [...DEFAULT_EXCLUDED_FILE_PATTERNS],
    fileSources: fileSources.map((source) => ({ name: source.name, lines: source.lines })),
    additionalPatterns: [...(options.additionalPatterns ?? [])],
  });

  return {
    excludedDirectoryNames,
    hiddenAllowlist,
    rules,
    ruleFingerprint,
    isDirectoryNameExcluded(name: string): boolean {
      return excludedDirectoryNames.has(name);
    },
    isHiddenEntryExcluded(name: string): boolean {
      if (!name.startsWith('.')) return false;
      return !hiddenAllowlist.has(name);
    },
    matchesIgnoreRule(relativePath: string, kind: IgnoreEntryKind): boolean {
      const normalized = normalizeDiscoveryPath(relativePath);
      let ignored = false;
      for (const rule of rules) {
        if (rule.directoryOnly && kind !== 'directory') continue;
        if (matchesSinglePattern(normalized, rule)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}
