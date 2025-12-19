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
  combinedScore?: number;
}

export interface RetrievalOptions {
  topK?: number;
  perQueryTopK?: number;
  maxVariants?: number;
  timeoutMs?: number;
  enableExpansion?: boolean;
  enableDedupe?: boolean;
  enableRerank?: boolean;
  log?: boolean;
}
