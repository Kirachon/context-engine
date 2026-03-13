import type { SearchResult } from '../../mcp/serviceClient.js';
import type { RetrievalOptions } from '../retrieval/types.js';

export type InternalRetrieveOptions = RetrievalOptions;

export interface InternalRetrieveResult {
  query: string;
  elapsedMs: number;
  results: SearchResult[];
  queryMode?: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents?: Array<'semantic' | 'keyword' | 'dense'>;
  qualityGuardState?: 'enabled' | 'disabled';
  fallbackState?: 'active' | 'inactive';
}
