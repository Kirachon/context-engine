import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type MemoryModeThresholdsContract = {
  version: number;
  artifact_inputs: {
    candidate: string;
    rollback: string;
  };
  metrics: Record<string, { comparator: string; threshold: number; required: boolean }>;
  required_receipts: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/memory-mode-thresholds.json', () => {
  it('pins decision-driving memory-mode metrics and required receipts', () => {
    const contract = readJson<MemoryModeThresholdsContract>('config/ci/memory-mode-thresholds.json');

    expect(contract.version).toBe(1);
    expect(contract.artifact_inputs).toEqual({
      candidate: 'artifacts/bench/pr-candidate.json',
      rollback: 'artifacts/bench/pr-rollback.json',
    });
    expect(contract.metrics).toEqual({
      approval_precision_pct: { comparator: 'gte_absolute', threshold: 70, required: true },
      dismiss_rate_pct: { comparator: 'lte_absolute', threshold: 35, required: true },
      edit_rate_pct: { comparator: 'lte_absolute', threshold: 20, required: true },
      contradiction_block_rate_pct: { comparator: 'lte_absolute', threshold: 15, required: true },
      suppression_repeat_violation_rate_pct: { comparator: 'lte_absolute', threshold: 5, required: true },
      draft_memory_token_overhead_pct: { comparator: 'lte_absolute', threshold: 10, required: false },
    });
    expect(contract.required_receipts).toEqual({
      draft_memories_included: 'ContextBundle.metadata.draftMemoriesIncluded',
      draft_memory_candidates: 'ContextBundle.metadata.draftMemoryCandidates',
      promotion_state: 'DraftSuggestionRecord.promotion_result.state',
      promotion_index_status: 'DraftSuggestionRecord.promotion_result.index_status',
    });
  });
});
