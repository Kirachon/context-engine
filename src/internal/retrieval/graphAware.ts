import fs from 'fs';
import path from 'path';
import type { ContextServiceClient } from '../../mcp/serviceClient.js';
import {
  GRAPH_ARTIFACT_DIRECTORY_NAME,
  GRAPH_METADATA_FILE_NAME,
  GRAPH_PAYLOAD_FILE_NAME,
  createWorkspacePersistentGraphStore,
  type GraphCallEdgeRecord,
  type GraphContainmentRecord,
  type GraphDegradedReason,
  type GraphImportRecord,
  type GraphPayloadFile,
  type GraphReferenceRecord,
  type GraphStatus,
  type GraphSymbolRecord,
} from '../graph/persistentGraphStore.js';
import type {
  ExpandedQuery,
  InternalSearchResult,
  RetrievalGraphSignal,
  RetrievalSelectionExplainability,
  RetrievalSelectionProvenance,
} from './types.js';

type RetrievalGraphFallbackReason = GraphDegradedReason | 'graph_missing' | 'graph_unavailable';

export interface RetrievalGraphContext {
  graphStatus: GraphStatus | 'unavailable';
  graphDegradedReason: RetrievalGraphFallbackReason | null;
  seedSymbols: GraphSymbolRecord[];
  neighborPaths: string[];
  pathSignals: Map<string, RetrievalGraphSignal[]>;
  graphVariants: ExpandedQuery[];
}

const MAX_SEED_SYMBOLS = 4;
const MAX_NEIGHBOR_PATHS = 12;
const MAX_GRAPH_VARIANTS = 3;
const MAX_GRAPH_SCORE = 0.22;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function resolveWorkspacePath(serviceClient: ContextServiceClient): string | null {
  const maybeClient = serviceClient as unknown as {
    workspacePath?: unknown;
    getWorkspacePath?: () => string;
  };
  if (typeof maybeClient.getWorkspacePath === 'function') {
    return maybeClient.getWorkspacePath();
  }
  if (typeof maybeClient.workspacePath === 'string' && maybeClient.workspacePath.trim().length > 0) {
    return maybeClient.workspacePath;
  }
  return null;
}

function tokenizeIdentifier(input: string): string[] {
  return Array.from(new Set(
    input
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  ));
}

function scoreSymbolMatch(symbol: GraphSymbolRecord, queryTokens: string[], normalizedQuery: string): number {
  const normalizedName = symbol.name.toLowerCase();
  let score = 0;

  if (normalizedName === normalizedQuery) {
    score += 10;
  }
  if (normalizedQuery.length >= 3 && normalizedName.includes(normalizedQuery.replace(/\s+/g, ''))) {
    score += 6;
  }

  for (const token of queryTokens) {
    if (normalizedName === token) {
      score += 5;
      continue;
    }
    if (normalizedName.includes(token) || token.includes(normalizedName)) {
      score += 2;
    }
  }

  return score;
}

function pushSignal(pathSignals: Map<string, RetrievalGraphSignal[]>, targetPath: string, signal: RetrievalGraphSignal): void {
  const normalizedPath = normalizePath(targetPath);
  const current = pathSignals.get(normalizedPath) ?? [];
  if (!current.some((entry) => entry.kind === signal.kind && entry.value === signal.value)) {
    current.push(signal);
    pathSignals.set(normalizedPath, current);
  }
}

function summarizeSignals(signals: RetrievalGraphSignal[]): string[] {
  return signals.map((signal) => {
    switch (signal.kind) {
      case 'graph_seed_symbol':
        return `graph seed symbol: ${signal.value}`;
      case 'graph_definition_path':
        return `graph definition path: ${signal.value}`;
      case 'graph_reference_path':
        return `graph reference path: ${signal.value}`;
      case 'graph_call_edge':
        return `graph call edge: ${signal.value}`;
      case 'graph_import_path':
        return `graph import path: ${signal.value}`;
      case 'graph_containment_path':
        return `graph containment path: ${signal.value}`;
      default:
        return signal.value;
    }
  });
}

function buildVariantCandidates(
  query: string,
  seedSymbols: GraphSymbolRecord[],
  neighborPaths: string[]
): ExpandedQuery[] {
  const normalizedQuery = query.trim().toLowerCase();
  const candidates = new Set<string>();

  for (const symbol of seedSymbols) {
    if (symbol.name.trim().length > 0) {
      candidates.add(symbol.name.trim());
    }
  }

  for (const neighborPath of neighborPaths) {
    const basename = path.basename(neighborPath, path.extname(neighborPath)).trim();
    if (basename.length >= 3) {
      candidates.add(basename);
    }
  }

  return Array.from(candidates)
    .filter((candidate) => candidate.toLowerCase() !== normalizedQuery)
    .slice(0, MAX_GRAPH_VARIANTS)
    .map((candidate, index) => ({
      query: candidate,
      source: 'expanded',
      weight: Math.max(0.45, 0.8 - (index * 0.1)),
      index,
    }));
}

