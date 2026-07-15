/**
 * R3a — canonical discovery manifest production.
 *
 * Produces one versioned, deterministic eligible-file manifest (workspace,
 * schema, source, and generation fingerprints) for a workspace, using the
 * standalone ignore compiler and eligibility allowlist in this directory.
 *
 * Scope note: this module only *produces* manifests. No existing consumer
 * (file watcher, chunk/vector store, or graph store) is wired to read from
 * it in this task -- that migration is tracked separately as R3b1-3.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildIndexStateWorkspaceFingerprint } from '../../mcp/indexStateStore.js';
import { ELIGIBLE_FILE_TYPES_ENGINE_VERSION, isEligibleFileName } from './eligibleFileTypes.js';
import {
  compileIgnoreRules,
  IGNORE_RULE_ENGINE_VERSION,
  normalizeDiscoveryPath,
  stableHash,
  type CompiledIgnoreRules,
  type IgnoreCompilerOptions,
} from './ignoreCompiler.js';

export const DISCOVERY_MANIFEST_SCHEMA_VERSION = 1;

export interface DiscoveryManifestFileEntry {
  readonly path: string;
  readonly hash: string;
}

export interface DiscoveryManifest {
  readonly manifest_version: number;
  readonly generated_at: string;
  readonly workspace_fingerprint: string;
  readonly schema_fingerprint: string;
  readonly source_fingerprint: string;
  readonly generation_fingerprint: string;
  readonly roots: readonly string[];
  readonly file_count: number;
  readonly files: readonly DiscoveryManifestFileEntry[];
}

export type DiscoveryIgnoreOptions = Omit<IgnoreCompilerOptions, 'workspacePath'>;

export interface RunDiscoveryOptions {
  readonly workspacePath: string;
  /** Absolute directories to walk. Defaults to `[workspacePath]` when omitted/empty. */
  readonly indexingRoots?: readonly string[];
  readonly ignore?: DiscoveryIgnoreOptions;
}

export interface DiscoveryRunResult {
  readonly ignoreRules: CompiledIgnoreRules;
  readonly roots: readonly string[];
  readonly files: readonly DiscoveryManifestFileEntry[];
}

export interface DiscoveryChangeSet {
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly mutated?: readonly string[];
}

export type PathEligibilityReason =
  | 'invalid_path'
  | 'excluded_ancestor'
  | 'ignored'
  | 'not_eligible_type'
  | 'missing'
  | 'symlink'
  | 'not_a_file';

export interface PathEligibilityResult {
  readonly eligible: boolean;
  readonly reason?: PathEligibilityReason;
}

function isDirectorySegmentExcluded(
  ignoreRules: CompiledIgnoreRules,
  relativeDirPath: string,
  dirName: string
): boolean {
  if (ignoreRules.isDirectoryNameExcluded(dirName)) return true;
  if (ignoreRules.isHiddenEntryExcluded(dirName)) return true;
  return ignoreRules.matchesIgnoreRule(relativeDirPath, 'directory');
}

function isFileSegmentExcluded(
  ignoreRules: CompiledIgnoreRules,
  relativeFilePath: string,
  fileName: string
): boolean {
  if (ignoreRules.isHiddenEntryExcluded(fileName)) return true;
  return ignoreRules.matchesIgnoreRule(relativeFilePath, 'file');
}

async function hashFileContent(absolutePath: string): Promise<string | null> {
  try {
    const contents = await fs.promises.readFile(absolutePath);
    return crypto.createHash('sha256').update(contents).digest('hex');
  } catch {
    return null;
  }
}

