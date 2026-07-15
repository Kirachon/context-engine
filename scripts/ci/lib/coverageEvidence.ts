/**
 * Shared coverage evidence envelope helpers (Q2).
 *
 * `config/ci/coverage-threshold-contract.json` is the single checked-in
 * source of truth for coverage thresholds and report paths. This module lets
 * `scripts/ci/generate-coverage-evidence.ts` and
 * `scripts/ci/check-coverage-evidence.ts` share the exact same provenance
 * computation (commit SHA, threshold config hash, LCOV content hash, and
 * measured coverage totals) so a coverage evidence envelope generated in one
 * step of a CI job can be independently re-verified in a later step of the
 * *same* job/run before the report it names is uploaded.
 *
 * `resolveCommitSha` is reused directly from the existing bench-provenance
 * helper rather than re-implemented, so commit-SHA resolution stays
 * consistent with the rest of the CI evidence surface.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { resolveCommitSha } from '../bench-provenance.js';

export class CoverageEvidenceError extends Error {}

export interface CoverageThresholds {
  global: Record<string, number>;
}

export interface CoverageThresholdContract {
  version: number;
  thresholds: CoverageThresholds;
  lcov_path: string;
  summary_path: string;
  evidence_path: string;
  workflow?: {
    file: string;
    job: string;
    generate_step_name: string;
    evidence_step_name: string;
    verify_step_name: string;
    upload_step_name: string;
  };
}

export type CoverageTotals = Record<string, number>;

export interface CoverageEvidence {
  schema_version: number;
  generated_at_utc: string;
  commit_sha: string;
  workflow: string;
  job: string;
  run_id: string;
  config_hash: string;
  thresholds: CoverageThresholds;
  actual: CoverageTotals;
  lcov_path: string;
  lcov_sha256: string;
  summary_path: string;
  gate: { status: 'pass' | 'fail'; reasons: string[] };
}

export interface LiveCoverageState {
  lcovSha256: string;
  actual: CoverageTotals;
}

const DEFAULT_CONTRACT_PATH = 'config/ci/coverage-threshold-contract.json';

function resolvePath(relativeOrAbsolutePath: string): string {
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(process.cwd(), relativeOrAbsolutePath);
}

export function readJson<T>(relativeOrAbsolutePath: string): T {
  return JSON.parse(fs.readFileSync(resolvePath(relativeOrAbsolutePath), 'utf8')) as T;
}

export function readCoverageThresholdContract(
  relativeOrAbsolutePath: string = DEFAULT_CONTRACT_PATH
): CoverageThresholdContract {
  return readJson<CoverageThresholdContract>(relativeOrAbsolutePath);
}

/** Deterministic key-sorted JSON serialization so the config hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeConfigHash(thresholds: CoverageThresholds): string {
  return createHash('sha256').update(canonicalJson(thresholds)).digest('hex');
}

export function computeFileSha256(relativeOrAbsolutePath: string): string {
  const resolved = resolvePath(relativeOrAbsolutePath);
  return createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
}

export function readCoverageSummaryTotals(summaryPath: string): CoverageTotals {
  const resolved = resolvePath(summaryPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
    total?: Record<string, { pct?: number }>;
  };
  if (!parsed.total || typeof parsed.total !== 'object') {
    throw new CoverageEvidenceError(`coverage summary at ${summaryPath} is missing a "total" section`);
  }
  const totals: CoverageTotals = {};
  for (const [metric, value] of Object.entries(parsed.total)) {
    if (value && typeof value.pct === 'number') totals[metric] = value.pct;
  }
  return totals;
}

/**
 * Reads the live coverage report/summary named by the contract. Throws
 * `CoverageEvidenceError` when either file is missing so callers can report
 * a clear "missing LCOV" failure rather than an opaque crash.
 */
export function collectLiveCoverageState(contract: CoverageThresholdContract): LiveCoverageState {
  const lcovAbsolute = resolvePath(contract.lcov_path);
  if (!fs.existsSync(lcovAbsolute)) {
    throw new CoverageEvidenceError(
      `Missing LCOV report at ${contract.lcov_path}. Coverage must be generated in this job before evidence can be built or uploaded.`
    );
  }
  const summaryAbsolute = resolvePath(contract.summary_path);
  if (!fs.existsSync(summaryAbsolute)) {
    throw new CoverageEvidenceError(
      `Missing coverage summary at ${contract.summary_path}. Coverage must be generated with the json-summary reporter in this job before evidence can be built or uploaded.`
    );
  }
  return {
    lcovSha256: computeFileSha256(lcovAbsolute),
    actual: readCoverageSummaryTotals(summaryAbsolute),
  };
}

