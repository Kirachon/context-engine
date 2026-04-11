import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type GovernedContract = {
  path: string;
  owner_lane: string;
  lifecycle_state: string;
  paired_tests: string[];
  consuming_gates: string[];
};

type GovernanceContract = {
  version: number;
  hierarchy: string[];
  lifecycle_states: string[];
  documentation_roles: {
    architecture_reference: string;
    active_delivery_plan: string;
    execution_ledger: string;
    planning_only: string[];
  };
  ownership_lanes: Record<string, string>;
  change_control: {
    require_paired_tests: boolean;
    require_consuming_gate_reference: boolean;
    pr_blockers_must_be_deterministic: boolean;
    nightly_to_blocker_promotion_requires_contract_update: boolean;
  };
  gate_tier_expectations: Record<string, 'pr_blocker'>;
  governed_contracts: GovernedContract[];
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/governance-contract.json', () => {
  it('locks hierarchy, ownership, and paired-test governance for active contracts', () => {
    const contract = readJson<GovernanceContract>('config/ci/governance-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const gateTierContract = readJson<{
      pr_blockers: {
        scripts: string[];
      };
      nightly_report_only: {
        scripts: string[];
      };
    }>('config/ci/gate-tier-contract.json');
    const scripts = packageJson.scripts ?? {};
    const deterministicBlockers = new Set(gateTierContract.pr_blockers.scripts);
    const nightlyOnly = new Set(gateTierContract.nightly_report_only.scripts);

    expect(contract.version).toBe(1);
    expect(contract.hierarchy).toEqual([
      'runtime_code_and_ci_contracts',
      'architecture_reference',
      'active_delivery_plan',
      'execution_ledger',
    ]);
    expect(contract.lifecycle_states).toEqual([
      'active',
      'planning-only',
      'reference-only',
      'retired',
    ]);
    expect(contract.change_control).toEqual({
      require_paired_tests: true,
      require_consuming_gate_reference: true,
      pr_blockers_must_be_deterministic: true,
      nightly_to_blocker_promotion_requires_contract_update: true,
    });
    expect(contract.gate_tier_expectations).toEqual({
      'ci:check:mcp-smoke': 'pr_blocker',
      'ci:check:retrieval-quality-gate': 'pr_blocker',
      'ci:check:retrieval-shadow-canary-gate': 'pr_blocker',
    });

    expect(fs.existsSync(path.join(process.cwd(), contract.documentation_roles.architecture_reference))).toBe(
      true
    );
    expect(fs.existsSync(path.join(process.cwd(), contract.documentation_roles.active_delivery_plan))).toBe(
      true
    );
    expect(fs.existsSync(path.join(process.cwd(), contract.documentation_roles.execution_ledger))).toBe(true);
    for (const planningDoc of contract.documentation_roles.planning_only) {
      expect(fs.existsSync(path.join(process.cwd(), planningDoc))).toBe(true);
    }

    for (const governed of contract.governed_contracts) {
      expect(fs.existsSync(path.join(process.cwd(), governed.path))).toBe(true);
      expect(Object.keys(contract.ownership_lanes)).toContain(governed.owner_lane);
      expect(contract.lifecycle_states).toContain(governed.lifecycle_state);
      expect(governed.paired_tests.length).toBeGreaterThan(0);
      expect(governed.consuming_gates.length).toBeGreaterThan(0);
      for (const testPath of governed.paired_tests) {
        expect(fs.existsSync(path.join(process.cwd(), testPath))).toBe(true);
      }
      for (const gate of governed.consuming_gates) {
        expect(scripts[gate]).toEqual(expect.any(String));
        expect(contract.gate_tier_expectations[gate]).toBe('pr_blocker');
        expect(nightlyOnly.has(gate)).toBe(false);
        expect(deterministicBlockers.has(gate)).toBe(true);
      }
    }
  });
});