function rankNeighborPaths(pathSignals: Map<string, RetrievalGraphSignal[]>): string[] {
  return Array.from(pathSignals.entries())
    .map(([targetPath, signals]) => ({
      path: targetPath,
      score: signals.reduce((sum, signal) => sum + signal.weight, 0),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_NEIGHBOR_PATHS)
    .map((entry) => entry.path);
}

function addSignalsForSeed(
  payload: GraphPayloadFile,
  seed: GraphSymbolRecord,
  pathSignals: Map<string, RetrievalGraphSignal[]>
): void {
  pushSignal(pathSignals, seed.path, {
    kind: 'graph_seed_symbol',
    value: seed.name,
    weight: 0.1,
  });

  payload.definitions
    .filter((definition) => definition.symbol_id === seed.id)
    .forEach((definition) => {
      pushSignal(pathSignals, definition.path, {
        kind: 'graph_definition_path',
        value: `${seed.name}:${definition.start_line}`,
        weight: 0.05,
      });
    });

  payload.references
    .filter((reference) => reference.symbol_id === seed.id || reference.source_symbol_id === seed.id)
    .forEach((reference: GraphReferenceRecord) => {
      pushSignal(pathSignals, reference.path, {
        kind: 'graph_reference_path',
        value: `${seed.name}:${reference.line}`,
        weight: 0.04,
      });
    });

  payload.call_edges
    .filter((edge: GraphCallEdgeRecord) => edge.source_symbol_id === seed.id || edge.target_symbol_id === seed.id)
    .forEach((edge) => {
      pushSignal(pathSignals, edge.path, {
        kind: 'graph_call_edge',
        value: `${seed.name}->${edge.target_symbol_name}`,
        weight: 0.06,
      });
    });

  payload.imports
    .filter((entry: GraphImportRecord) => entry.imported_name === seed.name || entry.local_name === seed.name)
    .forEach((entry) => {
      pushSignal(pathSignals, entry.path, {
        kind: 'graph_import_path',
        value: entry.imported_name ?? entry.local_name ?? seed.name,
        weight: 0.03,
      });
    });

  const relatedContainments = payload.containments.filter((entry: GraphContainmentRecord) =>
    entry.parent_id === seed.id || entry.child_id === seed.id
  );
  for (const containment of relatedContainments) {
    pushSignal(pathSignals, containment.path, {
      kind: 'graph_containment_path',
      value: seed.name,
      weight: 0.02,
    });
  }
}

export async function buildRetrievalGraphContext(
  query: string,
  serviceClient: ContextServiceClient
): Promise<RetrievalGraphContext> {
  const workspacePath = resolveWorkspacePath(serviceClient);
  if (!workspacePath) {
    return {
      graphStatus: 'unavailable',
      graphDegradedReason: 'graph_unavailable',
      seedSymbols: [],
      neighborPaths: [],
      pathSignals: new Map(),
      graphVariants: [],
    };
  }

  const graphMetadataPath = path.join(workspacePath, GRAPH_METADATA_FILE_NAME);
  const graphPayloadPath = path.join(workspacePath, GRAPH_ARTIFACT_DIRECTORY_NAME, GRAPH_PAYLOAD_FILE_NAME);
  if (!fs.existsSync(graphMetadataPath) || !fs.existsSync(graphPayloadPath)) {
    return {
      graphStatus: 'unavailable',
      graphDegradedReason: 'graph_missing',
      seedSymbols: [],
      neighborPaths: [],
      pathSignals: new Map(),
      graphVariants: [],
    };
  }

  const graphStore = createWorkspacePersistentGraphStore({
    workspacePath,
    indexStatePath: path.join(workspacePath, '.context-engine-index-state.json'),
  });
  const refresh = await graphStore.refresh();
  const payload = graphStore.getGraph();
  if (!payload) {
    return {
      graphStatus: refresh.metadata.graph_status,
      graphDegradedReason: refresh.warning ?? refresh.metadata.degraded_reason ?? 'graph_missing',
      seedSymbols: [],
      neighborPaths: [],
      pathSignals: new Map(),
      graphVariants: [],
    };
  }

  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, '');
  const queryTokens = tokenizeIdentifier(query);
  if (queryTokens.length === 0 && normalizedQuery.length === 0) {
    return {
      graphStatus: refresh.metadata.graph_status,
      graphDegradedReason: refresh.warning ?? refresh.metadata.degraded_reason,
      seedSymbols: [],
      neighborPaths: [],
      pathSignals: new Map(),
      graphVariants: [],
    };
  }

  const seedSymbols = [...payload.symbols]
    .map((symbol) => ({
      symbol,
      score: scoreSymbolMatch(symbol, queryTokens, normalizedQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.path.localeCompare(right.symbol.path) || left.symbol.name.localeCompare(right.symbol.name))
    .slice(0, MAX_SEED_SYMBOLS)
    .map((entry) => entry.symbol);

  const pathSignals = new Map<string, RetrievalGraphSignal[]>();
  for (const seed of seedSymbols) {
    addSignalsForSeed(payload, seed, pathSignals);
  }

  const neighborPaths = rankNeighborPaths(pathSignals);
  const allowedNeighborPaths = new Set(neighborPaths);
  for (const existingPath of Array.from(pathSignals.keys())) {
    if (!allowedNeighborPaths.has(existingPath)) {
      pathSignals.delete(existingPath);
    }
  }

  return {
    graphStatus: refresh.metadata.graph_status,
    graphDegradedReason: refresh.warning ?? refresh.metadata.degraded_reason,
    seedSymbols,
    neighborPaths,
    pathSignals,
    graphVariants: buildVariantCandidates(query, seedSymbols, neighborPaths),
  };
}

export function mergeExpandedQueriesWithGraph(
  expandedQueries: ExpandedQuery[],
  graphContext: RetrievalGraphContext
): ExpandedQuery[] {
  if (graphContext.graphVariants.length === 0) {
    return expandedQueries;
  }

  const seen = new Set(expandedQueries.map((entry) => entry.query.trim().toLowerCase()));
  const merged = [...expandedQueries];
  for (const variant of graphContext.graphVariants) {
    const key = variant.query.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      ...variant,
      index: merged.length,
    });
  }
  return merged;
}

function buildProvenance(
  graphContext: RetrievalGraphContext,
  signals: RetrievalGraphSignal[]
): RetrievalSelectionProvenance {
  return {
    graphStatus: graphContext.graphStatus,
    graphDegradedReason: graphContext.graphDegradedReason,
    seedSymbols: graphContext.seedSymbols.map((symbol) => symbol.name),
    neighborPaths: graphContext.neighborPaths,
    selectionBasis: summarizeSignals(signals),
  };
}

function buildExplainability(
  result: InternalSearchResult,
  graphScore: number,
  signals: RetrievalGraphSignal[]
): RetrievalSelectionExplainability {
  const baseScore = result.relevanceScore ?? result.score ?? 0;
  return {
    selectedBecause: summarizeSignals(signals),
    scoreBreakdown: {
      baseScore,
      graphScore,
      combinedScore: baseScore + graphScore,
      semanticScore: result.semanticScore,
      lexicalScore: result.lexicalScore,
      denseScore: result.denseScore,
      fusedScore: result.fusedScore,
    },
    graphSignals: signals,
  };
}

export function applyGraphAwareRetrievalSignals(
  results: InternalSearchResult[],
  graphContext: RetrievalGraphContext
): InternalSearchResult[] {
  return results.map((result) => {
    const signals = graphContext.pathSignals.get(normalizePath(result.path)) ?? [];
    if (signals.length === 0 && result.provenance && result.explainability) {
      return result;
    }
    const graphScore = Math.min(
      MAX_GRAPH_SCORE,
      signals.reduce((sum, signal) => sum + signal.weight, 0)
    );
    const baseScore = result.relevanceScore ?? result.score ?? 0;
    const nextResult: InternalSearchResult = {
      ...result,
      graphScore,
      relevanceScore: baseScore + graphScore,
      combinedScore: (result.combinedScore ?? baseScore) + graphScore,
      provenance: buildProvenance(graphContext, signals),
      explainability: buildExplainability(result, graphScore, signals),
    };

    if (result.retrievalSource === 'semantic' || result.retrievalSource === 'hybrid' || !result.retrievalSource) {
      nextResult.semanticScore = (result.semanticScore ?? baseScore) + graphScore;
    }
    if (result.retrievalSource === 'lexical') {
      nextResult.lexicalScore = (result.lexicalScore ?? baseScore) + graphScore;
    }
    if (result.retrievalSource === 'dense') {
      nextResult.denseScore = (result.denseScore ?? baseScore) + graphScore;
    }

    return nextResult;
  });
}
