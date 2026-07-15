/**
 * R3b1 -- watcher manifest adoption.
 *
 * Adapts the R3a canonical discovery manifest (`src/internal/discovery/**`)
 * for the file watcher, so watcher-driven incremental updates can never
 * disagree with a full discovery pass on which paths are eligible:
 *
 * - `chokidarIgnored` covers only the non-negatable hard directory-exclusion
 *   gate (`CompiledIgnoreRules.excludedDirectoryNames`). This is the *only*
 *   part of the canonical ignore rules that is safe to pre-filter at the
 *   chokidar watch level, because -- by construction in
 *   `ignoreCompiler.ts` -- hard-excluded directory names can never be
 *   re-included via `.gitignore`/`.contextignore` negation. Every other
 *   decision (default file patterns, `.gitignore`, `.contextignore`,
 *   negation, hidden-entry allowlisting, file-type eligibility) is deferred
 *   to `applyBatch`, which re-validates each changed path through the exact
 *   same `checkPathEligibility`/`applyIncrementalDiscovery` predicates used
 *   by full discovery. This avoids the legacy `shouldIgnorePath`/
 *   `normalizeIgnoredPatterns` defect where negation lines were silently
 *   dropped (see the R3a receipt).
 * - `applyBatch` maintains one in-memory `DiscoveryManifest`, seeded by a
 *   full `produceDiscoveryManifest` pass, and advances it via
 *   `applyIncrementalDiscovery` on every flushed batch of watcher changes.
 *   It returns only the subset of changes that the updated manifest agrees
 *   are eligible (adds/changes that end up present in the manifest, and
 *   unlinks for paths that were actually tracked beforehand), so a caller
 *   forwarding `eligibleChanges` downstream can never add an ineligible
 *   path or silently lose an eligible negation result.
 * - If a batch touches one of the ignore files themselves
 *   (`.gitignore`/`.contextignore`/`.augment-ignore`/caller-supplied extra
 *   ignore file names), the rules may have changed shape, so the adapter
 *   runs a full `produceDiscoveryManifest` refresh instead of an
 *   incremental update before computing eligibility for that batch.
 */
import * as path from 'path';
import { envBool } from '../config/env.js';
import {
  CONTEXT_IGNORE_FILE_NAMES,
  GITIGNORE_FILE_NAME,
  compileIgnoreRules,
  normalizeDiscoveryPath,
  type IgnoreCompilerOptions,
} from '../internal/discovery/ignoreCompiler.js';
import {
  applyIncrementalDiscovery,
  produceDiscoveryManifest,
  type DiscoveryChangeSet,
  type DiscoveryManifest,
} from '../internal/discovery/discoveryManifest.js';
import type { FileChange } from './types.js';

/**
 * R3b1 rollback lever: when set, `createWatcherDiscoveryAdapter` is not
 * used by watcher wiring (see `src/mcp/server.ts`), which instead falls
 * back to the legacy `getIgnorePatterns`/`getExcludedDirectories`/
 * `normalizeIgnoredPatterns` path with no post-event eligibility filter.
 */
export const WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR = 'CE_WATCHER_DISCOVERY_MANIFEST_DISABLED';

export function isWatcherDiscoveryManifestDisabled(): boolean {
  return envBool(WATCHER_DISCOVERY_MANIFEST_DISABLED_ENV_VAR, false);
}

export type WatcherDiscoveryIgnoreOptions = Omit<IgnoreCompilerOptions, 'workspacePath'>;

export interface WatcherDiscoveryBatchResult {
  readonly manifest: DiscoveryManifest;
  readonly refreshed: boolean;
  readonly eligibleChanges: readonly FileChange[];
}

export interface WatcherDiscoveryAdapter {
  readonly workspacePath: string;
  /**
   * Chokidar-compatible glob patterns for the non-negatable hard
   * directory-exclusion gate only. Pass as chokidar's `ignored` option.
   */
  readonly chokidarIgnored: string[];
  /** Current manifest snapshot (post-seed or post most recent `applyBatch`). */
  getManifest(): DiscoveryManifest;
  /**
   * Advances the maintained manifest by one flushed batch of watcher
   * changes and returns exactly the subset of `changes` that the canonical
   * predicate agrees are eligible.
   */
  applyBatch(changes: readonly FileChange[]): Promise<WatcherDiscoveryBatchResult>;
}

