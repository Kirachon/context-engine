import { SearchResult } from '../../mcp/serviceClient.js';
import type { RetrievalFlowContext } from './flow.js';

export type QuerySource = 'original' | 'expanded';
export type RetrievalProfile = 'fast' | 'balanced' | 'rich';
export type RetrievalRewriteMode = 'v1' | 'v2';
export type RetrievalRankingMode = 'v1' | 'v2' | 'v3';
export type RerankPath = 'heuristic' | 'transformer' | 'provider';
export type RankingFallbackReason =
  | 'none'
  | 'empty_results'
  | 'quality_guard'
  | 'low_confidence'
  | 'rerank_skipped'
  | 'reranker_unavailable'
  | 'rerank_timeout_or_empty'
  | 'rerank_error';

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

export interface RetrievalReranker {
  id: string;
  rerank: (query: string, candidates: InternalSearchResult[], options?: { timeoutMs?: number }) => Promise<InternalSearchResult[]>;
}

export interface RetrievalOptions {
  topK?: number;
  perQueryTopK?: number;
  maxVariants?: number;
  fanoutConcurrency?: number;
  timeoutMs?: number;
  enableExpansion?: boolean;
  enableDedupe?: boolean;
  enableLexical?: boolean;
  enableDense?: boolean;
  enableFusion?: boolean;
  enableRerank?: boolean;
  rerankTopN?: number;
  rerankTimeoutMs?: number;
  /** Optional latency budget for entering/completing rerank before the pipeline fails open to pre-rerank candidates. */
  rerankBudgetMs?: number;
  reranker?: RetrievalReranker;
  semanticWeight?: number;
  lexicalWeight?: number;
  denseWeight?: number;
  profile?: RetrievalProfile;
  rewriteMode?: RetrievalRewriteMode;
  rankingMode?: RetrievalRankingMode;
  denseProvider?: DenseSearchProvider;
  log?: boolean;
  /** When true, bypass all caches (internal + in-process + persistent). */
  bypassCache?: boolean;
  /** Optional override for the SDK search output length. */
  maxOutputLength?: number;
  /** Optional workspace-relative include glob filters. */
  includePaths?: string[];
  /** Optional workspace-relative exclude glob filters. */
  excludePaths?: string[];
  /** Optional abort signal for cancellation-aware retrieval flows. */
  signal?: AbortSignal;
  /** Optional shared flow context for cancellation and stage metadata. */
  flow?: RetrievalFlowContext;
}

export interface RankingGateSignals {
  rankingMode: RetrievalRankingMode;
  profile: RetrievalProfile;
  candidateCount: number;
  topScore: number;
  secondScore: number;
  top1Top2Gap: number;
  topKScore: number;
  topKSpread: number;
  sourceConsensus: number;
  sourceDiversity: number;
}

export interface RankingGateDecision {
  shouldUseTransformerRerank: boolean;
  reasons: string[];
  signals: RankingGateSignals;
}

export interface RankingDiagnostics {
  rankingMode: RetrievalRankingMode;
  profile: RetrievalProfile;
  candidateCount: number;
  topScore: number;
  secondScore: number;
  top1Top2Gap: number;
  topKScore: number;
  topKSpread: number;
  sourceConsensus: number;
  sourceDiversity: number;
  rerankPath: 'heuristic' | 'transformer' | 'provider';
  fallbackReason: RankingFallbackReason;
  gate: RankingGateDecision;
}