export function thresholdViolations(thresholds: CoverageThresholds, actual: CoverageTotals): string[] {
  const violations: string[] = [];
  for (const [metric, minimum] of Object.entries(thresholds.global ?? {})) {
    const value = actual[metric];
    if (typeof value !== 'number') {
      violations.push(`coverage summary is missing metric "${metric}" required by the threshold contract`);
      continue;
    }
    if (value < minimum) {
      violations.push(`coverage metric "${metric}" is ${value}% which is below the required ${minimum}%`);
    }
  }
  return violations;
}

export interface BuildEvidenceInput {
  contract: CoverageThresholdContract;
  live: LiveCoverageState;
  commitSha?: string;
  workflow?: string;
  job?: string;
  runId?: string;
  generatedAtUtc?: string;
}

export function buildCoverageEvidence(input: BuildEvidenceInput): CoverageEvidence {
  const { contract, live } = input;
  const reasons = thresholdViolations(contract.thresholds, live.actual);
  return {
    schema_version: 1,
    generated_at_utc: input.generatedAtUtc ?? new Date().toISOString(),
    commit_sha: input.commitSha ?? resolveCommitSha(),
    workflow: input.workflow ?? process.env.GITHUB_WORKFLOW ?? 'local',
    job: input.job ?? process.env.GITHUB_JOB ?? 'local',
    run_id: input.runId ?? process.env.GITHUB_RUN_ID ?? 'local',
    config_hash: computeConfigHash(contract.thresholds),
    thresholds: contract.thresholds,
    actual: live.actual,
    lcov_path: contract.lcov_path,
    lcov_sha256: live.lcovSha256,
    summary_path: contract.summary_path,
    gate: { status: reasons.length ? 'fail' : 'pass', reasons },
  };
}

/**
 * Independently re-verifies a previously generated coverage evidence
 * envelope against the checked-in threshold contract and freshly collected
 * live coverage state. Returns a list of human-readable violations; an empty
 * array means the envelope is truthful and safe to use for upload.
 */
export function validateCoverageEvidence(
  evidence: CoverageEvidence,
  contract: CoverageThresholdContract,
  live: LiveCoverageState,
  expectedCommitSha?: string
): string[] {
  const errors: string[] = [];

  if (!evidence.commit_sha || evidence.commit_sha === 'unknown') {
    errors.push('coverage evidence provenance mismatch: commit_sha is missing or unknown');
  } else if (expectedCommitSha && evidence.commit_sha !== expectedCommitSha) {
    errors.push(
      `coverage evidence provenance mismatch: recorded commit_sha (${evidence.commit_sha}) does not match the current checkout (${expectedCommitSha})`
    );
  }

  const expectedConfigHash = computeConfigHash(contract.thresholds);
  if (evidence.config_hash !== expectedConfigHash) {
    errors.push(
      'coverage evidence provenance mismatch: config_hash does not match the checked-in coverage-threshold-contract.json'
    );
  }
  if (canonicalJson(evidence.thresholds) !== canonicalJson(contract.thresholds)) {
    errors.push('coverage evidence provenance mismatch: recorded thresholds do not match the checked-in contract');
  }
  if (evidence.lcov_path !== contract.lcov_path) {
    errors.push('coverage evidence provenance mismatch: recorded lcov_path does not match the checked-in contract');
  }
  if (evidence.summary_path !== contract.summary_path) {
    errors.push('coverage evidence provenance mismatch: recorded summary_path does not match the checked-in contract');
  }
  if (evidence.lcov_sha256 !== live.lcovSha256) {
    errors.push(
      'coverage evidence provenance mismatch: LCOV report content changed after evidence generation; regenerate coverage evidence in this job before upload'
    );
  }
  if (canonicalJson(evidence.actual) !== canonicalJson(live.actual)) {
    errors.push(
      'coverage evidence provenance mismatch: recorded coverage totals do not match the live coverage summary'
    );
  }

  errors.push(...thresholdViolations(contract.thresholds, live.actual));

  return errors;
}
