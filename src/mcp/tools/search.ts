/**
 * Layer 3: MCP Interface Layer - Search Tool
 *
 * Exposes semantic_search and symbol navigation tools as MCP tools.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalRetrieveCode } from '../../internal/handlers/retrieval.js';
import { internalIndexStatus } from '../../internal/handlers/utilities.js';
import { featureEnabled } from '../../config/features.js';
import type { RankingDiagnostics } from '../../internal/handlers/types.js';
import type { ContextEngineToolResult } from '../types/toolResult.js';
import { okResult } from '../utils/resultBuilder.js';
import { getIndexFreshnessWarning } from '../tooling/indexFreshness.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validateMaxLength,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
  validateOneOf,
} from '../tooling/validation.js';
import {
  getSymbolNavigationDiagnostics,
} from '../tooling/symbolNavigationDiagnostics.js';
import {
  buildCallRelationshipsStructuredContent,
  buildSemanticSearchStructuredContent,
  buildSymbolDefinitionStructuredContent,
  buildSymbolRankedResultsStructuredContent,
  formatCallRelationshipsText,
  formatSemanticSearchText,
  formatSymbolDefinitionText,
  formatSymbolReferencesText,
  formatSymbolSearchText,
  getFallbackDiagnostics,
  resolveSearchProfile,
  RETRIEVAL_PROFILE_MAP,
  summarizeRetrievalSignals,
} from './searchStructuredContent.js';
import type {
  CallRelationshipsArgs,
  SemanticSearchArgs,
  SymbolDefinitionArgs,
  SymbolReferencesArgs,
  SymbolSearchArgs,
  CallRelationshipsStructuredContent,
  SemanticSearchStructuredContent,
  SymbolDefinitionStructuredContent,
  SymbolRankedResultsStructuredContent,
} from './searchTypes.js';

export { semanticSearchOutputSchema } from '../schemas/convertedToolOutputSchemas.js';
export type {
  CallRelationshipsArgs,
  CallRelationshipsStructuredContent,
  SemanticSearchArgs,
  SemanticSearchStructuredContent,
  SymbolDefinitionArgs,
  SymbolDefinitionStructuredContent,
  SymbolNavigationDiagnostics,
  SymbolRankedResultItem,
  SymbolRankedResultsStructuredContent,
  SymbolReferencesArgs,
  SymbolSearchArgs,
} from './searchTypes.js';
export {
  callRelationshipsTool,
  semanticSearchTool,
  symbolDefinitionTool,
  symbolReferencesTool,
  symbolSearchTool,
} from './searchToolDefinitions.js';

export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<SemanticSearchStructuredContent>> {
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

  const structuredContent = buildSemanticSearchStructuredContent({
    query: validQuery,
    results,
    signalSummary,
    freshnessWarning,
    fallbackDiagnostics,
    rankingDiagnostics: retrieval.rankingDiagnostics
      ? (retrieval.rankingDiagnostics as RankingDiagnostics)
      : null,
  });

  return okResult(formatSemanticSearchText(structuredContent), structuredContent);
}

export async function handleSymbolSearch(
  args: SymbolSearchArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<SymbolRankedResultsStructuredContent>> {
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
  const structured = buildSymbolRankedResultsStructuredContent({
    symbol: validSymbol,
    top_k,
    results,
    freshnessWarning,
    diagnostics: getSymbolNavigationDiagnostics(serviceClient),
  });

  return okResult(formatSymbolSearchText(structured), structured);
}

export async function handleSymbolReferencesSearch(
  args: SymbolReferencesArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<SymbolRankedResultsStructuredContent>> {
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
  const structured = buildSymbolRankedResultsStructuredContent({
    symbol: validSymbol,
    top_k,
    results,
    freshnessWarning,
    diagnostics: getSymbolNavigationDiagnostics(serviceClient),
  });

  return okResult(formatSymbolReferencesText(structured), structured);
}

export async function handleSymbolDefinition(
  args: SymbolDefinitionArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<SymbolDefinitionStructuredContent>> {
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
  const structured = buildSymbolDefinitionStructuredContent({
    symbol: validSymbol,
    result,
    diagnostics: result.found ? (result.metadata ?? getSymbolNavigationDiagnostics(serviceClient)) : getSymbolNavigationDiagnostics(serviceClient),
  });

  return okResult(formatSymbolDefinitionText(structured), structured);
}

export async function handleCallRelationships(
  args: CallRelationshipsArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<CallRelationshipsStructuredContent>> {
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
  const structured = buildCallRelationshipsStructuredContent({ result });

  return okResult(formatCallRelationshipsText(structured), structured);
}