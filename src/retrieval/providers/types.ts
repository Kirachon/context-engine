import type { IndexResult, IndexStatus, SearchResult } from '../../mcp/serviceClient.js';

export type RetrievalProviderId = 'augment_legacy' | 'local_native';

export interface RetrievalSearchOptions {
  bypassCache?: boolean;
  maxOutputLength?: number;
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

export interface RetrievalProviderCallbacks {
  search: (query: string, topK: number, options?: RetrievalSearchOptions) => Promise<SearchResult[]>;
  indexWorkspace: () => Promise<IndexResult>;
  indexFiles: (filePaths: string[]) => Promise<IndexResult>;
  clearIndex: () => Promise<void>;
  getIndexStatus: () => Promise<IndexStatus>;
  health: () => Promise<{ ok: boolean; details?: string }>;
}
