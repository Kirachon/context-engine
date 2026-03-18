/**
 * Layer 3: MCP Interface Layer - Search Tool
 *
 * Exposes semantic_search as an MCP tool
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to service layer
 * - Format results for optimal LLM consumption
 *
 * Use Cases:
 * - Find specific code patterns or implementations
 * - Locate functions, classes, or types by description
 * - Quick exploration of codebase for specific concepts
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalRetrieveCode } from '../../internal/handlers/retrieval.js';
import { internalIndexStatus } from '../../internal/handlers/utilities.js';
import { featureEnabled } from '../../config/features.js';
import { getIndexFreshnessWarning } from '../tooling/indexFreshness.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validateMaxLength,
  validateTrimmedNonEmptyString,
  validateOneOf,
} from '../tooling/validation.js';

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
}

type FallbackDiagnostics = {
  filtersApplied?: string[];
  filteredPathsCount?: number;
  secondPassUsed?: boolean;
};

type RetrievalSignalSummary = {
  queryMode: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents: Array<'semantic' | 'keyword' | 'dense'>;
  qualityGuardState: 'enabled' | 'disabled';
  fallbackState: 'active' | 'inactive';
};

type InternalRetrievalSignalMetadata = {
  queryMode?: 'semantic' | 'keyword' | 'hybrid';
  hybridComponents?: Array<'semantic' | 'keyword' | 'dense'>;
  qualityGuardState?: 'enabled' | 'disabled';
  fallbackState?: 'active' | 'inactive';
};

type ResultTraceCandidate = {
  matchType?: string;
  retrievalSource?: string;
  queryVariant?: string;
  variantIndex?: number;
};

type ResultTraceStage = 'semantic' | 'keyword' | 'hybrid' | 'lexical' | 'dense';

type ResultTraceEnvelope = {
  source_stage: ResultTraceStage;
  match_type: ResultTraceStage;
  query_variant?: string;
  variant_index?: number;
};

type RawFallbackDiagnostics = {
  filters_applied?: string[];
  filtered_paths_count?: number;
  second_pass_used?: boolean;
  filtersApplied?: string[];
  filteredPathsCount?: number;
  secondPassUsed?: boolean;
};

function normalizeFallbackDiagnostics(diagnostics: RawFallbackDiagnostics): FallbackDiagnostics {
  return {
    filtersApplied:
      diagnostics.filters_applied ??
      ('filtersApplied' in diagnostics ? diagnostics.filtersApplied : undefined),
    filteredPathsCount:
      diagnostics.filtered_paths_count ??
      ('filteredPathsCount' in diagnostics ? diagnostics.filteredPathsCount : undefined),
    secondPassUsed:
      diagnostics.second_pass_used ??
      ('secondPassUsed' in diagnostics ? diagnostics.secondPassUsed : undefined),
  };
}

function getFallbackDiagnostics(serviceClient: ContextServiceClient): FallbackDiagnostics | null {
  const maybeClient = serviceClient as ContextServiceClient & {
    getLastSearchDiagnostics?: () => RawFallbackDiagnostics | null | undefined;
    getLastFallbackDiagnostics?: () => RawFallbackDiagnostics | null | undefined;
  };

  const searchDiagnostics = maybeClient.getLastSearchDiagnostics?.();
  if (searchDiagnostics) {
    return normalizeFallbackDiagnostics(searchDiagnostics);
  }

  const fallbackDiagnostics = maybeClient.getLastFallbackDiagnostics?.();
  if (fallbackDiagnostics) {
    return normalizeFallbackDiagnostics(fallbackDiagnostics);
  }

  return null;
}

function summarizeRetrievalSignals(
  results: Array<{ matchType?: string; retrievalSource?: string }>,
  _fallbackDiagnostics: FallbackDiagnostics | null,
  metadata?: InternalRetrievalSignalMetadata
): RetrievalSignalSummary {
  const components = new Set<'semantic' | 'keyword' | 'dense'>();

  for (const result of results) {
    const source = (result.retrievalSource ?? result.matchType ?? '').toLowerCase();
    if (source === 'hybrid') {
      components.add('semantic');
      components.add('keyword');
      continue;
    }
    if (source === 'semantic') components.add('semantic');
    if (source === 'keyword' || source === 'lexical') components.add('keyword');
    if (source === 'dense') components.add('dense');
  }

  if (components.size === 0) {
    components.add('semantic');
  }

  const computedQueryMode: RetrievalSignalSummary['queryMode'] =
    components.has('semantic') && (components.has('keyword') || components.has('dense'))
      ? 'hybrid'
      : components.has('keyword')
        ? 'keyword'
        : 'semantic';

  const metadataFallbackActive = metadata?.fallbackState === 'active';

  return {
    queryMode: metadata?.queryMode ?? computedQueryMode,
    hybridComponents: metadata?.hybridComponents ?? Array.from(components.values()),
    qualityGuardState: metadata?.qualityGuardState ?? (featureEnabled('retrieval_quality_guard_v1') ? 'enabled' : 'disabled'),
    fallbackState: metadataFallbackActive ? 'active' : 'inactive',
  };
}

/**
 * Format relevance score as a visual indicator
 */
