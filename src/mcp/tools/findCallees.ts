import { findCalleesOutputSchema } from '../schemas/convertedToolOutputSchemas.js';
import { ContextServiceClient } from '../serviceClient.js';
import type { ContextEngineToolResult } from '../types/toolResult.js';
import { okResult } from '../utils/resultBuilder.js';
import {
  buildSingleSymbolDegradedSummary,
  getSymbolNavigationDiagnostics,
  type SymbolNavigationDiagnostics,
} from '../tooling/symbolNavigationDiagnostics.js';
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

export type FindCalleesStructuredContent = {
  symbol: string;
  callees: Array<{
    file: string;
    line: number;
    snippet: string;
    score: number;
    calleeSymbol: string;
    column?: number;
  }>;
  metadata: Record<string, unknown> & {
    requested_top_k: number;
    graph_backed: boolean;
    degraded: boolean;
    degraded_reasons: string[];
    diagnostics: SymbolNavigationDiagnostics | null;
    analysis_scope: 'direct_callees_only';
    deterministic: true;
  };
};

export function buildFindCalleesStructuredContent(params: {
  symbol: string;
  topK: number;
  callees: FindCalleesStructuredContent['callees'];
  resultMetadata: Record<string, unknown>;
  diagnostics: SymbolNavigationDiagnostics | null;
}): FindCalleesStructuredContent {
  const degraded = buildSingleSymbolDegradedSummary(params.diagnostics);

  return {
    symbol: params.symbol,
    callees: params.callees,
    metadata: {
      ...params.resultMetadata,
      requested_top_k: params.topK,
      graph_backed: params.diagnostics?.backend === 'graph',
      degraded: degraded.degraded,
      degraded_reasons: degraded.degraded_reasons,
      diagnostics: params.diagnostics,
      analysis_scope: 'direct_callees_only',
      deterministic: true,
    },
  };
}

export function formatFindCalleesText(content: FindCalleesStructuredContent): string {
  return JSON.stringify(content, null, 2);
}

export async function handleFindCallees(
  args: FindCalleesArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<FindCalleesStructuredContent>> {
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
  const structured = buildFindCalleesStructuredContent({
    symbol,
    topK,
    callees: result.callees,
    resultMetadata: result.metadata,
    diagnostics,
  });

  return okResult(formatFindCalleesText(structured), structured);
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
  outputSchema: findCalleesOutputSchema,
};
