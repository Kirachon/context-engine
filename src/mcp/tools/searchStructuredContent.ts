/**
 * Structured content builders and text formatters for search tools.
 */

import type { RankingDiagnostics } from '../../internal/handlers/types.js';
import { featureEnabled } from '../../config/features.js';
import type { ContextServiceClient } from '../serviceClient.js';
import type { SymbolNavigationDiagnostics } from '../serviceClient.js';
import type {
  CallRelationshipsStructuredContent,
  ResultTraceEnvelope,
  SemanticSearchStructuredContent,
  SymbolDefinitionStructuredContent,
  SymbolRankedResultItem,
  SymbolRankedResultsStructuredContent,
} from './searchTypes.js';

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

type ResultTraceStage = ResultTraceEnvelope['source_stage'];

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

export function getFallbackDiagnostics(serviceClient: ContextServiceClient): FallbackDiagnostics | null {
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

function buildSymbolNavigationFooter(diagnostics: SymbolNavigationDiagnostics | null, guidance: string): string {
  return [
    ...(diagnostics
      ? [
          `**Resolution Backend:** ${diagnostics.backend}`,
          `**Graph Status:** ${diagnostics.graph_status}`,
          `**Graph Degraded Reason:** ${diagnostics.graph_degraded_reason ?? 'none'}`,
          `**Fallback Reason:** ${diagnostics.fallback_reason ?? 'none'}`,
          '',
        ]
      : []),
    guidance,
  ].join('\n');
}

export function buildSymbolRankedResultsStructuredContent(params: {
  symbol: string;
  top_k: number;
  results: SymbolRankedResultItem[];
  freshnessWarning: string | null;
  diagnostics: SymbolNavigationDiagnostics | null;
}): SymbolRankedResultsStructuredContent {
  return {
    schema_version: 1,
    symbol: params.symbol,
    top_k: params.top_k,
    results: params.results,
    freshness_warning: params.freshnessWarning,
    diagnostics: params.diagnostics,
  };
}

export function formatSymbolSearchText(content: SymbolRankedResultsStructuredContent): string {
  return formatSimpleSearchResults({
    heading: '# 🔎 Symbol Search Results',
    subjectLabel: 'Symbol',
    subjectValue: content.symbol,
    results: content.results,
    statusWarning: content.freshness_warning ?? undefined,
    emptyHint: [
      'using the fully qualified identifier or class/function name',
      'scoping the search with include_paths',
      'checking if the workspace index is fresh',
    ],
    footer: buildSymbolNavigationFooter(
      content.diagnostics,
      '_Use `get_file` to inspect a matching file or `semantic_search` when you need broader concept-level exploration._'
    ),
  });
}

export function formatSymbolReferencesText(content: SymbolRankedResultsStructuredContent): string {
  return formatSimpleSearchResults({
    heading: '# 🔗 Symbol Reference Results',
    subjectLabel: 'Symbol',
    subjectValue: content.symbol,
    results: content.results,
    statusWarning: content.freshness_warning ?? undefined,
    emptyHint: [
      'using the exact identifier spelling',
      'scoping the search with include_paths to likely consumers',
      'trying symbol_search first to confirm the declaration name',
    ],
    footer: buildSymbolNavigationFooter(
      content.diagnostics,
      '_Use `symbol_search` to jump to declarations or `get_file` to inspect a matching usage in full._'
    ),
  });
}

export function buildSymbolDefinitionStructuredContent(params: {
  symbol: string;
  result: {
    found: boolean;
    symbol?: string;
    file?: string;
    line?: number;
    column?: number;
    kind?: string;
    snippet?: string;
    score?: number;
    metadata?: SymbolNavigationDiagnostics | null;
  };
  diagnostics: SymbolNavigationDiagnostics | null;
}): SymbolDefinitionStructuredContent {
  if (!params.result.found) {
    return {
      schema_version: 1,
      symbol: params.symbol,
      found: false,
      diagnostics: params.diagnostics,
    };
  }

  return {
    schema_version: 1,
    symbol: params.result.symbol ?? params.symbol,
    found: true,
    file: params.result.file,
    line: params.result.line,
    column: params.result.column ?? null,
    kind: params.result.kind,
    score: params.result.score,
    snippet: params.result.snippet,
    diagnostics: params.result.metadata ?? params.diagnostics,
  };
}

export function formatSymbolDefinitionText(content: SymbolDefinitionStructuredContent): string {
  if (!content.found) {
    let output = '# 📍 Symbol Definition\n\n';
    output += `**Symbol:** "${content.symbol}"\n\n`;
    if (content.diagnostics) {
      output += `**Resolution Backend:** ${content.diagnostics.backend}\n`;
      output += `**Graph Status:** ${content.diagnostics.graph_status}\n`;
      output += `**Graph Degraded Reason:** ${content.diagnostics.graph_degraded_reason ?? 'none'}\n`;
      output += `**Fallback Reason:** ${content.diagnostics.fallback_reason ?? 'none'}\n\n`;
    }
    output += '_No definition found. Try:\n';
    output += '- using the exact identifier spelling\n';
    output += '- scoping the search with include_paths to likely declaration sites\n';
    output += '- running `symbol_search` to confirm the canonical declaration name\n';
    output += '_\n';
    return output;
  }

  let output = '# 📍 Symbol Definition\n\n';
  const navigationDiagnostics = content.diagnostics;
  output += `**Symbol:** "${content.symbol}"\n`;
  output += `**File:** \`${content.file}\`\n`;
  output += `**Line:** ${content.line}`;
  if (content.column !== undefined && content.column !== null) {
    output += `, **Column:** ${content.column}`;
  }
  output += `\n**Kind:** ${content.kind}\n`;
  output += `**Score:** ${content.score}\n\n`;
  if (navigationDiagnostics) {
    output += `**Resolution Backend:** ${navigationDiagnostics.backend}\n`;
    output += `**Graph Status:** ${navigationDiagnostics.graph_status}\n`;
    output += `**Graph Degraded Reason:** ${navigationDiagnostics.graph_degraded_reason ?? 'none'}\n`;
    output += `**Fallback Reason:** ${navigationDiagnostics.fallback_reason ?? 'none'}\n\n`;
  }
  output += '```\n';
  const snippet = content.snippet ?? '';
  output += snippet.length > 600 ? `${snippet.substring(0, 600)}...` : snippet;
  output += '\n```\n\n';
  output += '---\n_Use `symbol_references` to find call sites or `get_file` to read the full file._\n';
  return output;
}

export function buildCallRelationshipsStructuredContent(params: {
  result: {
    symbol: string;
    callers: CallRelationshipsStructuredContent['callers'];
    callees: CallRelationshipsStructuredContent['callees'];
    metadata: Record<string, unknown> & { direction: 'callers' | 'callees' | 'both' };
  };
}): CallRelationshipsStructuredContent {
  return {
    schema_version: 1,
    symbol: params.result.symbol,
    direction: params.result.metadata.direction,
    callers: params.result.callers,
    callees: params.result.callees,
    metadata: params.result.metadata,
  };
}

export function formatCallRelationshipsText(content: CallRelationshipsStructuredContent): string {
  const metadata = content.metadata as {
    direction: string;
    totalCallers: number;
    totalCallees: number;
    resolutionBackend?: string;
    graphStatus?: string;
    graphDegradedReason?: string | null;
    fallbackReason?: string | null;
  };

  let output = '# 🔁 Call Relationships\n\n';
  output += `**Symbol:** "${content.symbol}"\n`;
  output += `**Direction:** ${metadata.direction}\n`;
  output += `**Callers:** ${metadata.totalCallers} | **Callees:** ${metadata.totalCallees}\n\n`;
  if (metadata.resolutionBackend) {
    output += `**Resolution Backend:** ${metadata.resolutionBackend}\n`;
    output += `**Graph Status:** ${metadata.graphStatus ?? 'unavailable'}\n`;
    output += `**Graph Degraded Reason:** ${metadata.graphDegradedReason ?? 'none'}\n`;
    output += `**Fallback Reason:** ${metadata.fallbackReason ?? 'none'}\n\n`;
  }

  if (content.direction === 'callers' || content.direction === 'both') {
    output += '## Callers\n';
    if (content.callers.length === 0) {
      output += '_No callers found._\n\n';
    } else {
      for (const caller of content.callers) {
        const callerLabel = caller.callerSymbol ? ` (in \`${caller.callerSymbol}\`)` : '';
        output += `- \`${caller.file}\`:${caller.line}${callerLabel} — score ${caller.score}\n`;
        output += '```\n';
        output += caller.snippet.length > 400 ? `${caller.snippet.substring(0, 400)}...` : caller.snippet;
        output += '\n```\n';
      }
      output += '\n';
    }
  }

  if (content.direction === 'callees' || content.direction === 'both') {
    output += '## Callees\n';
    if (content.callees.length === 0) {
      output += '_No callees found._\n\n';
    } else {
      for (const callee of content.callees) {
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

export function summarizeRetrievalSignals(
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

export function buildSemanticSearchStructuredContent(params: {
  query: string;
  results: Array<{
    path: string;
    content: string;
    lines?: string;
    relevanceScore?: number;
    matchType?: string;
    retrievedAt?: string;
    retrievalSource?: string;
    queryVariant?: string;
    variantIndex?: number;
  }>;
  signalSummary: RetrievalSignalSummary;
  freshnessWarning: string | null;
  fallbackDiagnostics: FallbackDiagnostics | null;
  rankingDiagnostics: RankingDiagnostics | null;
}): SemanticSearchStructuredContent {
  const fileGroups = new Map<string, typeof params.results>();
  for (const result of params.results) {
    if (!fileGroups.has(result.path)) {
      fileGroups.set(result.path, []);
    }
    fileGroups.get(result.path)!.push(result);
  }

  const structuredFileGroups = Array.from(fileGroups.entries()).map(([filePath, fileResults]) => {
    const topRelevance = Math.max(...fileResults.map((result) => result.relevanceScore || 0));
    return {
      path: filePath,
      top_relevance: topRelevance,
      relevance_indicator: formatRelevance(topRelevance),
      snippets: fileResults.map((result) => ({
        ...(result.lines ? { lines: result.lines } : {}),
        ...(result.relevanceScore !== undefined ? { relevance_score: result.relevanceScore } : {}),
        trace: buildResultTraceEnvelope(result as unknown as ResultTraceCandidate),
        content: result.content,
        preview: result.content.length > 300 ? `${result.content.substring(0, 300)}...` : result.content,
      })),
    };
  });

  const auditRows = Array.from(fileGroups.entries())
    .map(([filePath, fileResults]) => {
      const best = fileResults.reduce((acc, cur) => {
        const currentScore = cur.relevanceScore ?? 0;
        return currentScore > (acc.relevanceScore ?? 0) ? cur : acc;
      }, fileResults[0]);

      return {
        file_path: filePath,
        score: best.relevanceScore,
        match_type: best.matchType ?? (best as unknown as { retrievalSource?: string }).retrievalSource ?? 'semantic',
        retrieved_at: best.retrievedAt,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  const fallbackDiagnostics =
    (params.fallbackDiagnostics?.filtersApplied?.length ?? 0) > 0
      ? {
          filters_applied: params.fallbackDiagnostics!.filtersApplied ?? [],
          filtered_paths_count: params.fallbackDiagnostics?.filteredPathsCount ?? 0,
          second_pass_used: params.fallbackDiagnostics?.secondPassUsed ?? false,
        }
      : null;

  return {
    schema_version: 1,
    query: params.query,
    result_count: params.results.length,
    empty: params.results.length === 0,
    signal_summary: {
      query_mode: params.signalSummary.queryMode,
      hybrid_components: params.signalSummary.hybridComponents,
      quality_guard_state: params.signalSummary.qualityGuardState,
      fallback_state: params.signalSummary.fallbackState,
    },
    freshness_warning: params.freshnessWarning,
    fallback_diagnostics: fallbackDiagnostics,
    ranking_diagnostics: params.rankingDiagnostics,
    file_groups: structuredFileGroups,
    audit_rows: auditRows,
  };
}

export function formatSemanticSearchText(content: SemanticSearchStructuredContent): string {
  if (content.empty) {
    let output = `# 🔍 Search Results\n\n`;
    output += `**Query:** "${content.query}"\n\n`;
    if (content.freshness_warning) {
      output += `${content.freshness_warning}\n\n`;
    }
    output += `_No results found. Try:\n`;
    output += `- Using different keywords\n`;
    output += `- Being more general or more specific\n`;
    output += `- Checking if the codebase is indexed_\n`;
    return output;
  }

  let output = `# 🔍 Search Results\n\n`;
  output += `**Query:** "${content.query}"\n`;
  output += `**Found:** ${content.result_count} matching snippets\n\n`;
  output += `**Query Mode:** ${content.signal_summary.query_mode}\n`;
  output += `**Hybrid Components:** ${content.signal_summary.hybrid_components.join(', ')}\n`;
  output += `**Quality Guard:** ${content.signal_summary.quality_guard_state}\n`;
  output += `**Fallback State:** ${content.signal_summary.fallback_state}\n\n`;
  if (content.freshness_warning) {
    output += `${content.freshness_warning}\n\n`;
  }
  if (content.fallback_diagnostics) {
    output += `**Fallback Diagnostics:** filters_applied=${content.fallback_diagnostics.filters_applied.join(', ')}; `;
    output += `filtered_paths_count=${content.fallback_diagnostics.filtered_paths_count}; `;
    output += `second_pass_used=${content.fallback_diagnostics.second_pass_used ? 'true' : 'false'}\n\n`;
  }
  if (content.ranking_diagnostics) {
    output += `**Ranking Diagnostics:** ${formatRankingDiagnostics(content.ranking_diagnostics)}\n\n`;
  }

  output += `## Results by File\n\n`;

  let fileIndex = 0;
  for (const fileGroup of content.file_groups) {
    fileIndex += 1;
    output += `### ${fileIndex}. \`${fileGroup.path}\` ${fileGroup.relevance_indicator}\n\n`;

    for (const snippet of fileGroup.snippets) {
      if (snippet.lines) {
        output += `**Lines ${snippet.lines}**`;
      }
      if (snippet.relevance_score) {
        output += ` (${(snippet.relevance_score * 100).toFixed(0)}% match)`;
      }
      output += `\n\n`;
      output += `Trace: ${formatResultTrace({
        retrievalSource: snippet.trace.source_stage,
        matchType: snippet.trace.match_type,
        queryVariant: snippet.trace.query_variant,
        variantIndex: snippet.trace.variant_index,
      })}\n\n`;
      output += '```\n';
      output += snippet.preview;
      output += '\n```\n\n';
    }
  }

  if (content.audit_rows.length > 0) {
    output += `## Retrieval Audit\n\n`;
    output += `| File | Score | Type | Retrieved |\n`;
    output += `|------|-------|------|-----------|\n`;
    for (const row of content.audit_rows) {
      const scoreText = row.score !== undefined ? `${(row.score * 100).toFixed(0)}%` : 'n/a';
      const retrieved = row.retrieved_at ?? 'now';
      output += `| \`${row.file_path}\` | ${scoreText} | ${row.match_type} | ${retrieved} |\n`;
    }
    output += `\n`;
  }

  output += `---\n`;
  output += `_Use \`get_context_for_prompt\` for more comprehensive context or \`get_file\` for complete file contents._\n`;

  return output;
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

export const RETRIEVAL_PROFILE_MAP: Record<RetrievalProfile, RetrievalProfileSettings> = {
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

export function resolveSearchProfile(mode: 'fast' | 'deep', profile?: RetrievalProfile): RetrievalProfile {
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