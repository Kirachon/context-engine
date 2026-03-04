import type { IndexResult, IndexStatus, SearchResult } from '../../mcp/serviceClient.js';

export type RetrievalProviderId = 'augment_legacy' | 'local_native';
export type RetrievalProviderOperation =
  | 'search'
  | 'indexWorkspace'
  | 'indexFiles'
  | 'clearIndex'
  | 'getIndexStatus'
  | 'health';

export interface RetrievalSearchOptions {
  bypassCache?: boolean;
  maxOutputLength?: number;
}

export interface RetrievalProviderCallbackContext {
  providerId: RetrievalProviderId;
  operation: RetrievalProviderOperation;
}

export interface RetrievalProvider {
  readonly id: RetrievalProviderId;
  search(query: string, topK: number, options?: RetrievalSearchOptions): Promise<SearchResult[]>;
  indexWorkspace(): Promise<IndexResult>;
  indexFiles(filePaths: string[]): Promise<IndexResult>;
  clearIndex(): Promise<void>;
  getIndexStatus(): Promise<IndexStatus>;
  health(): Promise<{ ok: boolean; details?: string }>;
}

export interface RetrievalProviderScopedCallbacks {
  search: (
    query: string,
    topK: number,
    options?: RetrievalSearchOptions,
    context?: RetrievalProviderCallbackContext
  ) => Promise<SearchResult[]>;
  indexWorkspace: (context?: RetrievalProviderCallbackContext) => Promise<IndexResult>;
  indexFiles: (filePaths: string[], context?: RetrievalProviderCallbackContext) => Promise<IndexResult>;
  clearIndex: (context?: RetrievalProviderCallbackContext) => Promise<void>;
  getIndexStatus: (context?: RetrievalProviderCallbackContext) => Promise<IndexStatus>;
  health: (context?: RetrievalProviderCallbackContext) => Promise<{ ok: boolean; details?: string }>;
}

export interface RetrievalProviderCallbacks {
  augmentLegacy: RetrievalProviderScopedCallbacks;
  localNative: RetrievalProviderScopedCallbacks;
}
