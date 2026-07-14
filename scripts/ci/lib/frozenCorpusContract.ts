/**
 * Shared frozen-corpus/threshold contract validator (Q3a).
 *
 * `config/ci/q3a-frozen-corpus-contract.json` is the single checked-in source
 * of truth pinning the PR, nightly, release, seeded-failure, ambiguity,
 * duplicate, and performance corpora with content hashes and predeclared
 * thresholds. This module is consumed by both the CI contract test suite
 * (`tests/ci/frozenCorpusContract.test.ts`) and the standalone validator
 * script (`scripts/ci/check-frozen-corpus-contract.ts`) so the two surfaces
 * can never silently drift apart.
 *
 * This validator implements contract scaffolding only (Q3a). It never
 * computes retrieval quality, catch rate, ambiguity precision/recall, or
 * performance budgets against a live system — that evaluator is Q3b's scope.
 * It only proves that:
 * - every pinned corpus file's content hash, case count, language set, label
 *   set, and per-case intended lane are exactly what the contract declares;
 * - the contract's own `version` is backed by a matching entry in its
 *   append-only `version_ledger`, so thresholds (or any other lane
 *   metadata) cannot silently change without a new version being frozen.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export class FrozenCorpusContractError extends Error {}

export const CANONICAL_LANES = [
  'pr',
  'nightly',
  'release',
  'seeded_failure',
  'ambiguity',
  'duplicate',
  'performance',
] as const;

export type LaneId = (typeof CANONICAL_LANES)[number];

export interface CorpusCase {
  id: string;
  query: string;
  language: string;
  labels: string[];
  intended_lane: string;
  [key: string]: unknown;
}

export interface CorpusFile {
  schema_version: number;
  corpus_id: string;
  intended_lane: string;
  description: string;
  cases: CorpusCase[];
}

export interface LaneExpected {
  case_count: number;
  languages: string[];
  labels: string[];
}

export interface LaneEntry {
  corpus_path: string;
  intended_lane: string;
  content_sha256: string;
  expected: LaneExpected;
  thresholds: Record<string, number | string>;
}

export interface VersionLedgerEntry {
  version: number;
  fingerprint_sha256: string;
  frozen_at_utc: string;
  note: string;
}

export interface FrozenCorpusContract {
  version: number;
  description: string;
  lanes: Record<string, LaneEntry>;
  version_ledger: VersionLedgerEntry[];
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic canonical JSON serialization: object keys are sorted
 * recursively so semantically identical content always fingerprints
 * identically regardless of authoring key order. Array element order is
 * preserved because it is semantically significant (case ordering).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function readJson<T>(relativeOrAbsolutePath: string): T {
  const resolved = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(process.cwd(), relativeOrAbsolutePath);
  if (!fs.existsSync(resolved)) {
    throw new FrozenCorpusContractError(`File not found: ${relativeOrAbsolutePath}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

export function cloneContract(contract: FrozenCorpusContract): FrozenCorpusContract {
  return JSON.parse(JSON.stringify(contract)) as FrozenCorpusContract;
}

/** Fingerprint of the mutable, version-controlled part of the contract. */
export function computeLanesFingerprint(contract: FrozenCorpusContract): string {
  return sha256Hex(canonicalStringify(contract.lanes));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface LaneValidationDetail {
  lane: LaneId;
  content_sha256_actual: string | null;
  case_count_actual: number | null;
  languages_actual: string[] | null;
  labels_actual: string[] | null;
}

export interface ValidationResult {
  status: 'pass' | 'fail';
  reasons: string[];
  lanes: LaneValidationDetail[];
  lanes_fingerprint_actual: string;
}

/**
 * Reads and validates each lane's pinned corpus file relative to `baseDir`
 * (defaults to `process.cwd()`), then validates the version/threshold
 * immutability ledger. Every violation is collected; nothing throws for
 * ordinary mismatches so callers can report the full violation set at once.
 */
export function validateFrozenCorpusContract(
  contract: FrozenCorpusContract,
  options: { baseDir?: string } = {}
): ValidationResult {
  const baseDir = options.baseDir ?? process.cwd();
  const reasons: string[] = [];
  const lanes: LaneValidationDetail[] = [];

  if (typeof contract.version !== 'number' || !Number.isInteger(contract.version) || contract.version < 1) {
    reasons.push(`contract version must be a positive integer, got: ${JSON.stringify(contract.version)}`);
  }

  const declaredLaneKeys = Object.keys(contract.lanes ?? {}).sort();
  const canonicalLaneKeys = [...CANONICAL_LANES].sort();
  if (JSON.stringify(declaredLaneKeys) !== JSON.stringify(canonicalLaneKeys)) {
    reasons.push(
      `contract must declare exactly the canonical lanes [${canonicalLaneKeys.join(', ')}], got [${declaredLaneKeys.join(', ')}]`
    );
  }

  for (const laneKey of Object.keys(contract.lanes ?? {})) {
    const entry = contract.lanes[laneKey];
    const detail: LaneValidationDetail = {
      lane: laneKey as LaneId,
      content_sha256_actual: null,
      case_count_actual: null,
      languages_actual: null,
      labels_actual: null,
    };
    lanes.push(detail);

    if (!CANONICAL_LANES.includes(laneKey as LaneId)) {
      reasons.push(`lane key is not a canonical lane id: ${laneKey}`);
      continue;
    }

    if (entry.intended_lane !== laneKey) {
      reasons.push(`lane "${laneKey}": intended_lane "${entry.intended_lane}" does not match its own lane key`);
    }

    const resolvedCorpusPath = path.join(baseDir, entry.corpus_path);
    if (!fs.existsSync(resolvedCorpusPath)) {
      reasons.push(`lane "${laneKey}": corpus file not found: ${entry.corpus_path}`);
      continue;
    }

    const rawText = fs.readFileSync(resolvedCorpusPath, 'utf8');
    const actualHash = sha256Hex(rawText);
    detail.content_sha256_actual = actualHash;
    if (actualHash !== entry.content_sha256) {
      reasons.push(
        `lane "${laneKey}": corpus content hash mismatch (pinned=${entry.content_sha256} actual=${actualHash}); bump the contract version if this drift is intentional`
      );
    }

    let corpus: CorpusFile;
    try {
      corpus = JSON.parse(rawText) as CorpusFile;
    } catch (error) {
      reasons.push(`lane "${laneKey}": corpus file is not valid JSON: ${(error as Error).message}`);
      continue;
    }

    if (corpus.intended_lane !== laneKey) {
      reasons.push(
        `lane "${laneKey}": corpus file intended_lane "${corpus.intended_lane}" does not match declared lane`
      );
    }

    const cases = Array.isArray(corpus.cases) ? corpus.cases : [];
    detail.case_count_actual = cases.length;
    if (cases.length !== entry.expected.case_count) {
      reasons.push(
        `lane "${laneKey}": case count mismatch (pinned=${entry.expected.case_count} actual=${cases.length})`
      );
    }

    const actualLanguages = uniqueSorted(cases.map((testCase) => String(testCase.language ?? '')));
    detail.languages_actual = actualLanguages;
    if (JSON.stringify(actualLanguages) !== JSON.stringify(entry.expected.languages)) {
      reasons.push(
        `lane "${laneKey}": languages mismatch (pinned=${JSON.stringify(entry.expected.languages)} actual=${JSON.stringify(actualLanguages)})`
      );
    }

    const actualLabels = uniqueSorted(cases.flatMap((testCase) => (Array.isArray(testCase.labels) ? testCase.labels : [])));
    detail.labels_actual = actualLabels;
    if (JSON.stringify(actualLabels) !== JSON.stringify(entry.expected.labels)) {
      reasons.push(
        `lane "${laneKey}": labels mismatch (pinned=${JSON.stringify(entry.expected.labels)} actual=${JSON.stringify(actualLabels)})`
      );
    }

    for (const testCase of cases) {
      if (testCase.intended_lane !== laneKey) {
        reasons.push(
          `lane "${laneKey}": case "${testCase.id}" has intended_lane "${testCase.intended_lane}" but must be "${laneKey}"`
        );
      }
    }

    const caseIds = cases.map((testCase) => testCase.id);
    const duplicateIds = caseIds.filter((id, index) => caseIds.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      reasons.push(`lane "${laneKey}": duplicate case ids: ${[...new Set(duplicateIds)].join(', ')}`);
    }
  }

  const lanesFingerprint = computeLanesFingerprint(contract);
  const ledger = Array.isArray(contract.version_ledger) ? contract.version_ledger : [];

  const seenVersions = new Set<number>();
  for (const entry of ledger) {
    if (seenVersions.has(entry.version)) {
      reasons.push(`version_ledger has a duplicate entry for version ${entry.version}`);
    }
    seenVersions.add(entry.version);
  }

  const sortedVersions = [...ledger].map((entry) => entry.version).sort((left, right) => left - right);
  for (let expected = 1; expected <= sortedVersions.length; expected += 1) {
    if (sortedVersions[expected - 1] !== expected) {
      reasons.push(
        `version_ledger must be a gap-free, strictly increasing sequence starting at 1; got [${sortedVersions.join(', ')}]`
      );
      break;
    }
  }

  const currentLedgerEntry = ledger.find((entry) => entry.version === contract.version);
  if (!currentLedgerEntry) {
    reasons.push(
      `contract version ${contract.version} has no matching version_ledger entry; freeze a new ledger entry when bumping the version`
    );
  } else if (currentLedgerEntry.fingerprint_sha256 !== lanesFingerprint) {
    reasons.push(
      `lanes content for version ${contract.version} does not match its frozen version_ledger fingerprint ` +
        `(ledger=${currentLedgerEntry.fingerprint_sha256} actual=${lanesFingerprint}); thresholds or corpus metadata ` +
        `changed without a version bump and a new frozen ledger entry`
    );
  }

  return {
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    lanes,
    lanes_fingerprint_actual: lanesFingerprint,
  };
}
