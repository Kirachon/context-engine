import type { SearchResult } from '../../mcp/serviceClient.js';
import type { RetrievalFlowSummary } from '../retrieval/flow.js';
import type { RetrievalOptions, RetrievalRankingMode } from '../retrieval/types.js';

export type RetrievalRankingFallbackReason =
  | 'none'
  | 'quality_guard'
  | 'rerank_timeout'
  | 'rerank_error';

export type RetrievalRerankGateState =
  | 'disabled'
  | 'skipped'
  | 'invoked'
  | 'fail_open';

export interface RetrievalRankingDiagnostics {
  rankingMode: RetrievalRankingMode;
  scoreSpread: number;
  sourceConsensus: number;
  fallbackState: 'active' | 'inactive';
  fallbackReason: RetrievalRankingFallbackReason;
  rerankGateState: RetrievalRerankGateState;
}

export type RankingDiagnostics = RetrievalRankingDiagnostics;
export type RankingFallbackReason = RetrievalRankingFallbackReason;
export type RankingGateDecision = {
  shouldUseTransformerRerank: boolean;
  reasons: string[];
  signals: {
    rankingMode: RetrievalRankingMode;
    profile: 'fast' | 'balanced' | 'rich';
    candidateCount: number;
    topScore: number;
    secondScore: number;
    top1Top2Gap: number;
    topKScore: number;
    topKSpread: number;
    sourceConsensus: number;
    sourceDiversity: number;
  };
};

export type InternalRetrieveOptions = RetrievalOptions;

export interface InternalRetrieveResult {
  query: string;
  elapsedMs: number;
  results: SearchResult[];
  queryMode?: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents?: Array<'semantic' | 'keyword' | 'dense'>;
  qualityGuardState?: 'enabled' | 'disabled';
  fallbackState?: 'active' | 'inactive';
  rankingDiagnostics?: RetrievalRankingDiagnostics;
  flow?: RetrievalFlowSummary;
}
