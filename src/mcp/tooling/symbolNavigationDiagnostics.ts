import type { ContextServiceClient, SymbolNavigationDiagnostics } from '../serviceClient.js';

export type { SymbolNavigationDiagnostics };

export function getSymbolNavigationDiagnostics(
  serviceClient: ContextServiceClient
): SymbolNavigationDiagnostics | null {
  return serviceClient.getLastSymbolNavigationDiagnostics?.() ?? null;
}

export function buildSingleSymbolDegradedSummary(diagnostics: SymbolNavigationDiagnostics | null): {
  degraded: boolean;
  degraded_reasons: string[];
} {
  const degradedReasons = [
    diagnostics?.fallback_reason ?? null,
    diagnostics?.graph_degraded_reason ?? null,
  ]
    .filter((value) => value != null && String(value).length > 0)
    .map(String);

  return {
    degraded:
      (diagnostics?.backend ?? 'heuristic_fallback') !== 'graph'
      || degradedReasons.length > 0
      || (diagnostics?.graph_status != null && diagnostics.graph_status !== 'ready'),
    degraded_reasons: [...new Set(degradedReasons)],
  };
}

export function buildMultiSymbolDegradedSummary(diagnostics: Array<SymbolNavigationDiagnostics | null>): {
  degraded: boolean;
  degraded_reasons: string[];
  graph_backed_operations: number;
  heuristic_operations: number;
} {
  const flattened = diagnostics.filter((entry): entry is SymbolNavigationDiagnostics => entry != null);
  const degradedReasons = flattened
    .flatMap((entry) => [entry.fallback_reason, entry.graph_degraded_reason])
    .filter((value) => value != null && String(value).length > 0)
    .map(String);
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
