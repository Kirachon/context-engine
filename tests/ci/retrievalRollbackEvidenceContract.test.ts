import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type RetrievalRollbackContract = {
  version: number;
  workload_pack_contract: string;
  required_artifacts: {
    baseline: string;
    candidate: string;
    rollback: string;
  };
  required_sections: string[];
  policy: {
    behavior_changing_retrieval_slices_require_rollback_evidence: boolean;
    same_workload_pack_required_for_baseline_and_candidate: boolean;
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/retrieval-rollback-evidence-contract.json', () => {
  it('defines required rollback evidence for retrieval behavior changes', () => {
    const contract = readJson<RetrievalRollbackContract>('config/ci/retrieval-rollback-evidence-contract.json');

    expect(contract.version).toBe(1);
    expect(contract.workload_pack_contract).toBe('config/ci/benchmark-eval-contract.json');
    expect(contract.required_artifacts).toEqual({
      baseline: 'artifacts/bench/pr-baseline.json',
      candidate: 'artifacts/bench/pr-candidate.json',
      rollback: 'artifacts/bench/pr-rollback.json',
    });
    expect(contract.required_sections).toEqual([
      'change_summary',
      'trigger_conditions',
      'rollback_result',
    ]);
    expect(contract.policy).toEqual({
      behavior_changing_retrieval_slices_require_rollback_evidence: true,
      same_workload_pack_required_for_baseline_and_candidate: true,
    });
    expect(fs.existsSync(path.join(process.cwd(), contract.workload_pack_contract))).toBe(true);
  });
});
