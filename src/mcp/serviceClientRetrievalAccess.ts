import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from '../retrieval/providers/types.js';
import type { SearchResult } from './serviceClient.js';
import type {
  IndexResult,
  IndexStatus,
  RetrievalArtifactMetadataOptions,
  RetrievalArtifactObservability,
  RetrievalRuntimeMetadata,
} from './serviceClient.js';
import {
  buildRetrievalArtifactMetadata,
  buildRetrievalProviderCallbacks,
  buildRetrievalRuntimeMetadata,
  runProviderSemanticRuntime,
  type ServiceClientRetrievalSearchOptions,
} from './serviceClientRetrievalRuntime.js';

export interface ServiceClientRetrievalAccessOptions {
  retrievalProviderId: RetrievalProviderId;
  workspacePath: string;
  getIndexFingerprint: () => string;
  searchAndAsk: (
    searchQuery: string,
    prompt?: string,
    options?: { timeoutMs?: number; priority?: 'interactive' | 'background'; signal?: AbortSignal }
  ) => Promise<string>;
  keywordFallbackSearch: (
    query: string,
    topK: number,
    options?: { includePaths?: string[]; excludePaths?: string[] }
  ) => Promise<SearchResult[]>;
  indexWorkspaceLocalNativeFallback: () => Promise<IndexResult>;
  indexFilesLocalNativeFallback: (filePaths: string[]) => Promise<IndexResult>;
  clearIndexWithProviderRuntime: (options?: { localNative?: boolean }) => Promise<void>;
  getIndexStatus: () => Promise<IndexStatus>;
}

export class ServiceClientRetrievalAccess {
  constructor(private readonly options: ServiceClientRetrievalAccessOptions) {}

  getRuntimeMetadata(): RetrievalRuntimeMetadata {
    return buildRetrievalRuntimeMetadata(this.options.retrievalProviderId) as RetrievalRuntimeMetadata;
  }

  getArtifactMetadata(
    options?: RetrievalArtifactMetadataOptions
  ): RetrievalArtifactObservability {
    return buildRetrievalArtifactMetadata({
      retrievalProviderId: this.options.retrievalProviderId,
      workspacePath: this.options.workspacePath,
      indexFingerprint: this.options.getIndexFingerprint(),
      fallbackDomain: options?.fallbackDomain,
      fallbackReason: options?.fallbackReason,
    }) as unknown as RetrievalArtifactObservability;
  }

  createProviderCallbacks(): RetrievalProviderCallbacks {
    return buildRetrievalProviderCallbacks({
      getRetrievalProviderId: () => this.options.retrievalProviderId,
      searchWithProviderRuntime: (query, topK, runtimeOptions) =>
        this.searchWithProviderRuntime(query, topK, runtimeOptions),
      indexWorkspaceLocalNativeFallback: () => this.options.indexWorkspaceLocalNativeFallback(),
      indexFilesLocalNativeFallback: (filePaths) => this.options.indexFilesLocalNativeFallback(filePaths),
      clearIndexWithProviderRuntime: (runtimeOptions) => this.options.clearIndexWithProviderRuntime(runtimeOptions),
      getIndexStatus: async () => this.options.getIndexStatus(),
    });
  }

  async searchWithProviderRuntime(
    query: string,
    topK: number,
    options?: ServiceClientRetrievalSearchOptions
  ): Promise<SearchResult[]> {
    return runProviderSemanticRuntime(query, topK, options, {
      searchAndAsk: (searchQuery, prompt, runtimeOptions) =>
        this.options.searchAndAsk(searchQuery, prompt, {
          timeoutMs: runtimeOptions?.timeoutMs,
          priority: options?.priority === 'background' ? 'background' : 'interactive',
          signal: runtimeOptions?.signal,
        }),
      keywordFallbackSearch: (fallbackQuery, fallbackTopK) =>
        this.options.keywordFallbackSearch(fallbackQuery, fallbackTopK, {
          includePaths: options?.includePaths,
          excludePaths: options?.excludePaths,
        }),
    }) as Promise<SearchResult[]>;
  }
}
