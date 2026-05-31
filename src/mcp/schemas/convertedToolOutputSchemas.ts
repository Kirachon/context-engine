import type { JsonSchema } from '../types/outputSchema.js';

const embeddingRuntimeModelSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'modelId', 'vectorDimension'],
  properties: {
    id: { type: 'string' },
    modelId: { type: 'string' },
    vectorDimension: { type: 'number' },
  },
};

const nullableEmbeddingRuntimeModelSchema: JsonSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['id', 'modelId', 'vectorDimension'],
  properties: embeddingRuntimeModelSchema.properties,
};

export const indexStatusOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'freshness', 'guidance', 'embeddingRuntime'],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    status: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'state', 'lastIndexed', 'fileCount', 'isStale', 'lastError'],
      properties: {
        workspace: { type: 'string' },
        state: { type: 'string', enum: ['idle', 'indexing', 'error'] },
        lastIndexed: { type: ['string', 'null'] },
        fileCount: { type: 'integer' },
        isStale: { type: 'boolean' },
        lastError: { type: ['string', 'null'] },
      },
    },
    freshness: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'severity', 'summary'],
      properties: {
        code: { type: 'string' },
        severity: { type: 'string' },
        summary: { type: 'string' },
      },
    },
    guidance: {
      type: 'array',
      items: { type: 'string' },
    },
    embeddingRuntime: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: [
        'state',
        'configured',
        'active',
        'fallback',
        'lastFailure',
        'nextRetryAt',
        'loadFailures',
        'hashFallbackActive',
      ],
      properties: {
        state: { type: 'string' },
        configured: nullableEmbeddingRuntimeModelSchema,
        active: nullableEmbeddingRuntimeModelSchema,
        fallback: nullableEmbeddingRuntimeModelSchema,
        lastFailure: { type: ['string', 'null'] },
        nextRetryAt: { type: ['string', 'null'] },
        loadFailures: { type: ['number', 'null'] },
        hashFallbackActive: { type: ['boolean', 'null'] },
      },
    },
  },
};

const whyThisContextScoreBreakdownSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['base_score', 'graph_score', 'combined_score'],
  properties: {
    base_score: { type: 'number' },
    graph_score: { type: 'number' },
    combined_score: { type: 'number' },
    semantic_score: { type: 'number' },
    lexical_score: { type: 'number' },
    dense_score: { type: 'number' },
    fused_score: { type: 'number' },
  },
};

const whyThisContextGraphSignalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'value', 'weight'],
  properties: {
    kind: { type: 'string' },
    value: { type: 'string' },
    weight: { type: 'number' },
  },
};

const whyThisContextExplainabilitySchema: JsonSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['selected_because', 'score_breakdown'],
  properties: {
    selected_because: {
      type: 'array',
      items: { type: 'string' },
    },
    score_breakdown: whyThisContextScoreBreakdownSchema,
    graph_signals: {
      type: 'array',
      items: whyThisContextGraphSignalSchema,
    },
  },
};

const whyThisContextProvenanceSchema: JsonSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'graph_status',
    'graph_degraded_reason',
    'seed_symbols',
    'neighbor_paths',
    'selection_basis',
  ],
  properties: {
    graph_status: { type: 'string' },
    graph_degraded_reason: { type: ['string', 'null'] },
    seed_symbols: {
      type: 'array',
      items: { type: 'string' },
    },
    neighbor_paths: {
      type: 'array',
      items: { type: 'string' },
    },
    selection_basis: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

const whyThisContextFileSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'path',
    'summary',
    'relevance',
    'snippet_count',
    'explainability',
    'provenance',
    'degraded',
    'degraded_reasons',
  ],
  properties: {
    path: { type: 'string' },
    summary: { type: 'string' },
    relevance: { type: 'number' },
    snippet_count: { type: 'integer' },
    related_files: {
      type: 'array',
      items: { type: 'string' },
    },
    explainability: whyThisContextExplainabilitySchema,
    provenance: whyThisContextProvenanceSchema,
    degraded: { type: 'boolean' },
    degraded_reasons: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

export const whyThisContextOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'files', 'metadata'],
  properties: {
    query: { type: 'string' },
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: whyThisContextFileSchema,
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: [
        'total_files',
        'explainable_file_count',
        'graph_statuses',
        'degraded',
        'degraded_reasons',
        'analysis_scope',
        'deterministic',
      ],
      properties: {
        total_files: { type: 'integer' },
        explainable_file_count: { type: 'integer' },
        graph_statuses: {
          type: 'array',
          items: { type: 'string' },
        },
        degraded: { type: 'boolean' },
        degraded_reasons: {
          type: 'array',
          items: { type: 'string' },
        },
        analysis_scope: { type: 'string' },
        deterministic: { type: 'boolean' },
        query_time_ms: { type: 'number' },
        token_budget: { type: 'number' },
        include_related: { type: 'boolean' },
      },
    },
  },
};

