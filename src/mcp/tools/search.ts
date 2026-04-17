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
import type { RankingDiagnostics } from '../../internal/handlers/types.js';
import { getIndexFreshnessWarning } from '../tooling/indexFreshness.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validateMaxLength,
  validatePathScopeGlobs,
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

function formatRankingDiagnostics(diagnostics: RankingDiagnostics): string {
  return [
    `ranking_mode=${diagnostics.rankingMode}`,
    `score_spread=${diagnostics.scoreSpread.toFixed(3)}`,
    `source_consensus=${diagnostics.sourceConsensus}`,
    `fallback_reason=${diagnostics.fallbackReason}`,
    `rerank_gate_state=${diagnostics.rerankGateState}`,
  ].join('; ');
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

function formatSimpleSearchResults(params: {
  heading: string;
  subjectLabel: string;
  subjectValue: string;
  results: Array<{
    path: string;
    content: string;
    lines?: string;
    relevanceScore?: number;
    matchType?: string;
    retrievedAt?: string;
  }>;
  statusWarning?: string;
  emptyHint: string[];
  footer: string;
}): string {
  const { heading, subjectLabel, subjectValue, results, statusWarning, emptyHint, footer } = params;
  if (results.length === 0) {
    let output = `${heading}\n\n`;
    output += `**${subjectLabel}:** "${subjectValue}"\n\n`;
    if (statusWarning) {
      output += `${statusWarning}\n\n`;
    }
    output += `_No results found. Try:\n`;
    for (const hint of emptyHint) {
      output += `- ${hint}\n`;
    }
    output += '_\n';
    return output;
  }

  let output = `${heading}\n\n`;
  output += `**${subjectLabel}:** "${subjectValue}"\n`;
  output += `**Found:** ${results.length} matching snippets\n\n`;
  if (statusWarning) {
    output += `${statusWarning}\n\n`;
  }

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
    fileIndex += 1;
    const topRelevance = Math.max(...fileResults.map((result) => result.relevanceScore || 0));
    output += `### ${fileIndex}. \`${filePath}\` ${formatRelevance(topRelevance)}\n\n`;

    for (const result of fileResults) {
      if (result.lines) {
        output += `**Lines ${result.lines}**`;
      }
      if (result.relevanceScore) {
        output += ` (${(result.relevanceScore * 100).toFixed(0)}% match)`;
      }
      output += `\n\n`;
      output += `Trace: ${formatResultTrace(result as unknown as ResultTraceCandidate)}\n\n`;
      output += '```\n';
      output += result.content.length > 300 ? `${result.content.substring(0, 300)}...` : result.content;
      output += '\n```\n\n';
    }
  }

  output += `---\n${footer}\n`;
  return output;
}

