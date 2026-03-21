import { createHashEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';

export interface EmbeddingRuntime extends EmbeddingProvider {
  modelId: string;
  vectorDimension: number;
}

function normalizeVectorDimension(dimensions: number): number {
  return Math.max(16, Math.min(1024, Math.floor(dimensions)));
}

/**
 * Lightweight local embedding runtime adapter for the MVP vector path.
 * This keeps the runtime seam explicit while preserving the deterministic
 * hash-based scaffold until a real local model is wired in.
 */
export function createHashEmbeddingRuntime(dimensions: number = 128): EmbeddingRuntime {
  const vectorDimension = normalizeVectorDimension(dimensions);
  const provider = createHashEmbeddingProvider(vectorDimension);
  return {
    ...provider,
    modelId: provider.id,
    vectorDimension,
  };
}