export const toolManifestOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'capabilities', 'tools', 'discoverability', 'features'],
  properties: {
    version: { type: 'string' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
    },
    discoverability: {
      type: 'object',
      additionalProperties: true,
    },
    features: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

const symbolNavigationDiagnosticsSchema: JsonSchema = {
  type: ['object', 'null'],
  additionalProperties: true,
  required: ['backend', 'graph_status', 'graph_degraded_reason', 'fallback_reason'],
  properties: {
    backend: { type: 'string' },
    graph_status: { type: 'string' },
    graph_degraded_reason: { type: ['string', 'null'] },
    fallback_reason: { type: ['string', 'null'] },
  },
};

const symbolSearchResultItemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    lines: { type: 'string' },
    relevanceScore: { type: 'number' },
    matchType: { type: 'string' },
    retrievedAt: { type: 'string' },
  },
};

const symbolRankedResultsOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'symbol', 'top_k', 'results', 'freshness_warning', 'diagnostics'],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    symbol: { type: 'string' },
    top_k: { type: 'integer' },
    results: {
      type: 'array',
      items: symbolSearchResultItemSchema,
    },
    freshness_warning: { type: ['string', 'null'] },
    diagnostics: symbolNavigationDiagnosticsSchema,
  },
};

export const symbolSearchOutputSchema: JsonSchema = symbolRankedResultsOutputSchema;

export const symbolReferencesOutputSchema: JsonSchema = symbolRankedResultsOutputSchema;

export const symbolDefinitionOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'symbol', 'found', 'diagnostics'],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    symbol: { type: 'string' },
    found: { type: 'boolean' },
    file: { type: 'string' },
    line: { type: 'integer' },
    column: { type: ['integer', 'null'] },
    kind: { type: 'string' },
    score: { type: 'number' },
    snippet: { type: 'string' },
    diagnostics: symbolNavigationDiagnosticsSchema,
  },
};

const callRelationshipEntrySchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['file', 'line', 'snippet', 'score'],
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    column: { type: 'integer' },
    snippet: { type: 'string' },
    score: { type: 'number' },
    callerSymbol: { type: 'string' },
    calleeSymbol: { type: 'string' },
  },
};

export const callRelationshipsOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'symbol', 'direction', 'callers', 'callees', 'metadata'],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    symbol: { type: 'string' },
    direction: { type: 'string', enum: ['callers', 'callees', 'both'] },
    callers: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    callees: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

const graphNativeMetadataSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['deterministic'],
  properties: {
    requested_top_k: { type: 'integer' },
    graph_backed: { type: 'boolean' },
    graph_backed_operations: { type: 'integer' },
    heuristic_operations: { type: 'integer' },
    degraded: { type: 'boolean' },
    degraded_reasons: {
      type: 'array',
      items: { type: 'string' },
    },
    diagnostics: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
    analysis_scope: { type: 'string' },
    deterministic: { type: 'boolean' },
    transitive: { type: 'boolean' },
  },
};

export const findCallersOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'callers', 'metadata'],
  properties: {
    symbol: { type: 'string' },
    callers: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    metadata: graphNativeMetadataSchema,
  },
};

export const findCalleesOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'callees', 'metadata'],
  properties: {
    symbol: { type: 'string' },
    callees: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    metadata: graphNativeMetadataSchema,
  },
};

const traceSymbolReferenceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    lines: { type: 'string' },
    relevanceScore: { type: 'number' },
  },
};

const traceSymbolDefinitionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['symbol', 'found'],
  properties: {
    found: { type: 'boolean' },
    symbol: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    column: { type: 'integer' },
    kind: { type: 'string' },
    snippet: { type: 'string' },
    score: { type: 'number' },
    metadata: symbolNavigationDiagnosticsSchema,
  },
};

