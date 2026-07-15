import * as fs from 'fs';
import * as path from 'path';
import { formatRequestLogPrefix } from '../telemetry/requestContext.js';
import {
  createWorkspacePersistentGraphStore,
  GRAPH_ARTIFACT_DIRECTORY_NAME,
  GRAPH_METADATA_FILE_NAME,
  GRAPH_PAYLOAD_FILE_NAME,
  type GraphDegradedReason,
  type GraphPayloadFile,
  type GraphStoreSnapshot,
  type WorkspacePersistentGraphStore,
} from '../internal/graph/persistentGraphStore.js';

export interface ServiceClientGraphNavigationSnapshot {
  payload: GraphPayloadFile | null;
  snapshot: GraphStoreSnapshot | null;
  fallbackReason: GraphDegradedReason | 'graph_missing' | null;
}

export interface ServiceClientGraphAccessOptions {
  workspacePath: string;
  debugSearch?: boolean;
  logWarning?: (message: string) => void;
}

function formatScopedLog(message: string): string {
  return `${formatRequestLogPrefix()} ${message}`;
}

type FileSignature = {
  exists: boolean;
  mtimeMs: number;
  size: number;
};

type SharedGraphStoreEntry = {
  store: WorkspacePersistentGraphStore;
  signatures: Record<string, FileSignature>;
  cachedAt: number;
};

const SHARED_GRAPH_STORE_CACHE_TTL_MS = 30_000;
const sharedGraphStoreCache = new Map<string, SharedGraphStoreEntry>();

function readFileSignature(filePath: string): FileSignature {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function getGraphArtifactPaths(workspacePath: string, indexStatePath: string): string[] {
  return [
    path.join(workspacePath, GRAPH_METADATA_FILE_NAME),
    path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME, GRAPH_PAYLOAD_FILE_NAME),
    indexStatePath,
  ];
}

function readGraphArtifactSignatures(paths: string[]): Record<string, FileSignature> {
  return Object.fromEntries(paths.map((filePath) => [filePath, readFileSignature(filePath)]));
}

function signaturesMatch(
  expected: Record<string, FileSignature>,
  actual: Record<string, FileSignature>
): boolean {
  return Object.keys(expected).every((filePath) => {
    const before = expected[filePath];
    const after = actual[filePath];
    return before?.exists === after?.exists
      && before?.mtimeMs === after?.mtimeMs
      && before?.size === after?.size;
  });
}

function clearSharedGraphStoreCache(workspacePath: string): void {
  sharedGraphStoreCache.delete(path.resolve(workspacePath));
}

export class ServiceClientGraphAccess {
  private graphStore: WorkspacePersistentGraphStore | null = null;
  private graphStoreLoadAttempted = false;

  constructor(private readonly options: ServiceClientGraphAccessOptions) {}

  clearCache(): void {
    clearSharedGraphStoreCache(this.options.workspacePath);
    this.graphStore = null;
    this.graphStoreLoadAttempted = false;
  }

  /** R6: sync peek for composite health without forcing hydrate. */
  peekCachedSnapshot(): {
    loadAttempted: boolean;
    snapshot: GraphStoreSnapshot | null;
  } {
    return {
      loadAttempted: this.graphStoreLoadAttempted,
      snapshot: this.graphStore?.getSnapshot() ?? null,
    };
  }

  async getStore(): Promise<WorkspacePersistentGraphStore | null> {
    if (this.graphStore) {
      return this.graphStore;
    }

    if (this.graphStoreLoadAttempted) {
      return null;
    }

    this.graphStoreLoadAttempted = true;
    const workspacePath = path.resolve(this.options.workspacePath);
    const indexStatePath = path.join(workspacePath, '.context-engine-index-state.json');
    const artifactPaths = getGraphArtifactPaths(workspacePath, indexStatePath);
    const currentSignatures = readGraphArtifactSignatures(artifactPaths);
    const shared = sharedGraphStoreCache.get(workspacePath);
    if (
      shared
      && (Date.now() - shared.cachedAt) <= SHARED_GRAPH_STORE_CACHE_TTL_MS
      && signaturesMatch(shared.signatures, currentSignatures)
    ) {
      this.graphStore = shared.store;
      return this.graphStore;
    }
    sharedGraphStoreCache.delete(workspacePath);

    try {
      const store = createWorkspacePersistentGraphStore({
        workspacePath,
        indexStatePath,
      });
      // Cold-start hydration (C2a, canonical-manifest-bound via C2b):
      // validate persisted artifacts against workspace/schema/corpus/
      // artifact fingerprints, including the current canonical discovery
      // manifest generation, before first navigation. Any missing or
      // mismatched canonical state leaves the store explicitly degraded
      // instead of rebuilding opportunistically.
      try {
        await store.hydrate();
      } catch (hydrateError) {
        if (this.options.debugSearch) {
          console.error('[graphStore] Cold-start hydration failed; remaining degraded:', hydrateError);
        }
      }
      this.graphStore = store;
      sharedGraphStoreCache.set(workspacePath, {
        store,
        signatures: readGraphArtifactSignatures(artifactPaths),
        cachedAt: Date.now(),
      });
      return this.graphStore;
    } catch (error) {
      if (this.options.debugSearch) {
        console.error('[graphStore] Graph store unavailable, continuing without graph artifacts:', error);
      }
      return null;
    }
  }

  async refresh(
    options?: { indexedFiles?: Record<string, { hash: string; indexed_at?: string }> }
  ): Promise<void> {
    const graphStore = await this.getStore();
    if (!graphStore) {
      return;
    }

    try {
      await graphStore.refresh({ indexedFiles: options?.indexedFiles });
    } catch (error) {
      this.options.logWarning?.(
        formatScopedLog(
          `[ContextServiceClient] Graph artifact refresh failed; non-graph retrieval will continue. ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
      this.clearCache();
    }
  }

  async getNavigationSnapshot(): Promise<ServiceClientGraphNavigationSnapshot> {
    const graphStore = await this.getStore();
    if (!graphStore) {
      return {
        payload: null,
        snapshot: null,
        fallbackReason: 'graph_unavailable',
      };
    }

    const snapshot = graphStore.getSnapshot();
    const payload = graphStore.getGraph();
    if (!payload) {
      return {
        payload: null,
        snapshot,
        fallbackReason: snapshot.degraded_reason ?? 'graph_missing',
      };
    }

    return {
      payload,
      snapshot,
      fallbackReason: null,
    };
  }

  async clearArtifacts(): Promise<void> {
    const graphStore = await this.getStore();
    await graphStore?.clear();
    this.clearCache();
  }
}
