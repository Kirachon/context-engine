/**
 * R5 — path-filter receipts are distinct from retrieval fallback.
 *
 * Ordinary path filters (scope, exclude/deprioritize heuristics) must never be
 * counted as retrieval fallback. These helpers map raw filter labels into
 * stable reason enums for gating and observability.
 */

export type PathFilterReason =
  | 'exclude_artifacts'
  | 'exclude_docs'
  | 'exclude_json'
  | 'deprioritize_docs'
  | 'deprioritize_json'
  | 'scope_include_paths'
  | 'scope_exclude_paths'
  | 'scope_lexical'
  | 'scope_chunk'
  | 'other';

export type RetrievalFallbackReason =
  | 'none'
  | 'quality_guard'
  | 'rerank_timeout'
  | 'rerank_error'
  | 'provider_failure'
  | 'second_pass';

const FILTER_LABEL_TO_REASON: Record<string, PathFilterReason> = {
  'exclude:artifacts': 'exclude_artifacts',
  'exclude:docs': 'exclude_docs',
  'exclude:json': 'exclude_json',
  'deprioritize:docs': 'deprioritize_docs',
  'deprioritize:json': 'deprioritize_json',
  'scope:include_paths': 'scope_include_paths',
  'scope:exclude_paths': 'scope_exclude_paths',
  'scope:lexical': 'scope_lexical',
  'scope:chunk': 'scope_chunk',
};

export interface PathFilterReceipt {
  reason: PathFilterReason;
  label: string;
}

export interface PathFilterDiagnostics {
  filters_applied: string[];
  filter_reasons: PathFilterReason[];
  filter_receipts: PathFilterReceipt[];
  filtered_paths_count: number;
  second_pass_used: boolean;
}

export function mapFilterLabelToReason(label: string): PathFilterReason {
  const normalized = label.trim().toLowerCase();
  return FILTER_LABEL_TO_REASON[normalized] ?? 'other';
}

export function buildPathFilterDiagnostics(input: {
  filtersApplied?: string[] | null;
  filteredPathsCount?: number | null;
  secondPassUsed?: boolean | null;
} | null | undefined): PathFilterDiagnostics | null {
  if (!input) {
    return null;
  }
  const filtersApplied = [...(input.filtersApplied ?? [])].filter(
    (label) => typeof label === 'string' && label.trim().length > 0
  );
  const hasSignal =
    filtersApplied.length > 0 ||
    (typeof input.filteredPathsCount === 'number' && input.filteredPathsCount > 0) ||
    input.secondPassUsed === true;
  if (!hasSignal) {
    return null;
  }

  const filterReceipts = filtersApplied.map((label) => ({
    reason: mapFilterLabelToReason(label),
    label,
  }));
  const filterReasons = [...new Set(filterReceipts.map((receipt) => receipt.reason))];

  return {
    filters_applied: filtersApplied,
    filter_reasons: filterReasons,
    filter_receipts: filterReceipts,
    filtered_paths_count: typeof input.filteredPathsCount === 'number' ? input.filteredPathsCount : 0,
    second_pass_used: input.secondPassUsed === true,
  };
}

/**
 * Derive retrieval fallback solely from retrieval outcome metadata / ranking
 * diagnostics. Path filters and second-pass filter expansion are excluded.
 */
export function deriveRetrievalFallbackState(input: {
  retrievalFallbackState?: 'active' | 'inactive' | null;
  rankingFallbackState?: 'active' | 'inactive' | null;
  rankingFallbackReason?: string | null;
  providerFailed?: boolean;
}): {
  fallback_state: 'active' | 'inactive';
  fallback_reason: RetrievalFallbackReason;
} {
  if (input.providerFailed) {
    return { fallback_state: 'active', fallback_reason: 'provider_failure' };
  }

  const rankingReason = input.rankingFallbackReason;
  if (rankingReason === 'quality_guard' || rankingReason === 'rerank_timeout' || rankingReason === 'rerank_error') {
    return {
      fallback_state: 'active',
      fallback_reason: rankingReason,
    };
  }

  if (input.retrievalFallbackState === 'active' || input.rankingFallbackState === 'active') {
    return {
      fallback_state: 'active',
      fallback_reason:
        rankingReason === 'quality_guard' ||
        rankingReason === 'rerank_timeout' ||
        rankingReason === 'rerank_error'
          ? rankingReason
          : 'quality_guard',
    };
  }

  return { fallback_state: 'inactive', fallback_reason: 'none' };
}
