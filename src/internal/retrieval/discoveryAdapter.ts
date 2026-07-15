/**
 * R3b2 -- chunk/dense/vector/lexical store manifest adoption.
 *
 * Binds the source-path set used by the retrieval-side stores
 * (`chunkIndex.ts`, `denseIndex.ts`, `lancedbVectorIndex.ts`,
 * `sqliteLexicalIndex.ts`) to the canonical R3a discovery manifest
 * (`src/internal/discovery/discoveryManifest.ts`), so none of them can
 * index a path that a full canonical discovery pass would not have
 * produced -- regardless of what a (possibly stale, or independently
 * computed) `.context-engine-index-state.json` or a store-local ad hoc
 * filesystem walk claims.
 *
 * Design notes:
 * - This module only ever *narrows* a caller-supplied path set: paths
 *   present in an `IndexStateFile`/local scan but absent from the
 *   canonical manifest are dropped; paths are never added beyond what
 *   the caller already had. A store can therefore never end up indexing
 *   outside the canonical source set produced by `runFullDiscovery`.
 * - Content hashes are intentionally left untouched -- callers keep using
 *   their own hash values (from the index-state entry, or their own
 *   `hashContent`/`hashIndexStateContent` call over freshly-read bytes)
 *   for change detection. Only path *membership* is bound to the
 *   canonical manifest; mixing hash domains (this module's canonical
 *   sha256-of-bytes vs. each store's own EOL-normalizable content hash)
 *   would cause spurious "changed" detections on every refresh.
 * - A full discovery pass walks the filesystem. Concurrent callers (e.g.
 *   chunk/dense/vector/lexical all refreshing for the same search) share
 *   one in-flight walk via promise de-duplication, mirroring
 *   `ContextServiceClient`'s `getCachedFallbackFiles`. Unlike that cache,
 *   there is no default post-completion TTL: add/delete correctness
 *   (a file created or removed between two sequential refreshes must be
 *   reflected immediately) takes priority over avoiding a repeat walk on
 *   the next call. Operators who accept a short staleness window in
 *   exchange for fewer walks can opt into one via
 *   `CE_RETRIEVAL_DISCOVERY_MANIFEST_CACHE_TTL_MS`.
 * - Rollback: `CE_RETRIEVAL_DISCOVERY_MANIFEST_DISABLED` restores the
 *   exact pre-R3b2 behavior (no filtering at all) for every consumer in
 *   this module, mirroring R3b1's watcher-level rollback lever.
 */
import * as path from 'path';
import { envBool, envMs } from '../../config/env.js';
import {
  produceDiscoveryManifest,
  type DiscoveryIgnoreOptions,
  type DiscoveryManifest,
} from '../discovery/discoveryManifest.js';

export const RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR = 'CE_RETRIEVAL_DISCOVERY_MANIFEST_DISABLED';
/**
 * No post-completion caching by default -- only concurrent in-flight
 * callers are de-duplicated (see module doc comment above). Add/delete
 * correctness takes priority over avoiding a repeat filesystem walk.
 */
const DEFAULT_MANIFEST_CACHE_TTL_MS = 0;

export function isRetrievalDiscoveryManifestDisabled(): boolean {
  return envBool(RETRIEVAL_DISCOVERY_MANIFEST_DISABLED_ENV_VAR, false);
}

function getManifestCacheTtlMs(): number {
  return envMs('CE_RETRIEVAL_DISCOVERY_MANIFEST_CACHE_TTL_MS', DEFAULT_MANIFEST_CACHE_TTL_MS, {
    min: 0,
    max: 300_000,
  });
}

export interface CanonicalManifestOptions {
  readonly workspacePath: string;
  readonly indexingRoots?: readonly string[];
  readonly ignore?: DiscoveryIgnoreOptions;
  readonly bypassCache?: boolean;
}

interface ManifestCacheEntry {
  readonly cachedAt: number;
  readonly manifest: DiscoveryManifest;
}

const manifestCache = new Map<string, ManifestCacheEntry>();
const manifestInFlight = new Map<string, Promise<DiscoveryManifest>>();

function cacheKeyFor(options: CanonicalManifestOptions): string {
  const workspacePath = path.resolve(options.workspacePath);
  const roots = options.indexingRoots && options.indexingRoots.length > 0
    ? options.indexingRoots.map((root) => path.resolve(root)).sort().join('|')
    : '';
  const extraIgnoreFileNames = [...(options.ignore?.extraIgnoreFileNames ?? [])].sort().join('|');
  const additionalPatterns = [...(options.ignore?.additionalPatterns ?? [])].sort().join('|');
  return `${workspacePath}::${roots}::${extraIgnoreFileNames}::${additionalPatterns}`;
}

