/**
 * Ranking receipts — explain why a context item ranked where it did.
 *
 * Pure projection over existing selectionExplainability / selectionProvenance
 * data. Does not mutate retrieval scores or ordering.
 */

export type RankingSignalName =
  | 'exact_symbol_match'
  | 'file_name_match'
  | 'semantic_similarity'
  | 'graph_relationship'
  | 'git_recency'
  | 'test_relationship'
  | 'entrypoint_relationship';

export type RankingSignal = {
  name: RankingSignalName;
  score: number;
  explanation: string;
};

export type RankingReceipt = {
  itemId: string;
  path: string;
  finalScore: number;
  signals: RankingSignal[];
};

export type SelectionExplainabilityInput = {
  selectedBecause?: string[];
  scoreBreakdown?: {
    baseScore?: number;
    graphScore?: number;
    combinedScore?: number;
    semanticScore?: number;
    lexicalScore?: number;
    denseScore?: number;
    fusedScore?: number;
  };
  graphSignals?: Array<{
    kind?: string;
    value?: string;
    weight?: number;
  }>;
};

export type SelectionProvenanceInput = {
  seedSymbols?: string[];
  neighborPaths?: string[];
  selectionBasis?: string[];
  graphStatus?: string;
};

export type BuildRankingReceiptInput = {
  itemId?: string;
  path: string;
  query?: string;
  relevance?: number;
  selectionExplainability?: SelectionExplainabilityInput;
  selectionProvenance?: SelectionProvenanceInput;
};

const SIGNAL_ORDER: RankingSignalName[] = [
  'exact_symbol_match',
  'file_name_match',
  'semantic_similarity',
  'graph_relationship',
  'git_recency',
  'test_relationship',
  'entrypoint_relationship',
];

const REASON_CLASSIFIERS: Array<{ name: RankingSignalName; pattern: RegExp }> = [
  { name: 'exact_symbol_match', pattern: /\b(exact symbol|symbol match|seed symbol|definition path|graph seed symbol)\b/i },
  { name: 'file_name_match', pattern: /\b(file name|filename|basename|path match|path token)\b/i },
  { name: 'semantic_similarity', pattern: /\b(semantic|dense|fused|lexical match|keyword match|hybrid)\b/i },
  {
    name: 'graph_relationship',
    pattern: /\b(graph|import path|call edge|reference path|containment|neighbor path|graph neighbor)\b/i,
  },
  { name: 'git_recency', pattern: /\b(git|recently edited|recent edit|modified file|working tree)\b/i },
  { name: 'test_relationship', pattern: /\b(test coverage|test file|test relationship|covered by|\.test\.|spec file)\b/i },
  {
    name: 'entrypoint_relationship',
    pattern: /\b(entrypoint|main entry|route handler|called by.*route|\/.+ route)\b/i,
  },
];

const GRAPH_SIGNAL_KIND_LABELS: Record<string, string> = {
  graph_seed_symbol: 'Graph seed symbol',
  graph_definition_path: 'Graph definition path',
  graph_reference_path: 'Graph reference path',
  graph_call_edge: 'Graph call edge',
  graph_import_path: 'Graph import path',
  graph_containment_path: 'Graph containment path',
};

const ENTRYPOINT_PATH_PATTERN =
  /(^|\/)(index|main|app|server)\.(tsx?|jsx?|mjs|cjs)$|\/routes?\//i;
const TEST_PATH_PATTERN = /\/(?:__tests__|tests?)\/|\.(?:test|spec)\./i;

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim();
}

function clampScore(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function classifyReason(reason: string): RankingSignalName | null {
  for (const classifier of REASON_CLASSIFIERS) {
    if (classifier.pattern.test(reason)) {
      return classifier.name;
    }
  }
  return null;
}

function basenameWithoutExtension(pathValue: string): string {
  const normalized = normalizePath(pathValue);
  const base = normalized.split('/').pop() ?? normalized;
  return base.replace(/\.[^.]+$/, '');
}

function queryTokens(query: string | undefined): string[] {
  if (!query) {
    return [];
  }
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );
}

function hasBasenameMatch(pathValue: string, query: string | undefined): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return false;
  }
  const basename = basenameWithoutExtension(pathValue).toLowerCase();
  return tokens.some((token) => basename.includes(token) || token.includes(basename));
}

