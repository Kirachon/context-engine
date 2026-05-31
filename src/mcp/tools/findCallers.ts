import { findCallersOutputSchema } from '../schemas/convertedToolOutputSchemas.js';
import { ContextServiceClient } from '../serviceClient.js';
import type { ContextEngineToolResult } from '../types/toolResult.js';
import { okResult } from '../utils/resultBuilder.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface FindCallersArgs {
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

export type FindCallersStructuredContent = {
  symbol: string;
  callers: Array<{
    file: string;
    line: number;
    snippet: string;
    score: number;
    callerSymbol?: string;
    column?: number;
  }>;
  metadata: Record<string, unknown> & {
    requested_top_k: number;
    graph_backed: boolean;
    degraded: boolean;
    degraded_reasons: string[];
    diagnostics: SymbolNavigationDiagnostics | null;
    analysis_scope: 'direct_callers_only';
    deterministic: true;
  };
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

export function buildFindCallersStructuredContent(params: {
  symbol: string;
  topK: number;
  callers: FindCallersStructuredContent['callers'];
  resultMetadata: Record<string, unknown>;
  diagnostics: SymbolNavigationDiagnostics | null;
}): FindCallersStructuredContent {
  const degraded = buildDegradedSummary(params.diagnostics);

  return {
    symbol: params.symbol,
    callers: params.callers,
    metadata: {
      ...params.resultMetadata,
      requested_top_k: params.topK,
      graph_backed: params.diagnostics?.backend === 'graph',
      degraded: degraded.degraded,
      degraded_reasons: degraded.degraded_reasons,
      diagnostics: params.diagnostics,
      analysis_scope: 'direct_callers_only',
      deterministic: true,
    },
  };
}

export function formatFindCallersText(content: FindCallersStructuredContent): string {
  return JSON.stringify(content, null, 2);
}

export async function handleFindCallers(
  args: FindCallersArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<FindCallersStructuredContent>> {
  const symbol = validateTrimmedNonEmptyString(args.symbol, 'symbol');
  validateFiniteNumberInRange(args.top_k, 1, 100, 'invalid top_k');
  validateBoolean(args.bypass_cache, 'invalid bypass_cache');
  const topK = args.top_k ?? 20;
  const bypassCache = args.bypass_cache ?? false;
  const includePaths = args.include_paths ? validatePathScopeGlobs(args.include_paths, 'include_paths') : undefined;
  const excludePaths = args.exclude_paths ? validatePathScopeGlobs(args.exclude_paths, 'exclude_paths') : undefined;

  const result = await serviceClient.callRelationships(symbol, {
    direction: 'callers',
    topK,
    bypassCache,
    includePaths,
    excludePaths,
    languageHint: args.language_hint,
  });
  const diagnostics = getSymbolNavigationDiagnostics(serviceClient);
  const structured = buildFindCallersStructuredContent({
    symbol,
    topK,
    callers: result.callers,
    resultMetadata: result.metadata,
    diagnostics,
  });

  return okResult(formatFindCallersText(structured), structured);
}

export const findCallersTool = {
  name: 'find_callers',
  description: `Return deterministic callers of a known function or method symbol.

This tool prefers persisted graph call edges and falls back explicitly when graph
coverage is unavailable or incomplete.

Use when you want call sites for one symbol without the broader combined output
of call_relationships.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Function or method identifier whose callers you want to inspect.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum callers to return (1-100). Defaults to 20.',
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
  outputSchema: findCallersOutputSchema,
};
