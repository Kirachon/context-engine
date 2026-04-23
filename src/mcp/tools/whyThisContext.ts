import { ContextOptions, ContextServiceClient } from '../serviceClient.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface WhyThisContextArgs {
  query: string;
  max_files?: number;
  token_budget?: number;
  include_related?: boolean;
  min_relevance?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
}

type ExplainableFileContext = {
  path: string;
  summary?: string;
  relevance: number;
  snippets?: Array<unknown>;
  relatedFiles?: string[];
  selectionExplainability?: {
    selectedBecause?: string[];
    scoreBreakdown?: {
      baseScore?: number;
      graphScore?: number;
      combinedScore?: number;
      semanticScore?: number;
      lexicalScore?: number;
      denseScore?: number;
      fusedScore?: number;
    };
    graphSignals?: Array<{
      kind?: string;
      value?: string;
      weight?: number;
    }>;
  };
  selectionProvenance?: {
    graphStatus?: string;
    graphDegradedReason?: string | null;
    seedSymbols?: string[];
    neighborPaths?: string[];
    selectionBasis?: string[];
  };
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function buildFileDegradedReasons(file: ExplainableFileContext): string[] {
  const reasons: string[] = [];
  const explainability = file.selectionExplainability;
  const provenance = file.selectionProvenance;

  if (!explainability || !provenance) {
    reasons.push('selection_receipts_missing');
  }
  if (provenance?.graphDegradedReason) {
    reasons.push(provenance.graphDegradedReason);
  }
  if (provenance?.graphStatus && provenance.graphStatus !== 'ready' && !provenance.graphDegradedReason) {
    reasons.push(`graph_status_${provenance.graphStatus}`);
  }

  return uniqueStrings(reasons).sort((left, right) => left.localeCompare(right));
}

function buildExplainability(file: ExplainableFileContext) {
  const explainability = file.selectionExplainability;
  if (!explainability) {
    return null;
  }

  return {
    selected_because: explainability.selectedBecause ?? [],
    score_breakdown: {
      base_score: explainability.scoreBreakdown?.baseScore ?? 0,
      graph_score: explainability.scoreBreakdown?.graphScore ?? 0,
      combined_score: explainability.scoreBreakdown?.combinedScore ?? 0,
      ...(explainability.scoreBreakdown?.semanticScore !== undefined
        ? { semantic_score: explainability.scoreBreakdown.semanticScore }
        : {}),
      ...(explainability.scoreBreakdown?.lexicalScore !== undefined
        ? { lexical_score: explainability.scoreBreakdown.lexicalScore }
        : {}),
      ...(explainability.scoreBreakdown?.denseScore !== undefined
        ? { dense_score: explainability.scoreBreakdown.denseScore }
        : {}),
      ...(explainability.scoreBreakdown?.fusedScore !== undefined
        ? { fused_score: explainability.scoreBreakdown.fusedScore }
        : {}),
    },
    ...(explainability.graphSignals?.length
      ? {
          graph_signals: explainability.graphSignals.map((signal) => ({
            kind: signal.kind ?? 'unknown',
            value: signal.value ?? '',
            weight: signal.weight ?? 0,
          })),
        }
      : {}),
  };
}

function buildProvenance(file: ExplainableFileContext) {
  const provenance = file.selectionProvenance;
  if (!provenance) {
    return null;
  }

  return {
    graph_status: provenance.graphStatus ?? 'unavailable',
    graph_degraded_reason: provenance.graphDegradedReason ?? null,
    seed_symbols: provenance.seedSymbols ?? [],
    neighbor_paths: provenance.neighborPaths ?? [],
    selection_basis: provenance.selectionBasis ?? [],
  };
}

export async function handleWhyThisContext(
  args: WhyThisContextArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const query = validateTrimmedNonEmptyString(args.query, 'query');
  validateFiniteNumberInRange(args.max_files, 1, 20, 'invalid max_files');
  validateFiniteNumberInRange(args.token_budget, 500, 100000, 'invalid token_budget');
  validateBoolean(args.include_related, 'invalid include_related');
  validateFiniteNumberInRange(args.min_relevance, 0, 1, 'invalid min_relevance');
  validateBoolean(args.bypass_cache, 'invalid bypass_cache');

  const options: ContextOptions = {
    maxFiles: args.max_files ?? 5,
    tokenBudget: args.token_budget ?? 8000,
    includeRelated: args.include_related ?? true,
    minRelevance: args.min_relevance ?? 0.3,
    includeSummaries: true,
    includeMemories: true,
    bypassCache: args.bypass_cache ?? false,
    includePaths: args.include_paths ? validatePathScopeGlobs(args.include_paths, 'include_paths') : undefined,
    excludePaths: args.exclude_paths ? validatePathScopeGlobs(args.exclude_paths, 'exclude_paths') : undefined,
  };

  const bundle = await serviceClient.getContextForPrompt(query, options);
  const files = (bundle.files as ExplainableFileContext[]).map((file) => {
    const degradedReasons = buildFileDegradedReasons(file);

    return {
      path: file.path,
      summary: file.summary ?? '',
      relevance: file.relevance,
      snippet_count: file.snippets?.length ?? 0,
      ...(file.relatedFiles?.length ? { related_files: file.relatedFiles } : {}),
      explainability: buildExplainability(file),
      provenance: buildProvenance(file),
      degraded: degradedReasons.length > 0,
      degraded_reasons: degradedReasons,
    };
  });

  const overallDegradedReasons = [...new Set(files.flatMap((file) => file.degraded_reasons))].sort((left, right) =>
    left.localeCompare(right)
  );
  const graphStatuses = [...new Set(
    files
      .map((file) => file.provenance?.graph_status)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  )].sort((left, right) => left.localeCompare(right));

  return JSON.stringify(
    {
      query,
      summary: bundle.summary,
      files,
      metadata: {
        total_files: bundle.files.length,
        explainable_file_count: files.filter((file) => file.explainability !== null || file.provenance !== null).length,
        graph_statuses: graphStatuses,
        degraded: overallDegradedReasons.length > 0,
        degraded_reasons: overallDegradedReasons,
        analysis_scope: 'context_selection_receipts_only',
        deterministic: true,
        query_time_ms: bundle.metadata.searchTimeMs,
        token_budget: options.tokenBudget,
        include_related: options.includeRelated,
      },
    },
    null,
    2
  );
}

export const whyThisContextTool = {
  name: 'why_this_context',
  description: `Explain why files were selected into a context bundle using the shared retrieval provenance and explainability contract.

This tool reuses the same selection vocabulary exposed by graph-aware retrieval and get_context_for_prompt instead of inventing a parallel explanation path.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language request whose selected context you want explained.',
      },
      max_files: {
        type: 'integer',
        description: 'Maximum number of files to inspect from the context bundle (1-20). Defaults to 5.',
        minimum: 1,
        maximum: 20,
      },
      token_budget: {
        type: 'integer',
        description: 'Token budget to forward into context retrieval before explaining the selected files. Defaults to 8000.',
        minimum: 500,
        maximum: 100000,
      },
      include_related: {
        type: 'boolean',
        description: 'Whether to include related-file expansion before summarizing why files were selected. Defaults to true.',
      },
      min_relevance: {
        type: 'number',
        description: 'Minimum relevance score (0-1) to include a file. Defaults to 0.3.',
        minimum: 0,
        maximum: 1,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['query'],
  },
};
