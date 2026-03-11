import { SearchResult } from '../../mcp/serviceClient.js';

export type QuerySource = 'original' | 'expanded';

export interface ExpandedQuery {
  query: string;
  source: QuerySource;
  weight: number;
  index: number;
}

export interface InternalSearchResult extends SearchResult {
  queryVariant: string;
  variantIndex: number;
  variantWeight: number;
  retrievalSource?: 'semantic' | 'lexical' | 'dense' | 'hybrid';
  semanticScore?: number;
  lexicalScore?: number;
  denseScore?: number;
  fusedScore?: number;
  tieBreakPath?: string;
  tieBreakLine?: number;
  combinedScore?: number;
}

export interface DenseSearchProvider {
  id: string;
  search: (query: string, topK: number) => Promise<SearchResult[]>;
}

export interface RetrievalOptions {
  topK?: number;
  perQueryTopK?: number;
  maxVariants?: number;
  timeoutMs?: number;
  enableExpansion?: boolean;
  enableDedupe?: boolean;
  enableLexical?: boolean;
  enableDense?: boolean;
  enableFusion?: boolean;
  enableRerank?: boolean;
  semanticWeight?: number;
  lexicalWeight?: number;
  denseWeight?: number;
  denseProvider?: DenseSearchProvider;
  log?: boolean;
  /** When true, bypass all caches (internal + in-process + persistent). */
  bypassCache?: boolean;
  /** Optional override for the SDK search output length. */
  maxOutputLength?: number;
}
