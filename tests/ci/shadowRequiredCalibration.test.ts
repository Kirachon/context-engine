import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  evaluateCalibration,
  loadQ3cContract,
  type ShadowReceipt,
} from '../../scripts/ci/lib/shadowRequiredCalibration.js';

const REPO_ROOT = process.cwd();

describe('Q3c shadow-required calibration', () => {
  it('loads contract and refuses pr_blocker promotion target', () => {
    const contract = loadQ3cContract(REPO_ROOT);
    expect(contract.task_id).toBe('Q3c');
    expect(contract.promotion_target_tier).toBe('calibrated');
    expect(contract.forbidden_tier).toBe('pr_blocker');
    expect(contract.require_consecutive_receipts).toBe(3);
    expect(contract.require_distinct_commits).toBe(2);
  });

  it('passes with three non-waived receipts across two commits and stable corpus identity', () => {
    const contract = loadQ3cContract(REPO_ROOT);
    const identity = {
      q3a_contract_sha256: 'aaa',
      pr_corpus_sha256: 'bbb',
      fixture_pack_sha256: 'ccc',
    };
    const baseArtifacts = {
      shadow_gate_status: 'pass',
      quality_gate_status: 'pass',
      holdout_status: 'pass',
      shadow_gate_sha256: '1',
      quality_gate_sha256: '2',
      holdout_sha256: '3',
    };
    const receipts: ShadowReceipt[] = [
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:00:00.000Z',
        commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        waived: false,
        corpus_identity: identity,
        gate_artifacts: baseArtifacts,
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:01:00.000Z',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        waived: false,
        corpus_identity: identity,
        gate_artifacts: baseArtifacts,
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:02:00.000Z',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        waived: false,
        corpus_identity: identity,
        gate_artifacts: baseArtifacts,
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
    ];

    const result = evaluateCalibration(receipts, contract);
    expect(result.status).toBe('pass');
    expect(result.promoted_tier).toBe('calibrated');
    expect(result.pr_blocker_claimed).toBe(false);
    expect(result.distinct_commit_count).toBe(2);
    expect(result.corpus_identity_stable).toBe(true);
  });

  it('fails when a gate is not pass or corpus identity drifts', () => {
    const contract = loadQ3cContract(REPO_ROOT);
    const receipts: ShadowReceipt[] = [
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:00:00.000Z',
        commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        waived: false,
        corpus_identity: {
          q3a_contract_sha256: 'aaa',
          pr_corpus_sha256: 'bbb',
          fixture_pack_sha256: 'ccc',
        },
        gate_artifacts: {
          shadow_gate_status: 'fail',
          quality_gate_status: 'pass',
          holdout_status: 'pass',
          shadow_gate_sha256: '1',
          quality_gate_sha256: '2',
          holdout_sha256: '3',
        },
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:01:00.000Z',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        waived: false,
        corpus_identity: {
          q3a_contract_sha256: 'DIFFERENT',
          pr_corpus_sha256: 'bbb',
          fixture_pack_sha256: 'ccc',
        },
        gate_artifacts: {
          shadow_gate_status: 'pass',
          quality_gate_status: 'pass',
          holdout_status: 'pass',
          shadow_gate_sha256: '1',
          quality_gate_sha256: '2',
          holdout_sha256: '3',
        },
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
      {
        schema_version: 1,
        task_id: 'Q3c',
        generated_at_utc: '2026-07-14T12:02:00.000Z',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        waived: false,
        corpus_identity: {
          q3a_contract_sha256: 'aaa',
          pr_corpus_sha256: 'bbb',
          fixture_pack_sha256: 'ccc',
        },
        gate_artifacts: {
          shadow_gate_status: 'pass',
          quality_gate_status: 'pass',
          holdout_status: 'pass',
          shadow_gate_sha256: '1',
          quality_gate_sha256: '2',
          holdout_sha256: '3',
        },
        provenance: { simulation: 'local-dual-commit', note: 'test' },
      },
    ];

    const result = evaluateCalibration(receipts, contract);
    expect(result.status).toBe('fail');
    expect(result.reasons.some((r) => r.includes('shadow gate status=fail'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('corpus/config identity drifted'))).toBe(true);
  });

  it('records a calibration receipt after harness run when present', () => {
    const receiptPath = path.join(REPO_ROOT, 'artifacts/bench/shadow-calibration-receipt.json');
    if (!fs.existsSync(receiptPath)) {
      // Harness is executed during closeout; absence here only means pre-run.
      expect(fs.existsSync(path.join(REPO_ROOT, 'config/ci/q3c-shadow-calibration-contract.json'))).toBe(
        true
      );
      return;
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      evaluation: { status: string; promoted_tier: string | null; pr_blocker_claimed: boolean };
    };
    expect(receipt.evaluation.status).toBe('pass');
    expect(receipt.evaluation.promoted_tier).toBe('calibrated');
    expect(receipt.evaluation.pr_blocker_claimed).toBe(false);
  });
});
