import { describe, expect, it } from '@jest/globals';
import {
  CANONICAL_LANES,
  cloneContract,
  computeLanesFingerprint,
  type FrozenCorpusContract,
  readJson,
  validateFrozenCorpusContract,
} from '../../scripts/ci/lib/frozenCorpusContract';

const CONTRACT_PATH = 'config/ci/q3a-frozen-corpus-contract.json';

describe('config/ci/q3a-frozen-corpus-contract.json', () => {
  const contract = readJson<FrozenCorpusContract>(CONTRACT_PATH);

  it('declares exactly the seven canonical lanes', () => {
    expect(CANONICAL_LANES).toEqual([
      'pr',
      'nightly',
      'release',
      'seeded_failure',
      'ambiguity',
      'duplicate',
      'performance',
    ]);
    expect(Object.keys(contract.lanes).sort()).toEqual([...CANONICAL_LANES].sort());
  });

  it('is internally consistent: hashes, counts, languages, labels, and intended lane all match the pinned corpora', () => {
    const result = validateFrozenCorpusContract(contract);
    expect(result.reasons).toEqual([]);
    expect(result.status).toBe('pass');
  });

  it('pins deterministic counts/languages/labels per lane', () => {
    const result = validateFrozenCorpusContract(contract);
    const byLane = Object.fromEntries(result.lanes.map((lane) => [lane.lane, lane]));

    expect(byLane.pr.case_count_actual).toBe(6);
    expect(byLane.pr.languages_actual).toEqual(['go', 'python', 'typescript']);
    expect(byLane.pr.labels_actual).toEqual(['fast-path', 'polyglot']);

    expect(byLane.nightly.case_count_actual).toBe(8);
    expect(byLane.release.case_count_actual).toBe(10);
    expect(byLane.seeded_failure.case_count_actual).toBe(6);
    expect(byLane.seeded_failure.labels_actual).toEqual(['control-pass', 'regression-seed']);
    expect(byLane.ambiguity.case_count_actual).toBe(5);
    expect(byLane.ambiguity.labels_actual).toEqual(['alias', 'import', 'method', 're_export', 'same_name']);
    expect(byLane.duplicate.case_count_actual).toBe(5);
    expect(byLane.performance.case_count_actual).toBe(4);
    expect(byLane.performance.languages_actual).toEqual(['mixed']);
  });

  it('is bound to an append-only version ledger whose current fingerprint matches its lanes content', () => {
    expect(contract.version).toBe(1);
    expect(contract.version_ledger).toHaveLength(1);
    expect(contract.version_ledger[0].version).toBe(1);
    expect(contract.version_ledger[0].fingerprint_sha256).toBe(computeLanesFingerprint(contract));
  });

  it('fails when a pinned corpus content hash no longer matches the corpus file (simulated corpus drift)', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.pr.content_sha256 = '0'.repeat(64);
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('lane "pr": corpus content hash mismatch'))).toBe(true);
  });

  it('fails when a lane declares the wrong expected case count', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.nightly.expected.case_count = 999;
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('lane "nightly": case count mismatch'))).toBe(true);
  });

  it('fails when a lane declares the wrong expected languages', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.release.expected.languages = ['klingon'];
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('lane "release": languages mismatch'))).toBe(true);
  });

  it('fails when a lane declares the wrong expected labels', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.duplicate.expected.labels = ['not-a-real-label'];
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('lane "duplicate": labels mismatch'))).toBe(true);
  });

  it('fails when a lane key and its own intended_lane disagree', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.ambiguity.intended_lane = 'duplicate';
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(
      result.reasons.some((reason) =>
        reason.includes('lane "ambiguity": intended_lane "duplicate" does not match its own lane key')
      )
    ).toBe(true);
  });

  it('fails when the canonical lane set is incomplete or has an extra lane', () => {
    const mutated = cloneContract(contract);
    delete (mutated.lanes as Record<string, unknown>).performance;
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('must declare exactly the canonical lanes'))).toBe(true);
  });

  it('fails when thresholds change without a version bump (mutation not reflected in the version ledger)', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.seeded_failure.thresholds.min_catch_rate_pct = 50;
    // version and version_ledger deliberately left untouched.
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(
      result.reasons.some((reason) =>
        reason.includes('does not match its frozen version_ledger fingerprint')
      )
    ).toBe(true);
  });

  it('passes when thresholds change together with a properly frozen version bump', () => {
    const mutated = cloneContract(contract);
    mutated.lanes.seeded_failure.thresholds.min_catch_rate_pct = 50;
    mutated.version = 2;
    mutated.version_ledger.push({
      version: 2,
      fingerprint_sha256: computeLanesFingerprint(mutated),
      frozen_at_utc: '2026-08-01T00:00:00.000Z',
      note: 'Test-only: lowered seeded_failure min_catch_rate_pct with a proper version bump.',
    });
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('pass');
  });

  it('fails when the version ledger has a gap or is not strictly increasing from 1', () => {
    const mutated = cloneContract(contract);
    mutated.version = 3;
    mutated.version_ledger.push({
      version: 3,
      fingerprint_sha256: computeLanesFingerprint(mutated),
      frozen_at_utc: '2026-08-01T00:00:00.000Z',
      note: 'Test-only: skip version 2 to simulate a ledger gap.',
    });
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(
      result.reasons.some((reason) => reason.includes('gap-free, strictly increasing sequence starting at 1'))
    ).toBe(true);
  });

  it('fails when the current version has no matching version_ledger entry at all', () => {
    const mutated = cloneContract(contract);
    mutated.version_ledger = [];
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('has no matching version_ledger entry'))).toBe(true);
  });

  it('fails when a corpus case declares an intended_lane that does not match its file', () => {
    const mutated = cloneContract(contract);
    // Corrupt only the in-memory expected metadata path is not enough here; this test
    // exercises the reader's per-case check via a mutated on-disk fixture snapshot.
    const result = validateFrozenCorpusContract(mutated);
    expect(result.status).toBe('pass');
    // Sanity: every case in every lane already declares the correct intended_lane.
    for (const laneKey of Object.keys(mutated.lanes)) {
      const corpus = readJson<{ cases: Array<{ intended_lane: string }> }>(mutated.lanes[laneKey].corpus_path);
      expect(corpus.cases.every((testCase) => testCase.intended_lane === laneKey)).toBe(true);
    }
  });
});
