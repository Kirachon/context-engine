import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type MemoryModeRollbackContract = {
  version: number;
  feature_flag: string;
  required_artifacts: {
    candidate: string;
    rollback: string;
  };
  required_sections: string[];
  policy: {
    behavior_changing_memory_mode_slices_require_rollback_evidence: boolean;
    feature_flag_default_off_until_canary_ready: boolean;
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/memory-mode-rollback-evidence-contract.json', () => {
  it('defines rollback evidence requirements for memory-mode behavior changes', () => {
    const contract = readJson<MemoryModeRollbackContract>('config/ci/memory-mode-rollback-evidence-contract.json');

    expect(contract.version).toBe(1);
    expect(contract.feature_flag).toBe('CE_MEMORY_SUGGESTIONS_V1');
    expect(contract.required_artifacts).toEqual({
      candidate: 'artifacts/bench/pr-candidate.json',
      rollback: 'artifacts/bench/pr-rollback.json',
    });
    expect(contract.required_sections).toEqual([
      'change_summary',
      'rollback_trigger',
      'rollback_steps',
      'rollback_result',
    ]);
    expect(contract.policy).toEqual({
      behavior_changing_memory_mode_slices_require_rollback_evidence: true,
      feature_flag_default_off_until_canary_ready: true,
    });
  });
});