export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const {
    query,
    top_k = 10,
    mode = 'fast',
    profile,
    bypass_cache = false,
    timeout_ms,
    include_paths,
    exclude_paths,
  } = args;

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
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');

  const effectiveTimeoutMs = timeout_ms ?? (bypass_cache ? 10000 : 0);
  const effectiveProfile = resolveSearchProfile(mode, profile);
  const profileSettings = RETRIEVAL_PROFILE_MAP[effectiveProfile];
  const rerankTopN = Math.max(top_k, profileSettings.rerankTopN);
  const denseEnabled = featureEnabled('retrieval_lancedb_v1') && effectiveProfile !== 'fast';
  const denseWeight = denseEnabled ? (effectiveProfile === 'rich' ? 0.3 : 0.2) : 0;
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
    enableDense: denseEnabled,
    denseWeight,
    enableRerank: profileSettings.enableRerank,
    rerankTopN,
    rerankTimeoutMs: profileSettings.rerankTimeoutMs,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
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
  if (retrieval.rankingDiagnostics) {
    output += `**Ranking Diagnostics:** ${formatRankingDiagnostics(retrieval.rankingDiagnostics as RankingDiagnostics)}\n\n`;
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

export async function handleSymbolSearch(
  args: SymbolSearchArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { symbol, top_k = 10, bypass_cache = false, include_paths, exclude_paths } = args;

  const validSymbol = validateTrimmedNonEmptyString(symbol, 'Invalid symbol parameter: must be a non-empty string');
  validateMaxLength(validSymbol, 200, 'Symbol too long: maximum 200 characters');
  validateFiniteNumberInRange(top_k, 1, 50, 'Invalid top_k parameter: must be a number between 1 and 50');
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');

  const results = await serviceClient.symbolSearch(validSymbol, top_k, {
    bypassCache: bypass_cache,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
  });
  const status = internalIndexStatus(serviceClient);
  const freshnessWarning = getIndexFreshnessWarning(status, { prefix: '⚠️ ' });

  return formatSimpleSearchResults({
    heading: '# 🔎 Symbol Search Results',
    subjectLabel: 'Symbol',
    subjectValue: validSymbol,
    results,
    statusWarning: freshnessWarning ?? undefined,
    emptyHint: [
      'using the fully qualified identifier or class/function name',
      'scoping the search with include_paths',
      'checking if the workspace index is fresh',
    ],
    footer: '_Use `get_file` to inspect a matching file or `semantic_search` when you need broader concept-level exploration._',
  });
}

export async function handleSymbolReferencesSearch(
  args: SymbolReferencesArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { symbol, top_k = 10, bypass_cache = false, include_paths, exclude_paths } = args;

  const validSymbol = validateTrimmedNonEmptyString(symbol, 'Invalid symbol parameter: must be a non-empty string');
  validateMaxLength(validSymbol, 200, 'Symbol too long: maximum 200 characters');
  validateFiniteNumberInRange(top_k, 1, 50, 'Invalid top_k parameter: must be a number between 1 and 50');
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');

  const results = await serviceClient.symbolReferencesSearch(validSymbol, top_k, {
    bypassCache: bypass_cache,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
  });
  const status = internalIndexStatus(serviceClient);
  const freshnessWarning = getIndexFreshnessWarning(status, { prefix: '⚠️ ' });

  return formatSimpleSearchResults({
    heading: '# 🔗 Symbol Reference Results',
    subjectLabel: 'Symbol',
    subjectValue: validSymbol,
    results,
    statusWarning: freshnessWarning ?? undefined,
    emptyHint: [
      'using the exact identifier spelling',
      'scoping the search with include_paths to likely consumers',
      'trying symbol_search first to confirm the declaration name',
    ],
    footer: '_Use `symbol_search` to jump to declarations or `get_file` to inspect a matching usage in full._',
  });
}

export async function handleSymbolDefinition(
  args: SymbolDefinitionArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { symbol, language_hint, bypass_cache = false, include_paths, exclude_paths } = args;

  const validSymbol = validateTrimmedNonEmptyString(symbol, 'Invalid symbol parameter: must be a non-empty string');
  validateMaxLength(validSymbol, 200, 'Symbol too long: maximum 200 characters');
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');
  if (language_hint !== undefined && typeof language_hint !== 'string') {
    throw new Error('Invalid language_hint parameter: must be a string when provided');
  }

  const result = await serviceClient.symbolDefinition(validSymbol, {
    bypassCache: bypass_cache,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
    languageHint: typeof language_hint === 'string' ? language_hint : undefined,
  });

  if (!result.found) {
    let output = '# 📍 Symbol Definition\n\n';
    output += `**Symbol:** "${validSymbol}"\n\n`;
    output += '_No definition found. Try:\n';
    output += '- using the exact identifier spelling\n';
    output += '- scoping the search with include_paths to likely declaration sites\n';
    output += '- running `symbol_search` to confirm the canonical declaration name\n';
    output += '_\n';
    return output;
  }

  let output = '# 📍 Symbol Definition\n\n';
  output += `**Symbol:** "${result.symbol}"\n`;
  output += `**File:** \`${result.file}\`\n`;
  output += `**Line:** ${result.line}`;
  if (result.column !== undefined) {
    output += `, **Column:** ${result.column}`;
  }
  output += `\n**Kind:** ${result.kind}\n`;
  output += `**Score:** ${result.score}\n\n`;
  output += '```\n';
  output += result.snippet.length > 600 ? `${result.snippet.substring(0, 600)}...` : result.snippet;
  output += '\n```\n\n';
  output += '---\n_Use `symbol_references` to find call sites or `get_file` to read the full file._\n';
  return output;
}

export async function handleCallRelationships(
  args: CallRelationshipsArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const {
    symbol,
    direction = 'both',
    top_k = 20,
    language_hint,
    bypass_cache = false,
    include_paths,
    exclude_paths,
  } = args;

  const validSymbol = validateTrimmedNonEmptyString(symbol, 'Invalid symbol parameter: must be a non-empty string');
  validateMaxLength(validSymbol, 200, 'Symbol too long: maximum 200 characters');
  validateOneOf(
    direction,
    ['callers', 'callees', 'both'] as const,
    'Invalid direction parameter: must be one of callers, callees, both'
  );
  validateFiniteNumberInRange(top_k, 1, 100, 'Invalid top_k parameter: must be a number between 1 and 100');
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');
  if (language_hint !== undefined && typeof language_hint !== 'string') {
    throw new Error('Invalid language_hint parameter: must be a string when provided');
  }

  const result = await serviceClient.callRelationships(validSymbol, {
    direction,
    topK: top_k,
    bypassCache: bypass_cache,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
    languageHint: typeof language_hint === 'string' ? language_hint : undefined,
  });

  let output = '# 🔁 Call Relationships\n\n';
  output += `**Symbol:** "${result.symbol}"\n`;
  output += `**Direction:** ${result.metadata.direction}\n`;
  output += `**Callers:** ${result.metadata.totalCallers} | **Callees:** ${result.metadata.totalCallees}\n\n`;

  if (direction === 'callers' || direction === 'both') {
    output += '## Callers\n';
    if (result.callers.length === 0) {
      output += '_No callers found._\n\n';
    } else {
      for (const caller of result.callers) {
        const callerLabel = caller.callerSymbol ? ` (in \`${caller.callerSymbol}\`)` : '';
        output += `- \`${caller.file}\`:${caller.line}${callerLabel} — score ${caller.score}\n`;
        output += '```\n';
        output += caller.snippet.length > 400 ? `${caller.snippet.substring(0, 400)}...` : caller.snippet;
        output += '\n```\n';
      }
      output += '\n';
    }
  }

  if (direction === 'callees' || direction === 'both') {
    output += '## Callees\n';
    if (result.callees.length === 0) {
      output += '_No callees found._\n\n';
    } else {
      for (const callee of result.callees) {
        output += `- \`${callee.calleeSymbol}\` at \`${callee.file}\`:${callee.line} — score ${callee.score}\n`;
        output += '```\n';
        output += callee.snippet.length > 400 ? `${callee.snippet.substring(0, 400)}...` : callee.snippet;
        output += '\n```\n';
      }
      output += '\n';
    }
  }

  output += '---\n_Use `symbol_definition` to jump to the symbol declaration or `symbol_references` for non-declaration usages._\n';
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

export const symbolSearchTool = {
  name: 'symbol_search',
  description: `Perform deterministic symbol-first search across the codebase for identifier-style navigation.

Use this tool when you need to:
- Jump to files containing a known function, class, type, or constant name
- Prefer exact/local symbol-aware ranking over broader semantic retrieval
- Narrow navigation with include_paths or exclude_paths`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier-style query such as a function, class, interface, type, or constant name.',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
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
    required: ['symbol'],
  },
};

export const symbolReferencesTool = {
  name: 'symbol_references',
  description: `Find non-declaration usages of a known identifier across the local codebase.

Use this tool when you need to:
- Locate call sites or consumers of a known function, class, or constant
- Exclude declaration hits from identifier-style navigation
- Narrow usage lookup with include_paths or exclude_paths`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier whose usages you want to locate.',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
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
    required: ['symbol'],
  },
};

