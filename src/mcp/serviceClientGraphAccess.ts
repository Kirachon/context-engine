import * as path from 'path';
import { formatRequestLogPrefix } from '../telemetry/requestContext.js';
import {
  createWorkspacePersistentGraphStore,
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

export class ServiceClientGraphAccess {
  private graphStore: WorkspacePersistentGraphStore | null = null;
  private graphStoreLoadAttempted = false;

  constructor(private readonly options: ServiceClientGraphAccessOptions) {}

  clearCache(): void {
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
    try {
      const store = createWorkspacePersistentGraphStore({
        workspacePath: this.options.workspacePath,
        indexStatePath: path.join(this.options.workspacePath, '.context-engine-index-state.json'),
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