function formatRelevance(score: number | undefined): string {
  if (score === undefined) return '';
  if (score >= 0.8) return '🔥';
  if (score >= 0.6) return '✅';
  if (score >= 0.4) return '📊';
  return '📌';
}

function normalizeTraceStage(rawStage: string | undefined): ResultTraceStage {
  const sourceStage = (rawStage ?? 'semantic').toLowerCase();
  return sourceStage === 'keyword' ||
    sourceStage === 'hybrid' ||
    sourceStage === 'lexical' ||
    sourceStage === 'dense'
    ? sourceStage
    : 'semantic';
}

function buildResultTraceEnvelope(result: ResultTraceCandidate): ResultTraceEnvelope {
  const stage = normalizeTraceStage(result.retrievalSource ?? result.matchType);
  const envelope: ResultTraceEnvelope = {
    source_stage: stage,
    match_type: stage,
  };

  if (result.queryVariant && result.queryVariant.trim().length > 0) {
    envelope.query_variant = result.queryVariant.trim();
  }
  if (typeof result.variantIndex === 'number' && Number.isFinite(result.variantIndex)) {
    envelope.variant_index = result.variantIndex;
  }

  return envelope;
}

function formatResultTrace(result: ResultTraceCandidate): string {
  const trace = buildResultTraceEnvelope(result);
  const parts = [
    `source_stage=${trace.source_stage}`,
    `match_type=${trace.match_type}`,
  ];
  if (trace.query_variant) {
    const escaped = trace.query_variant.replace(/"/g, '\\"');
    parts.push(`query_variant="${escaped}"`);
  }
  if (typeof trace.variant_index === 'number' && Number.isFinite(trace.variant_index)) {
    parts.push(`variant_index=${trace.variant_index}`);
  }
  return parts.join('; ');
}

type RetrievalProfile = 'fast' | 'balanced' | 'rich';

type RetrievalProfileSettings = {
  perQueryMultiplier: number;
  maxVariants: number;
  maxOutputLengthPerResult: number;
  enableExpansion: boolean;
  enableRerank: boolean;
  rerankTopN: number;
  rerankTimeoutMs: number;
};

const RETRIEVAL_PROFILE_MAP: Record<RetrievalProfile, RetrievalProfileSettings> = {
  fast: {
    perQueryMultiplier: 1,
    maxVariants: 1,
    maxOutputLengthPerResult: 2000,
    enableExpansion: false,
    enableRerank: false,
    rerankTopN: 10,
    rerankTimeoutMs: 50,
  },
  balanced: {
    perQueryMultiplier: 2,
    maxVariants: 4,
    maxOutputLengthPerResult: 3000,
    enableExpansion: true,
    enableRerank: true,
    rerankTopN: 20,
    rerankTimeoutMs: 80,
  },
  rich: {
    perQueryMultiplier: 3,
    maxVariants: 6,
    maxOutputLengthPerResult: 4000,
    enableExpansion: true,
    enableRerank: true,
    rerankTopN: 40,
    rerankTimeoutMs: 160,
  },
};

function resolveSearchProfile(mode: 'fast' | 'deep', profile?: RetrievalProfile): RetrievalProfile {
  if (profile) {
    return profile;
  }
  return mode === 'deep' ? 'rich' : 'fast';
}

export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { query, top_k = 10, mode = 'fast', profile, bypass_cache = false, timeout_ms } = args;

  // Validate inputs
  const validQuery = validateTrimmedNonEmptyString(query, 'Invalid query parameter: must be a non-empty string');
  validateMaxLength(validQuery, 500, 'Query too long: maximum 500 characters');
  validateFiniteNumberInRange(top_k, 1, 50, 'Invalid top_k parameter: must be a number between 1 and 50');
  validateOneOf(mode, ['fast', 'deep'] as const, 'Invalid mode parameter: must be "fast" or "deep"');
  if (profile !== undefined) {
    validateOneOf(
      profile,
      ['fast', 'balanced', 'rich'] as const,
      'Invalid profile parameter: must be "fast", "balanced", or "rich"'
    );
  }
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  validateFiniteNumberInRange(
    timeout_ms,
    0,
    120000,
    'Invalid timeout_ms parameter: must be a number between 0 and 120000'
  );

  const effectiveTimeoutMs = timeout_ms ?? (bypass_cache ? 10000 : 0);
  const effectiveProfile = resolveSearchProfile(mode, profile);
  const profileSettings = RETRIEVAL_PROFILE_MAP[effectiveProfile];
  const rerankTopN = Math.max(top_k, profileSettings.rerankTopN);
  const retrievalOptions = {
    topK: top_k,
    perQueryTopK: Math.min(50, top_k * profileSettings.perQueryMultiplier),
    maxVariants: profileSettings.maxVariants,
    profile: effectiveProfile,
    rewriteMode: featureEnabled('retrieval_rewrite_v2') ? 'v2' as const : 'v1' as const,
    rankingMode: featureEnabled('retrieval_ranking_v3')
      ? 'v3' as const
      : featureEnabled('retrieval_ranking_v2')
        ? 'v2' as const
        : 'v1' as const,
    timeoutMs: effectiveTimeoutMs,
    bypassCache: bypass_cache,
    maxOutputLength: top_k * profileSettings.maxOutputLengthPerResult,
    enableExpansion: profileSettings.enableExpansion,
    enableRerank: profileSettings.enableRerank,
    rerankTopN,
    rerankTimeoutMs: profileSettings.rerankTimeoutMs,
  };

  const retrieval = await internalRetrieveCode(validQuery, serviceClient, retrievalOptions);
  const results = retrieval.results;
  const fallbackDiagnostics = getFallbackDiagnostics(serviceClient);
  const signalSummary = summarizeRetrievalSignals(
    results as Array<{ matchType?: string; retrievalSource?: string }>,
    fallbackDiagnostics,
    retrieval
  );
  const status = internalIndexStatus(serviceClient);
  const freshnessWarning = getIndexFreshnessWarning(status, { prefix: '⚠️ ' });

  // Format results for agent consumption
  if (results.length === 0) {
    let output = `# 🔍 Search Results\n\n`;
    output += `**Query:** "${validQuery}"\n\n`;
    if (freshnessWarning) {
      output += `${freshnessWarning}\n\n`;
    }
    output += `_No results found. Try:\n`;
    output += `- Using different keywords\n`;
    output += `- Being more general or more specific\n`;
    output += `- Checking if the codebase is indexed_\n`;
    return output;
  }

  let output = `# 🔍 Search Results\n\n`;
  output += `**Query:** "${validQuery}"\n`;
  output += `**Found:** ${results.length} matching snippets\n\n`;
  output += `**Query Mode:** ${signalSummary.queryMode}\n`;
  output += `**Hybrid Components:** ${signalSummary.hybridComponents.join(', ')}\n`;
  output += `**Quality Guard:** ${signalSummary.qualityGuardState}\n`;
  output += `**Fallback State:** ${signalSummary.fallbackState}\n\n`;
  if (freshnessWarning) {
    output += `${freshnessWarning}\n\n`;
  }
  if ((fallbackDiagnostics?.filtersApplied?.length ?? 0) > 0) {
    output += `**Fallback Diagnostics:** filters_applied=${fallbackDiagnostics!.filtersApplied!.join(', ')}; `;
    output += `filtered_paths_count=${fallbackDiagnostics?.filteredPathsCount ?? 0}; `;
    output += `second_pass_used=${fallbackDiagnostics?.secondPassUsed ? 'true' : 'false'}\n\n`;
  }

  // Group results by file for better organization
  const fileGroups = new Map<string, typeof results>();
  for (const result of results) {
    if (!fileGroups.has(result.path)) {
      fileGroups.set(result.path, []);
    }
    fileGroups.get(result.path)!.push(result);
  }

  output += `## Results by File\n\n`;

  let fileIndex = 0;
  for (const [filePath, fileResults] of fileGroups) {
    fileIndex++;
    const topRelevance = Math.max(...fileResults.map(r => r.relevanceScore || 0));
    const indicator = formatRelevance(topRelevance);

    output += `### ${fileIndex}. \`${filePath}\` ${indicator}\n\n`;

    for (const result of fileResults) {
      if (result.lines) {
        output += `**Lines ${result.lines}**`;
      }
      if (result.relevanceScore) {
        output += ` (${(result.relevanceScore * 100).toFixed(0)}% match)`;
      }
      output += `\n\n`;
      output += `Trace: ${formatResultTrace(result as unknown as ResultTraceCandidate)}\n\n`;

      // Show a preview of the content
      const preview = result.content.length > 300
        ? result.content.substring(0, 300) + '...'
        : result.content;

      output += '```\n';
      output += preview;
      output += '\n```\n\n';
    }
  }

  // Retrieval audit table (sorted by highest score, max 10 entries)
  const auditRows = Array.from(fileGroups.entries())
    .map(([filePath, fileResults]) => {
      const best = fileResults.reduce((acc, cur) => {
        const currentScore = cur.relevanceScore ?? 0;
        return currentScore > (acc.relevanceScore ?? 0) ? cur : acc;
      }, fileResults[0]);

      return {
        filePath,
        score: best.relevanceScore,
        matchType: best.matchType ?? (best as unknown as { retrievalSource?: string }).retrievalSource ?? 'semantic',
        retrievedAt: best.retrievedAt,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  if (auditRows.length > 0) {
    output += `## Retrieval Audit\n\n`;
    output += `| File | Score | Type | Retrieved |\n`;
    output += `|------|-------|------|-----------|\n`;
    for (const row of auditRows) {
      const scoreText = row.score !== undefined ? `${(row.score * 100).toFixed(0)}%` : 'n/a';
      const retrieved = row.retrievedAt ?? 'now';
      output += `| \`${row.filePath}\` | ${scoreText} | ${row.matchType} | ${retrieved} |\n`;
    }
    output += `\n`;
  }

  output += `---\n`;
  output += `_Use \`get_context_for_prompt\` for more comprehensive context or \`get_file\` for complete file contents._\n`;

  return output;
}

export const semanticSearchTool = {
  name: 'semantic_search',
  description: `Perform semantic search across the codebase to find relevant code snippets.

Use this tool when you need to:
- Find specific functions, classes, or implementations
- Locate code that handles a particular concept
- Quickly explore what exists in the codebase

For comprehensive context with file summaries and related files, use get_context_for_prompt instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of what you\'re looking for (e.g., "user authentication", "database connection", "API error handling")',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      mode: {
        type: 'string',
        description: 'Search mode: "fast" (default) uses cached results and moderate expansion; "deep" increases expansion/budget for better recall at higher latency.',
        default: 'fast',
        enum: ['fast', 'deep'],
      },
      profile: {
        type: 'string',
        description: 'Optional retrieval profile override. "fast" is low-latency, "balanced" increases recall, "rich" maximizes recall/cost.',
        enum: ['fast', 'balanced', 'rich'],
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call (useful for benchmarking or ensuring freshest results).',
        default: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'Max time to spend on the retrieval pipeline in milliseconds. 0/undefined means no timeout.',
        default: 0,
      },
    },
    required: ['query'],
  },
};
