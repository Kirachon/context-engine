import { ContextServiceClient } from '../serviceClient.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface TraceSymbolArgs {
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

type SearchResult = {
  path: string;
  content: string;
  lines?: string;
  relevanceScore?: number;
  matchType?: string;
  chunkId?: string;
};

type SymbolDefinitionResult =
  | { found: false; symbol: string; metadata?: SymbolNavigationDiagnostics | null }
  | {
      found: true;
      symbol: string;
      file: string;
      line: number;
      column?: number;
      kind: string;
      snippet: string;
      score: number;
      metadata?: SymbolNavigationDiagnostics | null;
    };

type CallRelationshipsResult = {
  callers: Array<{ file: string; line: number; snippet: string; score: number; callerSymbol?: string }>;
  callees: Array<{ file: string; line: number; snippet: string; score: number; calleeSymbol: string }>;
};

function getSymbolNavigationDiagnostics(serviceClient: ContextServiceClient): SymbolNavigationDiagnostics | null {
  const maybeClient = serviceClient as ContextServiceClient & {
    getLastSymbolNavigationDiagnostics?: () => SymbolNavigationDiagnostics | null | undefined;
  };

  return maybeClient.getLastSymbolNavigationDiagnostics?.() ?? null;
}

function buildDegradedSummary(diagnostics: Array<SymbolNavigationDiagnostics | null>): {
  degraded: boolean;
  degraded_reasons: string[];
  graph_backed_operations: number;
  heuristic_operations: number;
} {
  const flattened = diagnostics.filter((entry): entry is SymbolNavigationDiagnostics => entry != null);
  const degradedReasons = flattened.flatMap((entry) => [
    entry.fallback_reason,
    entry.graph_degraded_reason,
  ]).filter((value): value is string => typeof value === 'string' && value.length > 0);
  const graphBackedOperations = flattened.filter((entry) => entry.backend === 'graph').length;
  const heuristicOperations = flattened.length - graphBackedOperations;

  return {
    degraded:
      heuristicOperations > 0
      || degradedReasons.length > 0
      || flattened.some((entry) => entry.graph_status !== 'ready'),
    degraded_reasons: [...new Set(degradedReasons)],
    graph_backed_operations: graphBackedOperations,
    heuristic_operations: heuristicOperations,
  };
}

function buildTouchedFiles(
  definition: SymbolDefinitionResult,
  references: SearchResult[],
  callers: CallRelationshipsResult['callers'],
  callees: CallRelationshipsResult['callees']
): string[] {
  const files = new Set<string>();
  if (definition.found) {
    files.add(definition.file);
  }
  for (const reference of references) {
    files.add(reference.path);
  }
  for (const caller of callers) {
    files.add(caller.file);
  }
  for (const callee of callees) {
    files.add(callee.file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function handleTraceSymbol(
  args: TraceSymbolArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const symbol = validateTrimmedNonEmptyString(args.symbol, 'symbol');
  validateFiniteNumberInRange(args.top_k, 1, 100, 'invalid top_k');
  validateBoolean(args.bypass_cache, 'invalid bypass_cache');
  const topK = args.top_k ?? 20;
  const bypassCache = args.bypass_cache ?? false;
  const includePaths = args.include_paths ? validatePathScopeGlobs(args.include_paths, 'include_paths') : undefined;
  const excludePaths = args.exclude_paths ? validatePathScopeGlobs(args.exclude_paths, 'exclude_paths') : undefined;

  const definition = await serviceClient.symbolDefinition(symbol, {
    bypassCache,
    includePaths,
    excludePaths,
    languageHint: args.language_hint,
  }) as SymbolDefinitionResult;
  const definitionDiagnostics = getSymbolNavigationDiagnostics(serviceClient);

  const references = await serviceClient.symbolReferencesSearch(symbol, topK, {
    bypassCache,
    includePaths,
    excludePaths,
  }) as SearchResult[];
  const referenceDiagnostics = getSymbolNavigationDiagnostics(serviceClient);

  const relationships = await serviceClient.callRelationships(symbol, {
    direction: 'both',
    topK,
    bypassCache,
    includePaths,
    excludePaths,
    languageHint: args.language_hint,
  }) as CallRelationshipsResult;
  const relationshipDiagnostics = getSymbolNavigationDiagnostics(serviceClient);

  const degraded = buildDegradedSummary([
    definitionDiagnostics,
    referenceDiagnostics,
    relationshipDiagnostics,
  ]);
  const touchedFiles = buildTouchedFiles(
    definition,
    references,
    relationships.callers,
    relationships.callees
  );

  return JSON.stringify({
    symbol,
    definition,
    references,
    callers: relationships.callers,
    callees: relationships.callees,
    trace_summary: {
      definition_found: definition.found,
      reference_count: references.length,
      caller_count: relationships.callers.length,
      callee_count: relationships.callees.length,
      touched_files: touchedFiles,
    },
    metadata: {
      requested_top_k: topK,
      graph_backed_operations: degraded.graph_backed_operations,
      heuristic_operations: degraded.heuristic_operations,
      degraded: degraded.degraded,
      degraded_reasons: degraded.degraded_reasons,
      diagnostics: {
        symbol_definition: definitionDiagnostics,
        symbol_references: referenceDiagnostics,
        call_relationships: relationshipDiagnostics,
      },
      analysis_scope: 'direct_definition_references_and_call_edges_only',
      deterministic: true,
    },
  }, null, 2);
}

export const traceSymbolTool = {
  name: 'trace_symbol',
  description: `Trace a known symbol across its canonical definition, non-declaration
references, and direct call edges.

This tool composes the graph-backed symbol navigation surfaces into one
deterministic response and makes degraded-mode behavior explicit per stage.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier to trace across definition, references, callers, and callees.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum references/callers/callees to include per section (1-100). Defaults to 20.',
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
