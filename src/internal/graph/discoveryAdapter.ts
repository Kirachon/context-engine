/**
 * R3b3 -- graph manifest adoption.
 *
 * Binds `persistentGraphStore.ts`'s `refresh()`/`collectSourceFiles` to the
 * canonical R3a discovery manifest (`src/internal/discovery/discoveryManifest.ts`),
 * exactly mirroring the R3b1 (watcher) / R3b2 (chunk/dense/vector/lexical)
 * adoption pattern for the graph store:
 *
 * - The graph's corpus can never exceed the canonical manifest's eligible-path
 *   set. Any caller-supplied `indexedFiles` (from the indexing lifecycle) or
 *   `.context-engine-index-state.json` sidecar entry whose path is not in the
 *   canonical manifest is dropped before it ever reaches the graph builder --
 *   the graph store can therefore never index (or later serve) an excluded
 *   path, regardless of what a stale/independently-computed caller-supplied
 *   set claims.
 * - When neither an explicit `indexedFiles` map nor a populated index-state
 *   sidecar is available, `persistentGraphStore.ts` previously fell back to
 *   its own ad hoc recursive workspace walk (`listWorkspaceFiles`, with a
 *   small hand-maintained `EXCLUDED_DIRECTORIES` set that could silently
 *   drift from the real ignore rules). That fallback is removed: the sole
 *   remaining fallback is this module's canonical manifest file list, so a
 *   from-scratch graph build can never disagree with a full discovery pass
 *   on which paths are eligible.
 * - If the canonical manifest cannot be produced at all (production throws)
 *   or the rollback lever below is set, `resolveGraphCanonicalManifest`
 *   returns `null`. Callers MUST treat a `null` result as an explicit
 *   degraded condition and must never substitute a broad recursive scan in
 *   its place (see `GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR` rollback
 *   semantics below, which differ from R3b1/R3b2's "restore prior exact
 *   behavior" rollback: the graph's safe rollback posture is to stay
 *   degraded, not to resurrect the old ad hoc walk).
 */
import * as path from 'path';
import { envBool } from '../../config/env.js';
import {
  produceDiscoveryManifest,
  type DiscoveryIgnoreOptions,
  type DiscoveryManifest,
} from '../discovery/discoveryManifest.js';

/**
 * R3b3 rollback lever: when set, the graph store never binds to the
 * canonical discovery manifest. Unlike R3b1/R3b2's rollback levers, this
 * does NOT restore the pre-R3b3 recursive-walk fallback -- that fallback no
 * longer exists. Instead, every caller of `resolveGraphCanonicalManifest`
 * receives `null` and must surface an explicit degraded result (graph
 * refresh/hydration stays degraded; it never broad-scans).
 */
export const GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR = 'CE_GRAPH_DISCOVERY_MANIFEST_DISABLED';

export function isGraphDiscoveryManifestDisabled(): boolean {
  return envBool(GRAPH_DISCOVERY_MANIFEST_DISABLED_ENV_VAR, false);
}

export interface GraphCanonicalManifestOptions {
  readonly workspacePath: string;
  readonly indexingRoots?: readonly string[];
  readonly ignore?: DiscoveryIgnoreOptions;
}

/**
 * Produces the canonical discovery manifest for a workspace, or `null` when
 * canonical binding is disabled via the rollback lever, or when a full
 * discovery pass fails outright. Never falls back to any other scan. Always
 * runs a fresh discovery pass (no caching) -- graph refresh is not on a hot
 * path shared by multiple concurrent stores the way R3b2's retrieval stores
 * are, so the extra de-duplication complexity is not needed here.
 */
export async function resolveGraphCanonicalManifest(
  options: GraphCanonicalManifestOptions
): Promise<DiscoveryManifest | null> {
  if (isGraphDiscoveryManifestDisabled()) {
    return null;
  }
  try {
    return await produceDiscoveryManifest({
      workspacePath: path.resolve(options.workspacePath),
      indexingRoots: options.indexingRoots,
      ignore: options.ignore,
    });
  } catch {
    return null;
  }
}

export function buildGraphCanonicalPathSet(manifest: DiscoveryManifest): ReadonlySet<string> {
  return new Set(manifest.files.map((entry) => entry.path));
}

function normalizeCandidatePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim();
}

/**
 * Filters a caller-supplied `{ path -> value }` map down to exactly the
 * entries whose path is present in the canonical manifest's path set.
 * Values (hashes, timestamps, ...) pass through unchanged -- only path
 * membership is gated, so hash domains are never mixed across callers.
 */
export function filterToGraphCanonicalPathSet<T>(
  files: Record<string, T>,
  canonicalPaths: ReadonlySet<string>
): Record<string, T> {
  const filtered: Record<string, T> = {};
  for (const [relativePath, value] of Object.entries(files)) {
    const normalized = normalizeCandidatePath(relativePath);
    if (normalized && canonicalPaths.has(normalized)) {
      filtered[normalized] = value;
    }
  }
  return filtered;
}
