/**
 * R3a — canonical discovery manifest persistence.
 *
 * Mirrors the atomic-write/versioned-load pattern used by
 * `src/mcp/indexStateStore.ts` and `src/internal/graph/persistentGraphStore.ts`,
 * but stores the standalone discovery manifest produced by
 * `discoveryManifest.ts`. No existing consumer reads this artifact yet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { envBool } from '../../config/env.js';
import {
  DISCOVERY_MANIFEST_SCHEMA_VERSION,
  produceDiscoveryManifest,
  type DiscoveryManifest,
  type DiscoveryManifestFileEntry,
  type RunDiscoveryOptions,
} from './discoveryManifest.js';

export const DISCOVERY_MANIFEST_FILE_NAME = '.context-engine-discovery-manifest.json';

/**
 * R3a rollback lever: when set, `produceAndPersistDiscoveryManifest` skips
 * production entirely and reports `disabled: true` without touching the
 * on-disk artifact (any previously persisted manifest is preserved as-is).
 */
export const DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR = 'CE_DISCOVERY_MANIFEST_DISABLED';

export function isDiscoveryManifestProductionDisabled(): boolean {
  return envBool(DISCOVERY_MANIFEST_PRODUCTION_DISABLED_ENV_VAR, false);
}

function isFileEntryArray(value: unknown): value is DiscoveryManifestFileEntry[] {
  return Array.isArray(value) && value.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { path?: unknown }).path === 'string' &&
      typeof (entry as { hash?: unknown }).hash === 'string'
  );
}

/** Structural validation only; fingerprint/workspace agreement is the caller's responsibility. */
function isWellFormedManifest(value: unknown): value is DiscoveryManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DiscoveryManifest>;
  return (
    typeof candidate.manifest_version === 'number' &&
    typeof candidate.generated_at === 'string' &&
    typeof candidate.workspace_fingerprint === 'string' &&
    typeof candidate.schema_fingerprint === 'string' &&
    typeof candidate.source_fingerprint === 'string' &&
    typeof candidate.generation_fingerprint === 'string' &&
    Array.isArray(candidate.roots) &&
    typeof candidate.file_count === 'number' &&
    isFileEntryArray(candidate.files)
  );
}

export interface DiscoveryManifestStore {
  /** Returns the persisted manifest, or `null` when absent/corrupt/schema-unsupported. */
  load(): DiscoveryManifest | null;
  /** Atomically persists the manifest (tmp file + rename). */
  save(manifest: DiscoveryManifest): void;
  getPath(): string;
}

export function createDiscoveryManifestStore(
  workspacePath: string,
  fileName: string = DISCOVERY_MANIFEST_FILE_NAME
): DiscoveryManifestStore {
  const manifestPath = path.join(path.resolve(workspacePath), fileName);

  return {
    getPath(): string {
      return manifestPath;
    },
    load(): DiscoveryManifest | null {
      try {
        if (!fs.existsSync(manifestPath)) {
          return null;
        }
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (!isWellFormedManifest(parsed)) {
          return null;
        }
        if (parsed.manifest_version > DISCOVERY_MANIFEST_SCHEMA_VERSION) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    save(manifest: DiscoveryManifest): void {
      const tmpPath = `${manifestPath}.tmp`;
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(manifest), 'utf-8');
      fs.renameSync(tmpPath, manifestPath);
    },
  };
}

export interface ProduceAndPersistResult {
  readonly disabled: boolean;
  readonly manifest: DiscoveryManifest | null;
  readonly path: string;
}

/**
 * Produces a fresh manifest via a full discovery pass and persists it,
 * unless production is disabled via `CE_DISCOVERY_MANIFEST_DISABLED`
 * (R3a rollback lever). When disabled, no read/write of the artifact
 * happens at all, so any previously persisted receipt is left intact.
 */
export async function produceAndPersistDiscoveryManifest(
  options: RunDiscoveryOptions,
  store?: DiscoveryManifestStore
): Promise<ProduceAndPersistResult> {
  const resolvedStore = store ?? createDiscoveryManifestStore(options.workspacePath);
  if (isDiscoveryManifestProductionDisabled()) {
    return { disabled: true, manifest: null, path: resolvedStore.getPath() };
  }

  const manifest = await produceDiscoveryManifest(options);
  resolvedStore.save(manifest);
  return { disabled: false, manifest, path: resolvedStore.getPath() };
}
