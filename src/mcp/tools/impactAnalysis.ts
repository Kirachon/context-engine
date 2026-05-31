import {
  buildImpactAnalysisEnrichment,
  type ImpactRisk,
  type RecommendedValidation,
  type RuntimeImpactEntry,
  type TestCandidate,
} from '../../analysis/testDiscovery.js';
import { impactAnalysisOutputSchema } from '../schemas/convertedToolOutputSchemas.js';
import { ContextServiceClient } from '../serviceClient.js';
import type { ContextEngineToolResult } from '../types/toolResult.js';
import { okResult } from '../utils/resultBuilder.js';
import {
  buildMultiSymbolDegradedSummary,
  getSymbolNavigationDiagnostics,
  type SymbolNavigationDiagnostics,
} from '../tooling/symbolNavigationDiagnostics.js';
import {
  validateBoolean,
  validateFiniteNumberInRange,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface ImpactAnalysisArgs {
  symbol: string;
  top_k?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
  workspacePath?: string;
  language_hint?: string;
}

type SearchResult = {
  path: string;
};

type SymbolDefinitionResult =
  | { found: false; symbol: string; metadata?: SymbolNavigationDiagnostics | null }
  | {
      found: true;
      symbol: string;
      file: string;
      line: number;
      kind: string;
      metadata?: SymbolNavigationDiagnostics | null;
    };

type CallRelationshipsResult = {
  callers: Array<{ file: string; line: number; snippet: string; score: number; callerSymbol?: string }>;
  callees: Array<{ file: string; line: number; snippet: string; score: number; calleeSymbol: string }>;
};

export type ImpactAnalysisStructuredContent = {
  symbol: string;
  definition: SymbolDefinitionResult;
  impact_summary: {
    direct_reference_count: number;
    direct_caller_count: number;
    direct_callee_count: number;
    impacted_file_count: number;
    impacted_files: string[];
    risk_level: 'low' | 'medium' | 'high';
    risk_score: number;
    risk_reasons: string[];
  };
  impact_surface: {
    references: SearchResult[];
    callers: CallRelationshipsResult['callers'];
    callees: CallRelationshipsResult['callees'];
  };
  test_candidates: TestCandidate[];
  runtime_impact: RuntimeImpactEntry[];
  risks: ImpactRisk[];
  recommended_validation: RecommendedValidation[];
  metadata: Record<string, unknown> & {
    requested_top_k: number;
    graph_backed_operations: number;
    heuristic_operations: number;
    degraded: boolean;
    degraded_reasons: string[];
    diagnostics: {
      symbol_definition: SymbolNavigationDiagnostics | null;
      symbol_references: SymbolNavigationDiagnostics | null;
      call_relationships: SymbolNavigationDiagnostics | null;
    };
    analysis_scope: 'direct_definition_references_and_call_edges_only';
    transitive: false;
    deterministic: true;
  };
};

function buildImpactFiles(
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

function classifyImpactRisk(params: {
  definitionFound: boolean;
  referenceCount: number;
  callerCount: number;
  calleeCount: number;
  impactedFileCount: number;
}): { level: 'low' | 'medium' | 'high'; reasons: string[]; score: number } {
  const score =
    (params.definitionFound ? 2 : 0)
    + params.referenceCount
    + (params.callerCount * 2)
    + params.calleeCount
    + Math.min(params.impactedFileCount, 10);
  const reasons: string[] = [];

  if (params.callerCount >= 8) {
    reasons.push('many_direct_callers');
  }
  if (params.referenceCount >= 15) {
    reasons.push('many_references');
  }
  if (params.impactedFileCount >= 10) {
    reasons.push('broad_file_surface');
  }
  if (params.calleeCount >= 8) {
    reasons.push('many_direct_callees');
  }

  if (score >= 28) {
    return { level: 'high', reasons, score };
  }
  if (score >= 12) {
    return { level: 'medium', reasons, score };
  }
  return { level: 'low', reasons, score };
}

export function buildImpactAnalysisStructuredContent(params: {
  symbol: string;
  topK: number;
  definition: SymbolDefinitionResult;
  references: SearchResult[];
  relationships: CallRelationshipsResult;
  definitionDiagnostics: SymbolNavigationDiagnostics | null;
  referenceDiagnostics: SymbolNavigationDiagnostics | null;
  relationshipDiagnostics: SymbolNavigationDiagnostics | null;
}): ImpactAnalysisStructuredContent {
  const impactedFiles = buildImpactFiles(
    params.definition,
    params.references,
    params.relationships.callers,
    params.relationships.callees
  );
  const risk = classifyImpactRisk({
    definitionFound: params.definition.found,
    referenceCount: params.references.length,
    callerCount: params.relationships.callers.length,
    calleeCount: params.relationships.callees.length,
    impactedFileCount: impactedFiles.length,
  });
  const degraded = buildMultiSymbolDegradedSummary([
    params.definitionDiagnostics,
    params.referenceDiagnostics,
    params.relationshipDiagnostics,
  ]);
  const enrichment = buildImpactAnalysisEnrichment({
    symbol: params.symbol,
    definition: params.definition,
    references: params.references,
    callers: params.relationships.callers,
    callees: params.relationships.callees,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
    degraded: degraded.degraded,
    degradedReasons: degraded.degraded_reasons,
  });

  return {
    symbol: params.symbol,
    definition: params.definition,
    impact_summary: {
      direct_reference_count: params.references.length,
      direct_caller_count: params.relationships.callers.length,
      direct_callee_count: params.relationships.callees.length,
      impacted_file_count: impactedFiles.length,
      impacted_files: impactedFiles,
      risk_level: risk.level,
      risk_score: risk.score,
      risk_reasons: risk.reasons,
    },
    impact_surface: {
      references: params.references,
      callers: params.relationships.callers,
      callees: params.relationships.callees,
    },
    test_candidates: enrichment.test_candidates,
    runtime_impact: enrichment.runtime_impact,
    risks: enrichment.risks,
    recommended_validation: enrichment.recommended_validation,
    metadata: {
      requested_top_k: params.topK,
      graph_backed_operations: degraded.graph_backed_operations,
      heuristic_operations: degraded.heuristic_operations,
      degraded: degraded.degraded,
      degraded_reasons: degraded.degraded_reasons,
      diagnostics: {
        symbol_definition: params.definitionDiagnostics,
        symbol_references: params.referenceDiagnostics,
        call_relationships: params.relationshipDiagnostics,
      },
      analysis_scope: 'direct_definition_references_and_call_edges_only',
      transitive: false,
      deterministic: true,
    },
  };
}

export function formatImpactAnalysisText(content: ImpactAnalysisStructuredContent): string {
  return JSON.stringify(content, null, 2);
}

export async function handleImpactAnalysis(
  args: ImpactAnalysisArgs,
  serviceClient: ContextServiceClient
): Promise<ContextEngineToolResult<ImpactAnalysisStructuredContent>> {
  const symbol = validateTrimmedNonEmptyString(args.symbol, 'symbol');
  validateFiniteNumberInRange(args.top_k, 1, 100, 'invalid top_k');
  validateBoolean(args.bypass_cache, 'invalid bypass_cache');
  const topK = args.top_k ?? 25;
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

  const structured = buildImpactAnalysisStructuredContent({
    symbol,
    topK,
    definition,
    references,
    relationships,
    definitionDiagnostics,
    referenceDiagnostics,
    relationshipDiagnostics,
  });

  return okResult(formatImpactAnalysisText(structured), structured);
}

export const impactAnalysisTool = {
  name: 'impact_analysis',
  description: `Estimate the direct change surface of a known symbol using graph-backed
definition, reference, and call-edge data.

This v1 analysis is intentionally bounded to direct references and call edges so
degraded-mode behavior stays explicit and deterministic.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier whose direct impact surface you want to estimate.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum references/callers/callees to include per section (1-100). Defaults to 25.',
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
  outputSchema: impactAnalysisOutputSchema,
};