export const traceSymbolOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'definition', 'references', 'callers', 'callees', 'trace_summary', 'metadata'],
  properties: {
    symbol: { type: 'string' },
    definition: traceSymbolDefinitionSchema,
    references: {
      type: 'array',
      items: traceSymbolReferenceSchema,
    },
    callers: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    callees: {
      type: 'array',
      items: callRelationshipEntrySchema,
    },
    trace_summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'definition_found',
        'reference_count',
        'caller_count',
        'callee_count',
        'touched_files',
      ],
      properties: {
        definition_found: { type: 'boolean' },
        reference_count: { type: 'integer' },
        caller_count: { type: 'integer' },
        callee_count: { type: 'integer' },
        touched_files: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    metadata: graphNativeMetadataSchema,
  },
};

const codebaseRetrievalTraceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['match_type', 'source_stage'],
  properties: {
    match_type: { type: 'string', enum: ['semantic', 'keyword', 'hybrid', 'lexical', 'dense'] },
    source_stage: { type: 'string', enum: ['semantic', 'keyword', 'hybrid', 'lexical', 'dense'] },
    query_variant: { type: 'string' },
    variant_index: { type: 'number' },
  },
};

const codebaseRetrievalProvenanceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['graph_status', 'seed_symbols', 'neighbor_paths', 'selection_basis'],
  properties: {
    graph_status: {
      type: 'string',
      enum: ['ready', 'empty', 'degraded', 'stale', 'rebuild_required', 'unavailable'],
    },
    graph_degraded_reason: { type: ['string', 'null'] },
    seed_symbols: { type: 'array', items: { type: 'string' } },
    neighbor_paths: { type: 'array', items: { type: 'string' } },
    selection_basis: { type: 'array', items: { type: 'string' } },
  },
};

const codebaseRetrievalExplainabilitySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['selected_because', 'score_breakdown'],
  properties: {
    selected_because: { type: 'array', items: { type: 'string' } },
    score_breakdown: whyThisContextScoreBreakdownSchema,
    graph_signals: { type: 'array', items: whyThisContextGraphSignalSchema },
  },
};

const codebaseRetrievalResultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'score', 'reason', 'trace'],
  properties: {
    file: { type: 'string' },
    content: { type: 'string' },
    preview: { type: 'string' },
    score: { type: 'number' },
    lines: { type: 'string' },
    reason: { type: 'string' },
    trace: codebaseRetrievalTraceSchema,
    provenance: codebaseRetrievalProvenanceSchema,
    explainability: codebaseRetrievalExplainabilitySchema,
  },
};

const codebaseRetrievalMetadataSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: [
    'workspace',
    'lastIndexed',
    'queryTimeMs',
    'totalResults',
    'filtersApplied',
    'filteredPathsCount',
    'secondPassUsed',
  ],
  properties: {
    workspace: { type: 'string' },
    lastIndexed: { type: ['string', 'null'] },
    queryTimeMs: { type: 'number' },
    totalResults: { type: 'integer' },
    indexStatus: {
      type: 'object',
      additionalProperties: true,
      properties: {
        status: { type: 'string', enum: ['idle', 'indexing', 'error'] },
        fileCount: { type: 'integer' },
        isStale: { type: 'boolean' },
        lastError: { type: 'string' },
      },
    },
    freshnessWarning: { type: 'string' },
    filtersApplied: { type: 'array', items: { type: 'string' } },
    filteredPathsCount: { type: 'integer' },
    secondPassUsed: { type: 'boolean' },
    responseVersion: { type: 'string', enum: ['v2'] },
    providerResolution: { type: 'string' },
    query_mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'] },
    hybrid_components: {
      type: 'array',
      items: { type: 'string', enum: ['semantic', 'keyword', 'dense'] },
    },
    quality_guard_state: { type: 'string', enum: ['enabled', 'disabled'] },
    fallback_state: { type: 'string', enum: ['active', 'inactive'] },
    ranking_diagnostics: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

export const codebaseRetrievalOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results', 'metadata'],
  properties: {
    results: {
      type: 'array',
      items: codebaseRetrievalResultSchema,
    },
    metadata: codebaseRetrievalMetadataSchema,
  },
};

const semanticSearchSnippetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['trace', 'content', 'preview'],
  properties: {
    lines: { type: 'string' },
    relevance_score: { type: 'number' },
    trace: codebaseRetrievalTraceSchema,
    content: { type: 'string' },
    preview: { type: 'string' },
  },
};

const semanticSearchFileGroupSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'top_relevance', 'relevance_indicator', 'snippets'],
  properties: {
    path: { type: 'string' },
    top_relevance: { type: 'number' },
    relevance_indicator: { type: 'string' },
    snippets: {
      type: 'array',
      items: semanticSearchSnippetSchema,
    },
  },
};

const semanticSearchAuditRowSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file_path', 'match_type'],
  properties: {
    file_path: { type: 'string' },
    score: { type: 'number' },
    match_type: { type: 'string' },
    retrieved_at: { type: 'string' },
  },
};

export const semanticSearchOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'query',
    'result_count',
    'empty',
    'signal_summary',
    'freshness_warning',
    'fallback_diagnostics',
    'ranking_diagnostics',
    'file_groups',
    'audit_rows',
  ],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    query: { type: 'string' },
    result_count: { type: 'integer' },
    empty: { type: 'boolean' },
    signal_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['query_mode', 'hybrid_components', 'quality_guard_state', 'fallback_state'],
      properties: {
        query_mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'] },
        hybrid_components: {
          type: 'array',
          items: { type: 'string', enum: ['semantic', 'keyword', 'dense'] },
        },
        quality_guard_state: { type: 'string', enum: ['enabled', 'disabled'] },
        fallback_state: { type: 'string', enum: ['active', 'inactive'] },
      },
    },
    freshness_warning: { type: ['string', 'null'] },
    fallback_diagnostics: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['filters_applied', 'filtered_paths_count', 'second_pass_used'],
      properties: {
        filters_applied: { type: 'array', items: { type: 'string' } },
        filtered_paths_count: { type: 'integer' },
        second_pass_used: { type: 'boolean' },
      },
    },
    ranking_diagnostics: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
    file_groups: {
      type: 'array',
      items: semanticSearchFileGroupSchema,
    },
    audit_rows: {
      type: 'array',
      items: semanticSearchAuditRowSchema,
    },
  },
};

const contextPackItemSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'rank', 'content', 'token_count'],
  properties: {
    id: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['file', 'snippet', 'memory', 'hint', 'external'],
    },
    rank: { type: 'integer' },
    path: { type: 'string' },
    content: { type: 'string' },
    token_count: { type: 'integer' },
    relevance: { type: 'number' },
    lines: { type: 'string' },
    selection_rationale: { type: 'string' },
  },
};

const contextPackV3Schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'id', 'query', 'items', 'token_budget', 'metadata'],
  properties: {
    schema_version: { type: 'string', const: '3.0' },
    id: { type: 'string' },
    query: { type: 'string' },
    items: {
      type: 'array',
      items: contextPackItemSchema,
    },
    token_budget: {
      type: 'object',
      additionalProperties: false,
      required: ['requested', 'used', 'truncated'],
      properties: {
        requested: { type: 'integer' },
        used: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      required: ['item_count', 'file_count', 'truncated', 'assembled_at'],
      properties: {
        item_count: { type: 'integer' },
        file_count: { type: 'integer' },
        truncated: { type: 'boolean' },
        truncation_reasons: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['token_budget', 'max_items', 'max_item_content_chars', 'max_total_content_chars'],
          },
        },
        summary: { type: 'string' },
        search_time_ms: { type: 'number' },
        assembled_at: { type: 'string' },
      },
    },
  },
};

const getContextSnippetSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'lines'],
  properties: {
    text: { type: 'string' },
    lines: { type: 'string' },
    code_type: { type: 'string' },
  },
};

const getContextFileSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['path', 'extension', 'summary', 'relevance', 'snippets'],
  properties: {
    path: { type: 'string' },
    extension: { type: 'string' },
    summary: { type: 'string' },
    relevance: { type: 'number' },
    related_files: { type: 'array', items: { type: 'string' } },
    selection_rationale: { type: 'string' },
    selection_explainability: {
      type: 'object',
      additionalProperties: true,
    },
    selection_provenance: {
      type: 'object',
      additionalProperties: true,
    },
    snippets: {
      type: 'array',
      items: getContextSnippetSchema,
    },
  },
};

