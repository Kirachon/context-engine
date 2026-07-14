import { describe, expect, it } from '@jest/globals';
import {
  buildPathFilterDiagnostics,
  deriveRetrievalFallbackState,
  mapFilterLabelToReason,
} from '../../src/mcp/tooling/pathFilterReceipts.js';

describe('pathFilterReceipts (R5)', () => {
  it('maps known filter labels to reason enums', () => {
    expect(mapFilterLabelToReason('exclude:artifacts')).toBe('exclude_artifacts');
    expect(mapFilterLabelToReason('scope:include_paths')).toBe('scope_include_paths');
    expect(mapFilterLabelToReason('deprioritize:json')).toBe('deprioritize_json');
    expect(mapFilterLabelToReason('mystery:filter')).toBe('other');
  });

  it('builds path filter diagnostics without implying retrieval fallback', () => {
    const diagnostics = buildPathFilterDiagnostics({
      filtersApplied: ['exclude:artifacts', 'scope:lexical'],
      filteredPathsCount: 4,
      secondPassUsed: true,
    });

    expect(diagnostics).toEqual({
      filters_applied: ['exclude:artifacts', 'scope:lexical'],
      filter_reasons: ['exclude_artifacts', 'scope_lexical'],
      filter_receipts: [
        { reason: 'exclude_artifacts', label: 'exclude:artifacts' },
        { reason: 'scope_lexical', label: 'scope:lexical' },
      ],
      filtered_paths_count: 4,
      second_pass_used: true,
    });
  });

  it('derives fallback only from retrieval outcome signals', () => {
    expect(
      deriveRetrievalFallbackState({
        retrievalFallbackState: 'inactive',
        rankingFallbackState: 'inactive',
      })
    ).toEqual({ fallback_state: 'inactive', fallback_reason: 'none' });

    expect(
      deriveRetrievalFallbackState({
        retrievalFallbackState: 'active',
        rankingFallbackReason: 'quality_guard',
      })
    ).toEqual({ fallback_state: 'active', fallback_reason: 'quality_guard' });

    expect(
      deriveRetrievalFallbackState({
        rankingFallbackState: 'active',
        rankingFallbackReason: 'rerank_timeout',
      })
    ).toEqual({ fallback_state: 'active', fallback_reason: 'rerank_timeout' });

    expect(
      deriveRetrievalFallbackState({
        providerFailed: true,
      })
    ).toEqual({ fallback_state: 'active', fallback_reason: 'provider_failure' });
  });
});
