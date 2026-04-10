import { normalizePathScopeInput, scopeApplied } from './pathScope.js';

export type AutoScopeConfidence = 'high' | 'medium' | 'low' | 'none';
export type AutoScopeSource = 'manual' | 'auto' | 'none';

export interface AutoScopeSearchResult {
  path: string;
}

export interface AutoScopeDecision {
  source: AutoScopeSource;
  confidence: AutoScopeConfidence;
  appliedIncludePaths: string[];
  candidateIncludePaths: string[];
}

export interface ResolveAutoScopeDecisionOptions {
  query: string;
  autoScope?: boolean;
  includePaths?: string[];
  excludePaths?: string[];
  search: (query: string) => Promise<AutoScopeSearchResult[]>;
}

export const AUTO_SCOPE_INFERENCE_VERSION = 'v1';
const MAX_AUTO_SCOPE_CANDIDATES = 3;
const MIN_HIGH_CONFIDENCE_HITS = 4;
const MIN_HIGH_CONFIDENCE_SHARE = 0.6;
const MIN_MEDIUM_CONFIDENCE_SHARE = 0.45;

function normalizeSearchPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/u, '');
}

function inferCandidateRoot(filePath: string): string | null {
  const normalized = normalizeSearchPath(filePath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const filename = segments[segments.length - 1];
  const directorySegments = filename.includes('.') ? segments.slice(0, -1) : segments;
  if (directorySegments.length < 2) {
    return null;
  }

  const first = directorySegments[0];
  if ((first === 'src' || first === 'test' || first === 'tests') && directorySegments.length >= 2) {
    return `${directorySegments.slice(0, 2).join('/')}/**`;
  }
  if ((first === 'apps' || first === 'packages') && directorySegments.length >= 2) {
    return `${directorySegments.slice(0, 2).join('/')}/**`;
  }
  return `${directorySegments.slice(0, 2).join('/')}/**`;
}

function isBroadRoot(root: string): boolean {
  return root.split('/').filter(Boolean).length < 2;
}

export async function resolveAutoScopeDecision(
  options: ResolveAutoScopeDecisionOptions
): Promise<AutoScopeDecision> {
  const manualScope = normalizePathScopeInput({
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
  });

  if (scopeApplied(manualScope)) {
    return {
      source: 'manual',
      confidence: 'high',
      appliedIncludePaths: manualScope.includePaths ?? [],
      candidateIncludePaths: manualScope.includePaths ?? [],
    };
  }

  if (options.autoScope === false) {
    return {
      source: 'none',
      confidence: 'none',
      appliedIncludePaths: [],
      candidateIncludePaths: [],
    };
  }

  const searchResults = await options.search(options.query);
  const candidateCounts = new Map<string, number>();
  const candidateOrder: string[] = [];

  for (const result of searchResults) {
    const root = inferCandidateRoot(result.path);
    if (!root) {
      continue;
    }
    if (!candidateCounts.has(root)) {
      candidateOrder.push(root);
      candidateCounts.set(root, 0);
    }
    candidateCounts.set(root, (candidateCounts.get(root) ?? 0) + 1);
  }

  const rankedCandidates = candidateOrder
    .map((root) => ({ root, hits: candidateCounts.get(root) ?? 0 }))
    .sort((left, right) => right.hits - left.hits || left.root.localeCompare(right.root));

  if (rankedCandidates.length === 0) {
    return {
      source: 'none',
      confidence: 'none',
      appliedIncludePaths: [],
      candidateIncludePaths: [],
    };
  }

  const candidateIncludePaths = rankedCandidates
    .slice(0, MAX_AUTO_SCOPE_CANDIDATES)
    .map((candidate) => candidate.root);
  const totalHits = rankedCandidates.reduce((sum, candidate) => sum + candidate.hits, 0);
  const topCandidate = rankedCandidates[0];
  const topShare = totalHits > 0 ? topCandidate.hits / totalHits : 0;

  if (
    !isBroadRoot(topCandidate.root)
    && topCandidate.hits >= MIN_HIGH_CONFIDENCE_HITS
    && topShare >= MIN_HIGH_CONFIDENCE_SHARE
  ) {
    return {
      source: 'auto',
      confidence: 'high',
      appliedIncludePaths: [topCandidate.root],
      candidateIncludePaths,
    };
  }

  return {
    source: 'none',
    confidence: topShare >= MIN_MEDIUM_CONFIDENCE_SHARE ? 'medium' : 'low',
    appliedIncludePaths: [],
    candidateIncludePaths,
  };
}
