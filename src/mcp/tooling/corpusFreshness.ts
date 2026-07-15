/**
 * R4 — Content/generation-aware corpus freshness.
 *
 * Detects add/delete/content changes independently of timestamps by comparing
 * indexed path+hash generation fingerprints against the current corpus.
 */

import { buildGenerationFingerprint } from '../../internal/discovery/discoveryManifest.js';

export type IndexStaleCause =
  | 'age'
  | 'unindexed'
  | 'generation_changed'
  | 'files_added'
  | 'files_deleted'
  | 'content_changed';

export interface CorpusFreshnessInput {
  lastIndexed: string | null;
  /** True when lastIndexed age alone is considered stale. */
  ageIsStale: boolean;
  /** Fingerprint persisted at last successful index, if any. */
  indexedGenerationFingerprint: string | null;
  /** Path → content hash recorded in index state. */
  indexedFiles: Record<string, { hash: string }>;
  /** Current eligible path → content hash (same hash domain as index state). */
  currentFiles: Record<string, { hash: string }>;
}

export interface CorpusFreshnessAssessment {
  isStale: boolean;
  staleCauses: IndexStaleCause[];
  indexedGenerationFingerprint: string | null;
  currentGenerationFingerprint: string | null;
  filesAdded: number;
  filesDeleted: number;
  filesContentChanged: number;
}

function sortedPathHashEntries(
  files: Record<string, { hash: string }>
): Array<{ path: string; hash: string }> {
  return Object.entries(files)
    .map(([path, entry]) => ({ path, hash: entry.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function computeIndexGenerationFingerprint(
  files: Record<string, { hash: string }>
): string {
  return buildGenerationFingerprint(sortedPathHashEntries(files));
}

/**
 * Assess corpus freshness from indexed vs current path/hash sets.
 * Age-based staleness is OR'd in; generation/content signals force stale
 * even when mtimes and lastIndexed remain fresh.
 */
export function evaluateCorpusFreshness(input: CorpusFreshnessInput): CorpusFreshnessAssessment {
  const causes = new Set<IndexStaleCause>();

  if (!input.lastIndexed) {
    causes.add('unindexed');
  }
  if (input.ageIsStale && input.lastIndexed) {
    causes.add('age');
  }

  const indexedPaths = new Set(Object.keys(input.indexedFiles));
  const currentPaths = new Set(Object.keys(input.currentFiles));

  let filesAdded = 0;
  let filesDeleted = 0;
  let filesContentChanged = 0;

  for (const path of currentPaths) {
    if (!indexedPaths.has(path)) {
      filesAdded += 1;
    }
  }
  for (const path of indexedPaths) {
    if (!currentPaths.has(path)) {
      filesDeleted += 1;
      continue;
    }
    if (input.indexedFiles[path]?.hash !== input.currentFiles[path]?.hash) {
      filesContentChanged += 1;
    }
  }

  if (filesAdded > 0) causes.add('files_added');
  if (filesDeleted > 0) causes.add('files_deleted');
  if (filesContentChanged > 0) causes.add('content_changed');

  const currentGenerationFingerprint =
    Object.keys(input.currentFiles).length > 0 || Object.keys(input.indexedFiles).length > 0
      ? computeIndexGenerationFingerprint(input.currentFiles)
      : null;

  const indexedGenerationFingerprint =
    input.indexedGenerationFingerprint ??
    (Object.keys(input.indexedFiles).length > 0
      ? computeIndexGenerationFingerprint(input.indexedFiles)
      : null);

  if (
    indexedGenerationFingerprint &&
    currentGenerationFingerprint &&
    indexedGenerationFingerprint !== currentGenerationFingerprint
  ) {
    causes.add('generation_changed');
  }

  // Never claim healthy when we have an indexed generation but cannot
  // observe a matching current generation for a non-empty indexed corpus.
  if (
    indexedGenerationFingerprint &&
    Object.keys(input.indexedFiles).length > 0 &&
    !currentGenerationFingerprint
  ) {
    causes.add('generation_changed');
  }

  const staleCauseOrder: IndexStaleCause[] = [
    'unindexed',
    'generation_changed',
    'files_added',
    'files_deleted',
    'content_changed',
    'age',
  ];
  const staleCauses = staleCauseOrder.filter((cause) => causes.has(cause));

  return {
    isStale: staleCauses.length > 0,
    staleCauses,
    indexedGenerationFingerprint,
    currentGenerationFingerprint,
    filesAdded,
    filesDeleted,
    filesContentChanged,
  };
}