export const symbolDefinitionTool = {
  name: 'symbol_definition',
  description: `Return the single best deterministic declaration site for a known identifier.

Use this tool when you need to:
- Jump straight to the canonical declaration of a function, class, type, interface, or constant
- Get one definitive answer (file, line, kind, snippet) rather than a ranked list
- Complement symbol_search (ranked) and symbol_references (non-declaration usages)`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier whose declaration site you want to locate.',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional workspace path. Defaults to the current workspace.',
      },
      language_hint: {
        type: 'string',
        description: 'Optional language hint (currently advisory; reserved for future use).',
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
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
    required: ['symbol'],
  },
};

export const callRelationshipsTool = {
  name: 'call_relationships',
  description: `Return deterministic local callers and/or callees of a known function or method symbol.

Use this tool when you need to:
- See which functions invoke a given symbol (callers) and where
- Inspect which identifiers a function invokes inside its own body (callees)
- Complement symbol_definition (single declaration site) and symbol_references (non-declaration usages)

Caller heuristic: lines containing <symbol>( that are not declaration-like; the nearest enclosing declaration is reported as callerSymbol when detectable.
Callee heuristic: locates the symbol's definition and scans the brace-delimited body for identifiers followed by '('. Brace-language only in v1; non-brace bodies (e.g., Python) yield empty callees.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Function or method identifier whose call relationships you want to inspect.',
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees', 'both'],
        description: 'Which side of the call graph to compute. Defaults to both.',
        default: 'both',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional workspace path. Defaults to the current workspace.',
      },
      top_k: {
        type: 'number',
        description: 'Maximum entries per side (1-100). Defaults to 20.',
        default: 20,
      },
      language_hint: {
        type: 'string',
        description: 'Optional language hint (currently advisory; reserved for future use).',
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
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
    required: ['symbol'],
  },
};