export const getContextForPromptOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'query',
    'summary',
    'freshness_warning',
    'stats',
    'hints',
    'handoff',
    'memories',
    'files',
    'context_packs_v2_enabled',
    'search_time_ms',
  ],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    query: { type: 'string' },
    summary: { type: 'string' },
    freshness_warning: { type: ['string', 'null'] },
    stats: {
      type: 'object',
      additionalProperties: true,
      required: ['total_files', 'total_snippets', 'total_tokens', 'token_budget', 'truncated'],
      properties: {
        total_files: { type: 'integer' },
        total_snippets: { type: 'integer' },
        total_tokens: { type: 'integer' },
        token_budget: { type: 'integer' },
        truncated: { type: 'boolean' },
        memories_included: { type: 'integer' },
        memories_startup_pack_included: { type: 'integer' },
        draft_memories_included: { type: 'integer' },
      },
    },
    hints: {
      type: 'array',
      items: { type: 'string' },
    },
    handoff: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
    memories: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    files: {
      type: 'array',
      items: getContextFileSchema,
    },
    dependency_map: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    external_references: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    external_metadata: {
      type: 'object',
      additionalProperties: true,
      properties: {
        sources_requested: { type: 'integer' },
        sources_used: { type: 'integer' },
        warnings: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
    context_packs_v2_enabled: { type: 'boolean' },
    search_time_ms: { type: 'number' },
    context_pack: contextPackV3Schema,
  },
};

const testCandidateSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'strategy', 'confidence', 'reason'],
  properties: {
    path: { type: 'string' },
    strategy: {
      type: 'string',
      enum: [
        'symbol_reference',
        'caller_test_file',
        'callee_test_file',
        'naming_convention',
        'same_folder',
        'mirror_tests_folder',
      ],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
    related_source: { type: 'string' },
  },
};

const runtimeImpactEntrySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'role'],
  properties: {
    path: { type: 'string' },
    role: { type: 'string', enum: ['definition', 'reference', 'caller', 'callee'] },
    symbol: { type: 'string' },
  },
};

const impactRiskSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'severity', 'message'],
  properties: {
    code: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    message: { type: 'string' },
  },
};

const recommendedValidationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'description'],
  properties: {
    kind: { type: 'string', enum: ['test_command', 'smoke_check'] },
    command: { type: 'string' },
    description: { type: 'string' },
  },
};

export const impactAnalysisOutputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'symbol',
    'definition',
    'impact_summary',
    'impact_surface',
    'test_candidates',
    'runtime_impact',
    'risks',
    'recommended_validation',
    'metadata',
  ],
  properties: {
    symbol: { type: 'string' },
    definition: traceSymbolDefinitionSchema,
    impact_summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'direct_reference_count',
        'direct_caller_count',
        'direct_callee_count',
        'impacted_file_count',
        'impacted_files',
        'risk_level',
        'risk_score',
        'risk_reasons',
      ],
      properties: {
        direct_reference_count: { type: 'integer' },
        direct_caller_count: { type: 'integer' },
        direct_callee_count: { type: 'integer' },
        impacted_file_count: { type: 'integer' },
        impacted_files: {
          type: 'array',
          items: { type: 'string' },
        },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        risk_score: { type: 'number' },
        risk_reasons: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    impact_surface: {
      type: 'object',
      additionalProperties: false,
      required: ['references', 'callers', 'callees'],
      properties: {
        references: {
          type: 'array',
          items: traceSymbolReferenceSchema,
        },
        callers: {
          type: 'array',
          items: callRelationshipEntrySchema,
        },
        callees: {
          type: 'array',
          items: callRelationshipEntrySchema,
        },
      },
    },
    test_candidates: {
      type: 'array',
      items: testCandidateSchema,
    },
    runtime_impact: {
      type: 'array',
      items: runtimeImpactEntrySchema,
    },
    risks: {
      type: 'array',
      items: impactRiskSchema,
    },
    recommended_validation: {
      type: 'array',
      items: recommendedValidationSchema,
    },
    metadata: graphNativeMetadataSchema,
  },
};
