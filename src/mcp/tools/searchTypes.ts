/**
 * Search tool argument and structured-content types.
 */

import type { RankingDiagnostics } from '../../internal/handlers/types.js';
import type { SymbolNavigationDiagnostics } from '../serviceClient.js';

export type { SymbolNavigationDiagnostics };

export interface SemanticSearchArgs {
  query: string;
  top_k?: number;
  /** fast: default pipeline; deep: more expansion + larger per-variant budget */
  mode?: 'fast' | 'deep';
  /** Explicit retrieval profile override. When provided, takes precedence over mode. */
  profile?: 'fast' | 'balanced' | 'rich';
  /** When true, bypass caches for this request */
  bypass_cache?: boolean;
  /** Max time to spend on retrieval pipeline (ms). 0/undefined means no timeout. */
  timeout_ms?: number;
  include_paths?: string[];
  exclude_paths?: string[];
}

export interface SymbolSearchArgs {
  symbol: string;
  top_k?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
}

export interface SymbolReferencesArgs {
  symbol: string;
  top_k?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
}

export interface SymbolDefinitionArgs {
  symbol: string;
  workspacePath?: string;
  language_hint?: string;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
}

export interface CallRelationshipsArgs {
  symbol: string;
  direction?: 'callers' | 'callees' | 'both';
  workspacePath?: string;
  top_k?: number;
  language_hint?: string;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
}

export type SymbolRankedResultItem = {
  path: string;
  content: string;
  lines?: string;
  relevanceScore?: number;
  matchType?: string;
  retrievedAt?: string;
};

export type SymbolRankedResultsStructuredContent = {
  schema_version: 1;
  symbol: string;
  top_k: number;
  results: SymbolRankedResultItem[];
  freshness_warning: string | null;
  diagnostics: SymbolNavigationDiagnostics | null;
};

export type SymbolDefinitionStructuredContent = {
  schema_version: 1;
  symbol: string;
  found: boolean;
  file?: string;
  line?: number;
  column?: number | null;
  kind?: string;
  score?: number;
  snippet?: string;
  diagnostics: SymbolNavigationDiagnostics | null;
};

export type CallRelationshipsStructuredContent = {
  schema_version: 1;
  symbol: string;
  direction: 'callers' | 'callees' | 'both';
  callers: Array<{
    file: string;
    line: number;
    snippet: string;
    score: number;
    callerSymbol?: string;
    column?: number;
  }>;
  callees: Array<{
    file: string;
    line: number;
    snippet: string;
    score: number;
    calleeSymbol: string;
    column?: number;
  }>;
  metadata: Record<string, unknown>;
};

export type SemanticSearchStructuredContent = {
  schema_version: 1;
  query: string;
  result_count: number;
  empty: boolean;
  signal_summary: {
    query_mode: 'semantic' | 'keyword' | 'hybrid';
    hybrid_components: Array<'semantic' | 'keyword' | 'dense'>;
    quality_guard_state: 'enabled' | 'disabled';
    fallback_state: 'active' | 'inactive';
  };
  freshness_warning: string | null;
  fallback_diagnostics: {
    filters_applied: string[];
    filtered_paths_count: number;
    second_pass_used: boolean;
  } | null;
  ranking_diagnostics: RankingDiagnostics | null;
  file_groups: Array<{
    path: string;
    top_relevance: number;
    relevance_indicator: string;
    snippets: Array<{
      lines?: string;
      relevance_score?: number;
      trace: ResultTraceEnvelope;
      content: string;
      preview: string;
    }>;
  }>;
  audit_rows: Array<{
    file_path: string;
    score?: number;
    match_type: string;
    retrieved_at?: string;
  }>;
};

export type ResultTraceEnvelope = {
  source_stage: 'semantic' | 'keyword' | 'hybrid' | 'lexical' | 'dense';
  match_type: 'semantic' | 'keyword' | 'hybrid' | 'lexical' | 'dense';
  query_variant?: string;
  variant_index?: number;
};