import { ContextServiceClient } from '../serviceClient.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface FindCalleesArgs {
  symbol: string;
  top_k?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
  workspacePath?: string;
  language_hint?: string;
}

type SymbolNavigationDiagnostics = {
  backend: string;
  graph_status: string;
  graph_degraded_reason: string | null;
  fallback_reason: string | null;
};

function getSymbolNavigationDiagnostics(serviceClient: ContextServiceClient): SymbolNavigationDiagnostics | null {
  const maybeClient = serviceClient as ContextServiceClient & {
    getLastSymbolNavigationDiagnostics?: () => SymbolNavigationDiagnostics | null | undefined;
  };

  return maybeClient.getLastSymbolNavigationDiagnostics?.() ?? null;
}

function buildDegradedSummary(diagnostics: SymbolNavigationDiagnostics | null): {
  degraded: boolean;
  degraded_reasons: string[];
} {
  const degradedReasons = [
    diagnostics?.fallback_reason ?? null,
    diagnostics?.graph_degraded_reason ?? null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    degraded:
      (diagnostics?.backend ?? 'heuristic_fallback') !== 'graph'
      || degradedReasons.length > 0
      || (diagnostics?.graph_status != null && diagnostics.graph_status !== 'ready'),
    degraded_reasons: [...new Set(degradedReasons)],
  };
}

export async function handleFindCallees(
  args: FindCalleesArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const symbol = validateTrimmedNonEmptyString(args.symbol, 'symbol');
  validateFiniteNumberInRange(args.top_k, 1, 100, 'invalid top_k');
  validateBoolean(args.bypass_cache, 'invalid bypass_cache');
  const topK = args.top_k ?? 20;
  const bypassCache = args.bypass_cache ?? false;
  const includePaths = args.include_paths ? validatePathScopeGlobs(args.include_paths, 'include_paths') : undefined;
  const excludePaths = args.exclude_paths ? validatePathScopeGlobs(args.exclude_paths, 'exclude_paths') : undefined;

  const result = await serviceClient.callRelationships(symbol, {
    direction: 'callees',
    topK,
    bypassCache,
    includePaths,
    excludePaths,
    languageHint: args.language_hint,
  });
  const diagnostics = getSymbolNavigationDiagnostics(serviceClient);
  const degraded = buildDegradedSummary(diagnostics);

  return JSON.stringify({
    symbol,
    callees: result.callees,
    metadata: {
      ...result.metadata,
      requested_top_k: topK,
      graph_backed: diagnostics?.backend === 'graph',
      degraded: degraded.degraded,
      degraded_reasons: degraded.degraded_reasons,
      diagnostics,
      analysis_scope: 'direct_callees_only',
      deterministic: true,
    },
  }, null, 2);
}

export const findCalleesTool = {
  name: 'find_callees',
  description: `Return deterministic callees of a known function or method symbol.

This tool prefers persisted graph call edges and reports explicit degraded-mode
receipts when it had to fall back to heuristic extraction.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Function or method identifier whose outgoing calls you want to inspect.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum callees to return (1-100). Defaults to 20.',
        minimum: 1,
        maximum: 100,
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
      workspacePath: {
        type: 'string',
        description: 'Optional workspace path hint. Present for parity with other navigation tools.',
      },
      language_hint: {
        type: 'string',
        description: 'Optional language hint (currently advisory).',
      },
    },
    required: ['symbol'],
  },
};