async function walkDirectory(
  absoluteDirPath: string,
  relativeDirPath: string,
  ignoreRules: CompiledIgnoreRules,
  results: Map<string, string>
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absoluteDirPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absoluteEntryPath = path.join(absoluteDirPath, entry.name);
    const relativeEntryPath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;

    let isSymlink = entry.isSymbolicLink();
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (!isSymlink && !isDirectory && !isFile) {
      // Dirent type is UNKNOWN on some filesystems. Resolve via lstat (never
      // stat) so a symlink is never mistaken for its followed target type.
      try {
        const lstat = await fs.promises.lstat(absoluteEntryPath);
        isSymlink = lstat.isSymbolicLink();
        isDirectory = lstat.isDirectory();
        isFile = lstat.isFile();
      } catch {
        continue;
      }
    }

    if (isSymlink) {
      // Never follow or index symlinks: avoids workspace escape and cycles.
      continue;
    }

    if (isDirectory) {
      if (isDirectorySegmentExcluded(ignoreRules, relativeEntryPath, entry.name)) {
        continue;
      }
      await walkDirectory(absoluteEntryPath, relativeEntryPath, ignoreRules, results);
      continue;
    }

    if (isFile) {
      if (isFileSegmentExcluded(ignoreRules, relativeEntryPath, entry.name)) {
        continue;
      }
      if (!isEligibleFileName(entry.name)) {
        continue;
      }
      const hash = await hashFileContent(absoluteEntryPath);
      if (hash === null) {
        continue;
      }
      results.set(relativeEntryPath, hash);
    }
  }
}

function normalizeRootLabel(workspacePath: string, absoluteRoot: string): string {
  const relative = normalizeDiscoveryPath(path.relative(workspacePath, absoluteRoot));
  return relative === '' ? '.' : relative;
}

function resolveIndexingRoots(workspacePath: string, indexingRoots?: readonly string[]): string[] {
  if (!indexingRoots || indexingRoots.length === 0) {
    return [workspacePath];
  }
  return indexingRoots.map((root) => path.resolve(root));
}

/**
 * Walks the workspace (or the given subroots) from scratch and returns the
 * deterministic set of eligible files plus the compiled ignore rules used
 * to produce it. Roots are always relativized to `workspacePath`, so
 * scanning a subroot never changes the shape of the resulting paths.
 */
