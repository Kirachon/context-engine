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

  getStore(): WorkspacePersistentGraphStore | null {
    if (this.graphStore) {
      return this.graphStore;
    }

    if (this.graphStoreLoadAttempted) {
      return null;
    }

    this.graphStoreLoadAttempted = true;
    try {
      this.graphStore = createWorkspacePersistentGraphStore({
        workspacePath: this.options.workspacePath,
        indexStatePath: path.join(this.options.workspacePath, '.context-engine-index-state.json'),
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
    const graphStore = this.getStore();
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

  getNavigationSnapshot(): ServiceClientGraphNavigationSnapshot {
    const graphStore = this.getStore();
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
    await this.getStore()?.clear();
    this.clearCache();
  }
}
