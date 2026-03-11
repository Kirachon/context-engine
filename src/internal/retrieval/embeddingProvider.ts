import type { SearchResult } from '../../mcp/serviceClient.js';

/**
 * Phase 2 scaffold for pluggable embedding providers.
 * Implementations can be local or hosted, but retrieval stays local_native.
 */
export interface EmbeddingProvider {
  id: string;
  embedQuery: (query: string) => Promise<number[]>;
  embedDocuments: (documents: string[]) => Promise<number[][]>;
}

/**
 * Dense retrieval contract that retrieve.ts can consume without coupling to
 * storage/runtime details. Dense index implementations adapt to this shape.
 */
export interface DenseRetriever {
  id: string;
  search: (query: string, topK: number) => Promise<SearchResult[]>;
}

