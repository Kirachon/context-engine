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

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function tokenize(input: string): string[] {
  return input
    .split(/[^a-z0-9_./-]+/i)
    .map(normalizeToken)
    .filter(Boolean);
}

function hashToken(token: string): number {
  // Deterministic non-crypto hash for local embedding scaffolding.
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function toUnitVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (norm <= 0) return vector;
  return vector.map((value) => value / norm);
}

function embedText(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const bucket = hashToken(token) % dimensions;
    vector[bucket] += 1;
  }
  return toUnitVector(vector);
}

/**
 * Local deterministic embedding provider for dense-index scaffolding.
 * This keeps Phase 2 local-native and testable without external services.
 */
export function createHashEmbeddingProvider(dimensions: number = 128): EmbeddingProvider {
  const safeDimensions = Math.max(16, Math.min(1024, Math.floor(dimensions)));
  return {
    id: `hash-${safeDimensions}`,
    async embedQuery(query: string): Promise<number[]> {
      return embedText(query, safeDimensions);
    },
    async embedDocuments(documents: string[]): Promise<number[][]> {
      return documents.map((doc) => embedText(doc, safeDimensions));
    },
  };
}