export async function runFullDiscovery(options: RunDiscoveryOptions): Promise<DiscoveryRunResult> {
  const workspacePath = path.resolve(options.workspacePath);
  const ignoreRules = compileIgnoreRules({ workspacePath, ...options.ignore });
  const absoluteRoots = resolveIndexingRoots(workspacePath, options.indexingRoots);

  const results = new Map<string, string>();
  for (const absoluteRoot of absoluteRoots) {
    const relativeRootPath = normalizeRootLabel(workspacePath, absoluteRoot);
    await walkDirectory(absoluteRoot, relativeRootPath === '.' ? '' : relativeRootPath, ignoreRules, results);
  }

  const files = [...results.entries()]
    .map(([filePath, hash]) => ({ path: filePath, hash }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const roots = [...new Set(absoluteRoots.map((root) => normalizeRootLabel(workspacePath, root)))].sort();

  return { ignoreRules, roots, files };
}

export function buildSchemaFingerprint(): string {
  return stableHash({
    manifestVersion: DISCOVERY_MANIFEST_SCHEMA_VERSION,
    ignoreRuleEngineVersion: IGNORE_RULE_ENGINE_VERSION,
    eligibleFileTypesEngineVersion: ELIGIBLE_FILE_TYPES_ENGINE_VERSION,
  });
}

export function buildSourceFingerprint(ignoreRules: CompiledIgnoreRules, roots: readonly string[]): string {
  return stableHash({
    ruleFingerprint: ignoreRules.ruleFingerprint,
    roots: [...roots].sort(),
  });
}

export function buildGenerationFingerprint(files: readonly DiscoveryManifestFileEntry[]): string {
  return stableHash({
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function assembleManifest(
  workspacePath: string,
  ignoreRules: CompiledIgnoreRules,
  roots: readonly string[],
  files: readonly DiscoveryManifestFileEntry[]
): DiscoveryManifest {
  return {
    manifest_version: DISCOVERY_MANIFEST_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    workspace_fingerprint: buildIndexStateWorkspaceFingerprint(workspacePath),
    schema_fingerprint: buildSchemaFingerprint(),
    source_fingerprint: buildSourceFingerprint(ignoreRules, roots),
    generation_fingerprint: buildGenerationFingerprint(files),
    roots,
    file_count: files.length,
    files,
  };
}

/** Runs a full discovery pass and assembles the versioned manifest artifact (in-memory only). */
export async function produceDiscoveryManifest(options: RunDiscoveryOptions): Promise<DiscoveryManifest> {
  const workspacePath = path.resolve(options.workspacePath);
  const { ignoreRules, roots, files } = await runFullDiscovery(options);
  return assembleManifest(workspacePath, ignoreRules, roots, files);
}

/**
 * Evaluates whether one relative path would be included by a full
 * discovery pass, without walking the rest of the tree. Shares the exact
 * ancestor/file exclusion predicates used by `runFullDiscovery`, so
 * incremental application and full discovery can never disagree on a
 * given path's eligibility.
 */
export async function checkPathEligibility(
  workspacePath: string,
  relativePath: string,
  ignoreRules: CompiledIgnoreRules
): Promise<PathEligibilityResult> {
  const normalized = normalizeDiscoveryPath(relativePath);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return { eligible: false, reason: 'invalid_path' };
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { eligible: false, reason: 'invalid_path' };
  }

  let builtPath = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    builtPath = builtPath ? `${builtPath}/${segment}` : segment;
    if (isDirectorySegmentExcluded(ignoreRules, builtPath, segment)) {
      return { eligible: false, reason: 'excluded_ancestor' };
    }
  }

  const fileName = segments[segments.length - 1];
  if (isFileSegmentExcluded(ignoreRules, normalized, fileName)) {
    return { eligible: false, reason: 'ignored' };
  }
  if (!isEligibleFileName(fileName)) {
    return { eligible: false, reason: 'not_eligible_type' };
  }

  const absolutePath = path.join(workspacePath, normalized);
  let lstat: fs.Stats;
  try {
    lstat = await fs.promises.lstat(absolutePath);
  } catch {
    return { eligible: false, reason: 'missing' };
  }
  if (lstat.isSymbolicLink()) {
    return { eligible: false, reason: 'symlink' };
  }
  if (!lstat.isFile()) {
    return { eligible: false, reason: 'not_a_file' };
  }

  return { eligible: true };
}

/**
 * Applies an add/remove/mutate change set to a previously produced
 * manifest without re-walking the whole tree. `roots` are carried over
 * unchanged (incremental updates never change the configured scan scope).
 */
export async function applyIncrementalDiscovery(
  previousManifest: DiscoveryManifest,
  workspacePath: string,
  changes: DiscoveryChangeSet,
  ignoreOptions?: DiscoveryIgnoreOptions
): Promise<DiscoveryManifest> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const ignoreRules = compileIgnoreRules({ workspacePath: resolvedWorkspacePath, ...ignoreOptions });

  const fileMap = new Map<string, string>(previousManifest.files.map((entry) => [entry.path, entry.hash]));

  for (const removedPath of changes.removed ?? []) {
    fileMap.delete(normalizeDiscoveryPath(removedPath));
  }

  const candidatePaths = [...(changes.added ?? []), ...(changes.mutated ?? [])];
  for (const candidatePath of candidatePaths) {
    const normalized = normalizeDiscoveryPath(candidatePath);
    const eligibility = await checkPathEligibility(resolvedWorkspacePath, normalized, ignoreRules);
    if (!eligibility.eligible) {
      fileMap.delete(normalized);
      continue;
    }
    const hash = await hashFileContent(path.join(resolvedWorkspacePath, normalized));
    if (hash === null) {
      fileMap.delete(normalized);
      continue;
    }
    fileMap.set(normalized, hash);
  }

  const files = [...fileMap.entries()]
    .map(([filePath, hash]) => ({ path: filePath, hash }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return assembleManifest(resolvedWorkspacePath, ignoreRules, previousManifest.roots, files);
}
