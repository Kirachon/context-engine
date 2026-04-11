import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type MemoryModeContract = {
  version: number;
  feature_flags: {
    draft_capture: string;
    draft_retrieval: string;
    auto_save: string;
    kill_switch: string;
  };
  rollout: {
    default_phase: string;
    feature_flags_default_off: boolean;
    draft_retrieval_default_off: boolean;
    auto_save_allowed_in_initial_phases: boolean;
    kill_switch_required: boolean;
  };
  source_allowlist: {
    phase_1: string[];
  };
  durable_memory: {
    sole_writer_tool: string;
    second_durable_writer_forbidden: boolean;
    promotion_must_reuse_add_memory_path: boolean;
  };
  draft_isolation: {
    draft_store_path: string;
    isolated_from_memories_path: boolean;
    excluded_from_default_retrieval: boolean;
    excluded_from_indexing: boolean;
    excluded_from_watchers: boolean;
  };
  rollout_gates: Record<string, string[]>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/memory-mode-contract.json', () => {
  it('pins safe-off feature flags, source allowlist, durable writer rules, and draft isolation', () => {
    const contract = readJson<MemoryModeContract>('config/ci/memory-mode-contract.json');

    expect(contract.version).toBe(1);
    expect(contract.feature_flags).toEqual({
      draft_capture: 'memory_suggestions_v1',
      draft_retrieval: 'memory_draft_retrieval_v1',
      auto_save: 'memory_autosave_v1',
      kill_switch: 'rollout_kill_switch',
    });
    expect(contract.rollout).toEqual({
      default_phase: 'phase_1_assisted',
      feature_flags_default_off: true,
      draft_retrieval_default_off: true,
      auto_save_allowed_in_initial_phases: false,
      kill_switch_required: true,
    });
    expect(contract.source_allowlist).toEqual({
      phase_1: ['plan_outputs', 'review_outputs', 'explicit_user_directives'],
    });
    expect(contract.durable_memory).toEqual({
      sole_writer_tool: 'add_memory',
      second_durable_writer_forbidden: true,
      promotion_must_reuse_add_memory_path: true,
    });
    expect(contract.draft_isolation).toEqual({
      draft_store_path: '.context-engine-memory-suggestions/',
      isolated_from_memories_path: true,
      excluded_from_default_retrieval: true,
      excluded_from_indexing: true,
      excluded_from_watchers: true,
    });
    expect(contract.rollout_gates).toEqual({
      contract_gate: [
        'feature_flag_defaults_off',
        'source_allowlist_pinned',
        'durable_writer_rule_pinned',
        'draft_isolation_pinned',
      ],
      safety_gate: ['no_secret_persistence', 'auto_save_disabled', 'kill_switch_available'],
      operational_gate: ['feature_flag_default_off', 'rollback_ready_before_write_behavior'],
    });
  });
});