function buildHardExcludeChokidarPatterns(excludedDirectoryNames: ReadonlySet<string>): string[] {
  return [...excludedDirectoryNames].sort().map((dirName) => `**/${dirName}/**`);
}

function toChangeSet(changes: readonly FileChange[]): {
  changeSet: DiscoveryChangeSet;
  latestTypeByPath: Map<string, FileChange['type']>;
} {
  const latestTypeByPath = new Map<string, FileChange['type']>();
  for (const change of changes) {
    latestTypeByPath.set(normalizeDiscoveryPath(change.path), change.type);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const mutated: string[] = [];
  for (const [normalizedPath, type] of latestTypeByPath.entries()) {
    if (type === 'add') added.push(normalizedPath);
    else if (type === 'change') mutated.push(normalizedPath);
    else removed.push(normalizedPath);
  }

  return { changeSet: { added, removed, mutated }, latestTypeByPath };
}

/**
 * True when `changes` includes one of the files that shape the canonical
 * ignore rules themselves, meaning an incremental update against the prior
 * manifest could be evaluated with stale rules.
 */
function touchesIgnoreRuleFiles(
  changes: readonly FileChange[],
  extraIgnoreFileNames: readonly string[]
): boolean {
  const ignoreFileNames = new Set<string>([GITIGNORE_FILE_NAME, ...CONTEXT_IGNORE_FILE_NAMES, ...extraIgnoreFileNames]);
  return changes.some((change) => {
    const normalized = normalizeDiscoveryPath(change.path);
    return !normalized.includes('/') && ignoreFileNames.has(normalized);
  });
}

export async function createWatcherDiscoveryAdapter(
  workspacePath: string,
  options?: WatcherDiscoveryIgnoreOptions
): Promise<WatcherDiscoveryAdapter> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const extraIgnoreFileNames = options?.extraIgnoreFileNames ?? [];

  let manifest = await produceDiscoveryManifest({ workspacePath: resolvedWorkspacePath, ignore: options });
  let chokidarIgnored = buildHardExcludeChokidarPatterns(
    compileIgnoreRules({ workspacePath: resolvedWorkspacePath, ...options }).excludedDirectoryNames
  );
  let knownPaths = new Set(manifest.files.map((entry) => entry.path));

  return {
    workspacePath: resolvedWorkspacePath,
    get chokidarIgnored(): string[] {
      return chokidarIgnored;
    },
    getManifest(): DiscoveryManifest {
      return manifest;
    },
    async applyBatch(changes: readonly FileChange[]): Promise<WatcherDiscoveryBatchResult> {
      if (changes.length === 0) {
        return { manifest, refreshed: false, eligibleChanges: [] };
      }

      let refreshed = false;
      if (touchesIgnoreRuleFiles(changes, extraIgnoreFileNames)) {
        manifest = await produceDiscoveryManifest({ workspacePath: resolvedWorkspacePath, ignore: options });
        chokidarIgnored = buildHardExcludeChokidarPatterns(
          compileIgnoreRules({ workspacePath: resolvedWorkspacePath, ...options }).excludedDirectoryNames
        );
        knownPaths = new Set(manifest.files.map((entry) => entry.path));
        refreshed = true;
      }

      const { changeSet, latestTypeByPath } = toChangeSet(changes);
      const previouslyKnownPaths = knownPaths;
      manifest = await applyIncrementalDiscovery(manifest, resolvedWorkspacePath, changeSet, options);
      knownPaths = new Set(manifest.files.map((entry) => entry.path));

      const eligibleChanges: FileChange[] = [];
      for (const change of changes) {
        const normalizedPath = normalizeDiscoveryPath(change.path);
        // Only the latest event per path survives de-duplication upstream
        // (FileWatcher.pendingChanges keys by relative path), so this
        // lookup always reflects the change actually being flushed.
        if (latestTypeByPath.get(normalizedPath) !== change.type) {
          continue;
        }
        if (change.type === 'unlink') {
          if (previouslyKnownPaths.has(normalizedPath)) {
            eligibleChanges.push(change);
          }
          continue;
        }
        if (knownPaths.has(normalizedPath)) {
          eligibleChanges.push(change);
        }
      }

      return { manifest, refreshed, eligibleChanges };
    },
  };
}
