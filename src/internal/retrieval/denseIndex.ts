import type { SearchResult } from '../../mcp/serviceClient.js';
import type { DenseRetriever, EmbeddingProvider } from './embeddingProvider.js';

export interface DenseIndexDocument {
  id: string;
  path: string;
  content: string;
  lines?: string;
  embedding: number[];
}

export interface DenseIndex {
  version: string;
  updatedAt: string;
  upsert: (documents: DenseIndexDocument[]) => Promise<void>;
  search: (queryEmbedding: number[], topK: number) => Promise<SearchResult[]>;
}

export interface DenseIndexFactoryOptions {
  embeddingProvider: EmbeddingProvider;
  index: DenseIndex;
}

/**
 * Adapter that turns index + embedding primitives into a retriever contract.
 * This is intentionally lightweight scaffolding for Phase 2.
 */
export function createDenseRetriever(options: DenseIndexFactoryOptions): DenseRetriever {
  return {
    id: `dense:${options.embeddingProvider.id}`,
    async search(query: string, topK: number): Promise<SearchResult[]> {
      const embedding = await options.embeddingProvider.embedQuery(query);
      return options.index.search(embedding, topK);
    },
  };
}

