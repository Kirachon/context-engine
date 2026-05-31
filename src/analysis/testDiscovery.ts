const TEST_PATH_PATTERN = /\/(?:__tests__|tests?)\/|\.(?:test|spec)\./i;

export type TestDiscoveryStrategy =
  | 'symbol_reference'
  | 'caller_test_file'
  | 'callee_test_file'
  | 'naming_convention'
  | 'same_folder'
  | 'mirror_tests_folder';

export type TestCandidateConfidence = 'high' | 'medium' | 'low';

export type TestCandidate = {
  path: string;
  strategy: TestDiscoveryStrategy;
  confidence: TestCandidateConfidence;
  reason: string;
  related_source?: string;
};

export type RuntimeImpactRole = 'definition' | 'reference' | 'caller' | 'callee';

export type RuntimeImpactEntry = {
  path: string;
  role: RuntimeImpactRole;
  symbol?: string;
};

export type ImpactRisk = {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
};

export type RecommendedValidation = {
  kind: 'test_command' | 'smoke_check';
  command?: string;
  description: string;
};

type SymbolDefinitionResult =
  | { found: false; symbol: string }
  | {
      found: true;
      symbol: string;
      file: string;
      line: number;
      kind: string;
    };

type ReferenceLike = { path: string };
type CallerLike = { file: string; callerSymbol?: string };
type CalleeLike = { file: string; calleeSymbol: string };

const CONFIDENCE_RANK: Record<TestCandidateConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function normalizeAnalysisPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim();
}

export function isTestPath(pathValue: string): boolean {
  return TEST_PATH_PATTERN.test(normalizeAnalysisPath(pathValue).toLowerCase());
}

function basenameWithoutExtension(pathValue: string): string {
  const normalized = normalizeAnalysisPath(pathValue);
  const base = normalized.split('/').pop() ?? normalized;
  return base.replace(/\.[^.]+$/, '');
}