/**
 * Produces (or returns a cached copy of) the canonical discovery manifest
 * for a workspace. Concurrent callers within the cache TTL window share
 * the same in-flight promise, so N stores refreshing around the same time
 * only trigger one filesystem walk.
 */
export async function resolveCanonicalWorkspaceManifest(
  options: CanonicalManifestOptions
): Promise<DiscoveryManifest> {
  const cacheKey = cacheKeyFor(options);
  const now = Date.now();
  const ttlMs = getManifestCacheTtlMs();

  if (!options.bypassCache) {
    // ttlMs === 0 means "no post-completion caching" (see module doc
    // comment): a same-millisecond `now - cachedAt === 0` must NOT be
    // treated as "within TTL", or a completed prior call would mask an
    // add/delete that happens to land in the same millisecond.
    const cached = manifestCache.get(cacheKey);
    if (cached && ttlMs > 0 && (now - cached.cachedAt) <= ttlMs) {
      return cached.manifest;
    }
    const inFlight = manifestInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const runProduce = produceDiscoveryManifest(options).then((manifest) => {
    if (!options.bypassCache) {
      manifestCache.set(cacheKey, { cachedAt: Date.now(), manifest });
    }
    return manifest;
  });

  if (!options.bypassCache) {
    manifestInFlight.set(cacheKey, runProduce);
  }

  try {
    return await runProduce;
  } finally {
    if (!options.bypassCache) {
      manifestInFlight.delete(cacheKey);
    }
  }
}

/** Clears the in-memory manifest cache (all workspaces, or a specific one). Test/ops utility. */
export function clearCanonicalWorkspaceManifestCache(workspacePath?: string): void {
  if (!workspacePath) {
    manifestCache.clear();
    manifestInFlight.clear();
    return;
  }
  const prefix = `${path.resolve(workspacePath)}::`;
  for (const key of [...manifestCache.keys()]) {
    if (key.startsWith(prefix)) manifestCache.delete(key);
  }
  for (const key of [...manifestInFlight.keys()]) {
    if (key.startsWith(prefix)) manifestInFlight.delete(key);
  }
}

export function buildCanonicalPathSet(manifest: DiscoveryManifest): ReadonlySet<string> {
  return new Set(manifest.files.map((entry) => entry.path));
}

/**
 * Resolves the canonical eligible-path set for a workspace, or `null`
 * when canonical filtering is disabled via
 * `CE_RETRIEVAL_DISCOVERY_MANIFEST_DISABLED` (R3b2 rollback lever). A
 * `null` result signals callers to fall back to their exact pre-R3b2
 * behavior (no canonical filtering at all) rather than silently treating
 * "disabled" as "empty set".
 */
export async function resolveCanonicalWorkspacePathSet(
  options: CanonicalManifestOptions
): Promise<ReadonlySet<string> | null> {
  if (isRetrievalDiscoveryManifestDisabled()) {
    return null;
  }
  const manifest = await resolveCanonicalWorkspaceManifest(options);
  return buildCanonicalPathSet(manifest);
}

function normalizeCandidatePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim();
}

/**
 * Filters an `IndexStateFile`-shaped `files` record down to exactly the
 * entries whose path is present in the canonical discovery manifest.
 * Values (hashes, timestamps, ...) are passed through unchanged -- only
 * path membership is gated. Returns the input unchanged when canonical
 * filtering is disabled (R3b2 rollback lever), preserving prior behavior.
 */
export async function filterIndexStateFilesToCanonicalManifest<T>(
  workspacePath: string,
  files: Record<string, T>,
  options?: DiscoveryIgnoreOptions
): Promise<Record<string, T>> {
  const canonicalPaths = await resolveCanonicalWorkspacePathSet({ workspacePath, ignore: options });
  if (!canonicalPaths) {
    return files;
  }

  const filtered: Record<string, T> = {};
  for (const [relativePath, value] of Object.entries(files)) {
    const normalized = normalizeCandidatePath(relativePath);
    if (normalized && canonicalPaths.has(normalized)) {
      filtered[normalized] = value;
    }
  }
  return filtered;
}