function isTestPath(pathValue: string): boolean {
  return TEST_PATH_PATTERN.test(normalizePath(pathValue).toLowerCase());
}

function isEntrypointPath(pathValue: string): boolean {
  return ENTRYPOINT_PATH_PATTERN.test(normalizePath(pathValue));
}

function graphSignalExplanation(kind: string | undefined, value: string | undefined): string {
  const label = GRAPH_SIGNAL_KIND_LABELS[kind ?? ''] ?? 'Graph signal';
  return value ? `${label}: ${value}` : label;
}

function mergeSignal(
  signals: Map<RankingSignalName, RankingSignal>,
  name: RankingSignalName,
  score: number,
  explanation: string
): void {
  const normalizedScore = roundScore(clampScore(score) ?? 0);
  if (normalizedScore <= 0 && !explanation.trim()) {
    return;
  }

  const existing = signals.get(name);
  if (!existing) {
    signals.set(name, {
      name,
      score: normalizedScore,
      explanation,
    });
    return;
  }

  const explanations = new Set(
    `${existing.explanation}; ${explanation}`
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  signals.set(name, {
    name,
    score: roundScore(Math.max(existing.score, normalizedScore)),
    explanation: [...explanations].sort((left, right) => left.localeCompare(right)).join('; '),
  });
}

function deriveItemId(pathValue: string, explicitItemId: string | undefined): string {
  if (explicitItemId && explicitItemId.trim().length > 0) {
    return explicitItemId.trim();
  }
  const normalized = normalizePath(pathValue);
  return `rank_${normalized.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item'}`;
}

function scoreForSignalName(
  name: RankingSignalName,
  explainability: SelectionExplainabilityInput | undefined
): number {
  const breakdown = explainability?.scoreBreakdown;
  switch (name) {
    case 'graph_relationship':
      return clampScore(breakdown?.graphScore) ?? 0.01;
    case 'semantic_similarity':
      return clampScore(breakdown?.semanticScore ?? breakdown?.fusedScore ?? breakdown?.denseScore) ?? 0.01;
    case 'file_name_match':
      return clampScore(breakdown?.lexicalScore) ?? 0.01;
    case 'exact_symbol_match':
    case 'git_recency':
    case 'test_relationship':
    case 'entrypoint_relationship':
      return clampScore(breakdown?.baseScore) ?? 0.01;
    default:
      return 0.01;
  }
}

function collectReasonSignals(
  signals: Map<RankingSignalName, RankingSignal>,
  reasons: string[],
  explainability: SelectionExplainabilityInput | undefined
): void {
  for (const reason of reasons) {
    const trimmed = reason.trim();
    if (!trimmed) {
      continue;
    }
    const classified = classifyReason(trimmed);
    if (!classified) {
      continue;
    }
    mergeSignal(signals, classified, scoreForSignalName(classified, explainability), trimmed);
  }
}

function collectScoreBreakdownSignals(
  signals: Map<RankingSignalName, RankingSignal>,
  explainability: SelectionExplainabilityInput | undefined,
  pathValue: string,
  query: string | undefined
): void {
  const breakdown = explainability?.scoreBreakdown;
  if (!breakdown) {
    return;
  }

  const graphScore = clampScore(breakdown.graphScore);
  if (graphScore !== undefined) {
    mergeSignal(signals, 'graph_relationship', graphScore, 'Graph-aware score component');
  }

  const semanticScore = clampScore(breakdown.semanticScore ?? breakdown.fusedScore ?? breakdown.denseScore);
  if (semanticScore !== undefined) {
    mergeSignal(signals, 'semantic_similarity', semanticScore, 'Semantic retrieval score component');
  }

  const lexicalScore = clampScore(breakdown.lexicalScore);
  if (lexicalScore !== undefined) {
    const target = hasBasenameMatch(pathValue, query) ? 'file_name_match' : 'semantic_similarity';
    mergeSignal(
      signals,
      target,
      lexicalScore,
      target === 'file_name_match'
        ? 'Lexical score with file-name alignment'
        : 'Lexical retrieval score component'
    );
  }
}

function collectGraphSignals(
  signals: Map<RankingSignalName, RankingSignal>,
  explainability: SelectionExplainabilityInput | undefined
): void {
  for (const graphSignal of explainability?.graphSignals ?? []) {
    const weight = clampScore(graphSignal.weight) ?? 0;
    mergeSignal(
      signals,
      'graph_relationship',
      weight,
      graphSignalExplanation(graphSignal.kind, graphSignal.value)
    );
  }
}

function collectProvenanceSignals(
  signals: Map<RankingSignalName, RankingSignal>,
  provenance: SelectionProvenanceInput | undefined,
  explainability: SelectionExplainabilityInput | undefined
): void {
  if (!provenance) {
    return;
  }

  collectReasonSignals(signals, provenance.selectionBasis ?? [], explainability);

  for (const symbol of provenance.seedSymbols ?? []) {
    if (!symbol.trim()) {
      continue;
    }
    mergeSignal(
      signals,
      'exact_symbol_match',
      scoreForSignalName('exact_symbol_match', explainability),
      `Seed symbol: ${symbol.trim()}`
    );
  }

  for (const neighborPath of provenance.neighborPaths ?? []) {
    if (!neighborPath.trim()) {
      continue;
    }
    mergeSignal(
      signals,
      'graph_relationship',
      scoreForSignalName('graph_relationship', explainability),
      `Graph neighbor path: ${normalizePath(neighborPath)}`
    );
  }
}

function collectPathHeuristicSignals(
  signals: Map<RankingSignalName, RankingSignal>,
  pathValue: string,
  query: string | undefined,
  explainability: SelectionExplainabilityInput | undefined
): void {
  if (hasBasenameMatch(pathValue, query)) {
    mergeSignal(
      signals,
      'file_name_match',
      scoreForSignalName('file_name_match', explainability),
      `File name aligns with query tokens (${basenameWithoutExtension(pathValue)})`
    );
  }

  if (isTestPath(pathValue)) {
    mergeSignal(
      signals,
      'test_relationship',
      scoreForSignalName('test_relationship', explainability),
      `Test file path: ${normalizePath(pathValue)}`
    );
  }

  if (isEntrypointPath(pathValue)) {
    mergeSignal(
      signals,
      'entrypoint_relationship',
      scoreForSignalName('entrypoint_relationship', explainability),
      `Entrypoint-like path: ${normalizePath(pathValue)}`
    );
  }
}

function resolveFinalScore(input: BuildRankingReceiptInput): number {
  const combined = input.selectionExplainability?.scoreBreakdown?.combinedScore;
  if (typeof combined === 'number' && Number.isFinite(combined)) {
    return roundScore(Math.max(0, Math.min(1, combined)));
  }
  if (typeof input.relevance === 'number' && Number.isFinite(input.relevance)) {
    return roundScore(Math.max(0, Math.min(1, input.relevance)));
  }
  const base = input.selectionExplainability?.scoreBreakdown?.baseScore;
  if (typeof base === 'number' && Number.isFinite(base)) {
    return roundScore(Math.max(0, Math.min(1, base)));
  }
  return 0;
}

function sortSignals(signals: Map<RankingSignalName, RankingSignal>): RankingSignal[] {
  return SIGNAL_ORDER
    .map((name) => signals.get(name))
    .filter((signal): signal is RankingSignal => signal !== undefined);
}

/**
 * Build a deterministic ranking receipt from selection explainability inputs.
 */
export function buildRankingReceipt(input: BuildRankingReceiptInput): RankingReceipt {
  const pathValue = normalizePath(input.path);
  const explainability = input.selectionExplainability;
  const provenance = input.selectionProvenance;

  const signals = new Map<RankingSignalName, RankingSignal>();

  collectReasonSignals(signals, explainability?.selectedBecause ?? [], explainability);
  collectScoreBreakdownSignals(signals, explainability, pathValue, input.query);
  collectGraphSignals(signals, explainability);
  collectProvenanceSignals(signals, provenance, explainability);
  collectPathHeuristicSignals(signals, pathValue, input.query, explainability);

  return {
    itemId: deriveItemId(pathValue, input.itemId),
    path: pathValue,
    finalScore: resolveFinalScore(input),
    signals: sortSignals(signals),
  };
}

/**
 * Build ranking receipts for multiple context files in input order.
 */
export function buildRankingReceiptsForFiles(
  files: BuildRankingReceiptInput[]
): RankingReceipt[] {
  return files.map((file) => buildRankingReceipt(file));
}