function directoryOf(pathValue: string): string {
  const normalized = normalizeAnalysisPath(pathValue);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function extensionOf(pathValue: string): string {
  const normalized = normalizeAnalysisPath(pathValue);
  const match = normalized.match(/(\.[^./]+)$/);
  return match?.[1] ?? '.ts';
}

function sourcePathsFromImpactSurface(params: {
  definition: SymbolDefinitionResult;
  references: ReferenceLike[];
  callers: CallerLike[];
  callees: CalleeLike[];
}): string[] {
  const paths = new Set<string>();
  if (params.definition.found) {
    paths.add(params.definition.file);
  }
  for (const reference of params.references) {
    paths.add(reference.path);
  }
  for (const caller of params.callers) {
    paths.add(caller.file);
  }
  for (const callee of params.callees) {
    paths.add(callee.file);
  }
  return [...paths]
    .map(normalizeAnalysisPath)
    .filter((pathValue) => !isTestPath(pathValue))
    .sort((left, right) => left.localeCompare(right));
}

export function deriveNamingConventionCandidates(sourcePath: string): TestCandidate[] {
  const normalized = normalizeAnalysisPath(sourcePath);
  if (isTestPath(normalized)) {
    return [];
  }

  const directory = directoryOf(normalized);
  const basename = basenameWithoutExtension(normalized);
  const extension = extensionOf(normalized);
  const candidates: TestCandidate[] = [];

  const sameFolderPatterns = [
    `${directory}/${basename}.test${extension}`,
    `${directory}/${basename}.spec${extension}`,
    `${directory}/__tests__/${basename}.test${extension}`,
    `${directory}/__tests__/${basename}.spec${extension}`,
  ];

  for (const pathValue of sameFolderPatterns) {
    candidates.push({
      path: pathValue,
      strategy: pathValue.includes('/__tests__/') ? 'same_folder' : 'naming_convention',
      confidence: 'medium',
      reason: `Naming convention sibling for ${normalized}`,
      related_source: normalized,
    });
  }

  if (normalized.startsWith('src/')) {
    const relative = normalized.slice('src/'.length);
    const relativeBasename = basenameWithoutExtension(relative);
    const relativeDirectory = directoryOf(relative);
    const mirrorBase = relativeDirectory.length > 0 ? `${relativeDirectory}/${relativeBasename}` : relativeBasename;
    for (const testsRoot of ['tests', 'test']) {
      candidates.push({
        path: `${testsRoot}/${mirrorBase}.test${extension}`,
        strategy: 'mirror_tests_folder',
        confidence: 'medium',
        reason: `Mirrored ${testsRoot}/ layout for ${normalized}`,
        related_source: normalized,
      });
      candidates.push({
        path: `${testsRoot}/${mirrorBase}.spec${extension}`,
        strategy: 'mirror_tests_folder',
        confidence: 'low',
        reason: `Mirrored ${testsRoot}/ layout for ${normalized}`,
        related_source: normalized,
      });
    }
  }

  return candidates;
}

function upsertCandidate(
  candidates: Map<string, TestCandidate>,
  candidate: TestCandidate
): void {
  const normalizedPath = normalizeAnalysisPath(candidate.path);
  const existing = candidates.get(normalizedPath);
  if (!existing) {
    candidates.set(normalizedPath, { ...candidate, path: normalizedPath });
    return;
  }

  const existingRank = CONFIDENCE_RANK[existing.confidence];
  const incomingRank = CONFIDENCE_RANK[candidate.confidence];
  if (incomingRank > existingRank) {
    candidates.set(normalizedPath, { ...candidate, path: normalizedPath });
    return;
  }

  if (incomingRank === existingRank && candidate.reason.localeCompare(existing.reason) < 0) {
    candidates.set(normalizedPath, { ...candidate, path: normalizedPath });
  }
}

export function discoverTestCandidates(params: {
  symbol: string;
  definition: SymbolDefinitionResult;
  references: ReferenceLike[];
  callers: CallerLike[];
  callees: CalleeLike[];
}): TestCandidate[] {
  const candidates = new Map<string, TestCandidate>();

  for (const reference of params.references) {
    if (!isTestPath(reference.path)) {
      continue;
    }
    upsertCandidate(candidates, {
      path: reference.path,
      strategy: 'symbol_reference',
      confidence: 'high',
      reason: `Symbol ${params.symbol} referenced in test file`,
      related_source: params.definition.found ? params.definition.file : undefined,
    });
  }

  for (const caller of params.callers) {
    if (!isTestPath(caller.file)) {
      continue;
    }
    upsertCandidate(candidates, {
      path: caller.file,
      strategy: 'caller_test_file',
      confidence: 'high',
      reason: caller.callerSymbol
        ? `Caller ${caller.callerSymbol} is defined in test file`
        : `Direct caller site is in test file`,
      related_source: params.definition.found ? params.definition.file : undefined,
    });
  }

  for (const callee of params.callees) {
    if (!isTestPath(callee.file)) {
      continue;
    }
    upsertCandidate(candidates, {
      path: callee.file,
      strategy: 'callee_test_file',
      confidence: 'medium',
      reason: `Callee ${callee.calleeSymbol} resolved inside test file`,
      related_source: params.definition.found ? params.definition.file : undefined,
    });
  }

  for (const sourcePath of sourcePathsFromImpactSurface(params)) {
    for (const candidate of deriveNamingConventionCandidates(sourcePath)) {
      upsertCandidate(candidates, candidate);
    }
  }

  return [...candidates.values()].sort((left, right) => {
    const confidenceDelta = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    return left.path.localeCompare(right.path);
  });
}

export function buildRuntimeImpact(params: {
  definition: SymbolDefinitionResult;
  references: ReferenceLike[];
  callers: CallerLike[];
  callees: CalleeLike[];
}): RuntimeImpactEntry[] {
  const entries = new Map<string, RuntimeImpactEntry>();

  const upsert = (pathValue: string, role: RuntimeImpactRole, symbol?: string) => {
    const normalized = normalizeAnalysisPath(pathValue);
    if (isTestPath(normalized)) {
      return;
    }
    const existing = entries.get(normalized);
    if (existing) {
      return;
    }
    entries.set(normalized, {
      path: normalized,
      role,
      ...(symbol ? { symbol } : {}),
    });
  };

  if (params.definition.found) {
    upsert(params.definition.file, 'definition', params.definition.symbol);
  }

  for (const reference of params.references) {
    upsert(reference.path, 'reference');
  }
  for (const caller of params.callers) {
    upsert(caller.file, 'caller', caller.callerSymbol);
  }
  for (const callee of params.callees) {
    upsert(callee.file, 'callee', callee.calleeSymbol);
  }

  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

const RISK_REASON_MESSAGES: Record<string, string> = {
  many_direct_callers: 'Many direct callers increase regression risk across call sites.',
  many_references: 'Many direct references suggest a widely used symbol.',
  broad_file_surface: 'Changes may touch a broad set of runtime files.',
  many_direct_callees: 'Many direct callees increase downstream behavior risk.',
};

export function buildImpactRisks(params: {
  symbol: string;
  definitionFound: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
  runtimeImpact: RuntimeImpactEntry[];
  testCandidates: TestCandidate[];
  degraded: boolean;
  degradedReasons: string[];
}): ImpactRisk[] {
  const risks: ImpactRisk[] = [];

  if (!params.definitionFound) {
    risks.push({
      code: 'definition_not_found',
      severity: 'medium',
      message: `Could not locate a canonical definition for ${params.symbol}; impact surface may be incomplete.`,
    });
  }

  for (const reason of params.riskReasons) {
    risks.push({
      code: reason,
      severity: params.riskLevel === 'high' ? 'high' : params.riskLevel === 'medium' ? 'medium' : 'low',
      message: RISK_REASON_MESSAGES[reason] ?? `Impact classifier flagged ${reason.replace(/_/g, ' ')}.`,
    });
  }

  if (params.degraded) {
    risks.push({
      code: 'graph_degraded',
      severity: 'medium',
      message: params.degradedReasons.length > 0
        ? `Graph-backed navigation degraded: ${params.degradedReasons.join(', ')}.`
        : 'Graph-backed navigation degraded; impact surface may rely on heuristics.',
    });
  }

  const highConfidenceTests = params.testCandidates.filter((candidate) => candidate.confidence === 'high');
  if (params.runtimeImpact.length > 0 && highConfidenceTests.length === 0) {
    risks.push({
      code: 'test_coverage_gap',
      severity: params.riskLevel === 'high' ? 'high' : 'medium',
      message: 'No graph-backed test references were found for the impacted runtime surface.',
    });
  }

  const sharedCalleeFiles = new Set(
    params.runtimeImpact
      .filter((entry) => entry.role === 'callee')
      .map((entry) => entry.path)
  );
  const callerOverlap = params.runtimeImpact.filter(
    (entry) => entry.role === 'caller' && sharedCalleeFiles.has(entry.path)
  );
  if (callerOverlap.length > 0) {
    risks.push({
      code: 'shared_runtime_module',
      severity: 'medium',
      message: 'Callers and callees share runtime modules; edits may affect intertwined behavior.',
    });
  }

  return risks.sort((left, right) => {
    const severityRank = { high: 3, medium: 2, low: 1 };
    const severityDelta = severityRank[right.severity] - severityRank[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.code.localeCompare(right.code);
  });
}

export function buildRecommendedValidation(params: {
  symbol: string;
  testCandidates: TestCandidate[];
  runtimeImpact: RuntimeImpactEntry[];
  riskLevel: 'low' | 'medium' | 'high';
}): RecommendedValidation[] {
  const recommendations: RecommendedValidation[] = [];
  const highConfidencePaths = params.testCandidates
    .filter((candidate) => candidate.confidence === 'high')
    .map((candidate) => candidate.path);
  const mediumConfidencePaths = params.testCandidates
    .filter((candidate) => candidate.confidence === 'medium')
    .map((candidate) => candidate.path);

  if (highConfidencePaths.length > 0) {
    recommendations.push({
      kind: 'test_command',
      command: `npm test -- --runInBand ${highConfidencePaths.join(' ')}`,
      description: 'Run graph-backed test files that reference the symbol.',
    });
  } else if (mediumConfidencePaths.length > 0) {
    recommendations.push({
      kind: 'test_command',
      command: `npm test -- --runInBand ${mediumConfidencePaths.slice(0, 3).join(' ')}`,
      description: 'Run likely test files inferred from naming conventions and impact paths.',
    });
  } else if (params.runtimeImpact.length > 0) {
    const token = basenameWithoutExtension(params.runtimeImpact[0]?.path ?? params.symbol);
    recommendations.push({
      kind: 'test_command',
      command: `npm test -- --runInBand ${token}`,
      description: 'Run targeted tests using the primary runtime module basename.',
    });
  }

  if (params.riskLevel === 'high') {
    recommendations.push({
      kind: 'smoke_check',
      description: `Smoke-check integrations touching ${params.symbol} because impact risk is high.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      kind: 'smoke_check',
      description: `Run the project test suite after editing ${params.symbol}.`,
    });
  }

  return recommendations;
}

export function buildImpactAnalysisEnrichment(params: {
  symbol: string;
  definition: SymbolDefinitionResult;
  references: ReferenceLike[];
  callers: CallerLike[];
  callees: CalleeLike[];
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
  degraded: boolean;
  degradedReasons: string[];
}): {
  test_candidates: TestCandidate[];
  runtime_impact: RuntimeImpactEntry[];
  risks: ImpactRisk[];
  recommended_validation: RecommendedValidation[];
} {
  const testCandidates = discoverTestCandidates(params);
  const runtimeImpact = buildRuntimeImpact(params);
  const risks = buildImpactRisks({
    symbol: params.symbol,
    definitionFound: params.definition.found,
    riskLevel: params.riskLevel,
    riskReasons: params.riskReasons,
    runtimeImpact,
    testCandidates,
    degraded: params.degraded,
    degradedReasons: params.degradedReasons,
  });
  const recommendedValidation = buildRecommendedValidation({
    symbol: params.symbol,
    testCandidates,
    runtimeImpact,
    riskLevel: params.riskLevel,
  });

  return {
    test_candidates: testCandidates,
    runtime_impact: runtimeImpact,
    risks,
    recommended_validation: recommendedValidation,
  };
}
