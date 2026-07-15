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

type DeliveryPlan = {
  path: string;
  role: 'active-delivery-plan' | 'execution-ledger' | 'planning-reference';
  lifecycle_state: string;
  completion_state: string;
  immutable: boolean;
  status_banner: string;
};

type GovernanceContract = {
  version: number;
  hierarchy: string[];
  lifecycle_states: string[];
  completion_states: string[];
  documentation_roles: {
    architecture_reference: string;
    active_delivery_plan: string | null;
    execution_ledgers: string[];
    planning_only: string[];
  };
  delivery_plans: DeliveryPlan[];
  ownership_lanes: Record<string, string>;
  change_control: {
    require_paired_tests: boolean;
    require_consuming_gate_reference: boolean;
    pr_blockers_must_be_deterministic: boolean;
    nightly_to_blocker_promotion_requires_contract_update: boolean;
  };
  governed_contracts: GovernedContract[];
};

type GateRecord = {
  id: string;
  kind: string;
  declared_tier: string;
  package_script?: string;
  receipts?: Record<string, unknown>;
  workflow_status: string;
  workflow_mappings: Array<{
    execution: string;
    invocation: string;
  }>;
  external_enforcement: {
    status: string;
    receipt: string | null;
  };
};

type GateTierContract = {
  version: number;
  lifecycle_tiers: string[];
  gates: GateRecord[];
};

type RepositoryFiles = {
  exists: (relativePath: string) => boolean;
  read: (relativePath: string) => string;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

function readUtf8(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function cloneContract(contract: GovernanceContract): GovernanceContract {
  return JSON.parse(JSON.stringify(contract)) as GovernanceContract;
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function validatePlanGovernance(
  contract: GovernanceContract,
  repositoryFiles: RepositoryFiles
): string[] {
  const violations: string[] = [];
  const plansByPath = new Map<string, DeliveryPlan>();

  for (const plan of contract.delivery_plans) {
    if (plansByPath.has(plan.path)) {
      violations.push(`delivery plan is declared more than once: ${plan.path}`);
      continue;
    }
    plansByPath.set(plan.path, plan);

    if (!contract.lifecycle_states.includes(plan.lifecycle_state)) {
      violations.push(`delivery plan has unknown lifecycle state: ${plan.path}`);
    }
    if (!contract.completion_states.includes(plan.completion_state)) {
      violations.push(`delivery plan has unknown completion state: ${plan.path}`);
    }
    if (!repositoryFiles.exists(plan.path)) {
      violations.push(`declared delivery plan does not exist: ${plan.path}`);
      continue;
    }

    const banner = repositoryFiles.read(plan.path).split(/\r?\n/).slice(0, 24).join('\n');
    if (!banner.includes(plan.status_banner)) {
      violations.push(`delivery plan status banner does not match its declaration: ${plan.path}`);
    }

    if (plan.completion_state === 'completed') {
      if (!plan.immutable) {
        violations.push(`completed delivery plan must be immutable: ${plan.path}`);
      }
      if (plan.role !== 'execution-ledger') {
        violations.push(`completed delivery plan must be an execution ledger: ${plan.path}`);
      }
      if (!['reference-only', 'retired'].includes(plan.lifecycle_state)) {
        violations.push(`completed delivery plan must be reference-only or retired: ${plan.path}`);
      }
    }
  }

  const activePlans = contract.delivery_plans.filter(plan => plan.lifecycle_state === 'active');
  const activePlanPath = contract.documentation_roles.active_delivery_plan;

  if (activePlanPath === null) {
    if (activePlans.length !== 0) {
      violations.push(`active_delivery_plan is null but ${activePlans.length} active entries exist`);
    }
  } else {
    const activePlan = plansByPath.get(activePlanPath);
    if (!activePlan) {
      violations.push(`active delivery plan is undeclared: ${activePlanPath}`);
    }
    if (!repositoryFiles.exists(activePlanPath)) {
      violations.push(`active delivery plan does not exist: ${activePlanPath}`);
    }
    if (activePlans.length !== 1) {
      violations.push(`expected exactly one active delivery plan entry; found ${activePlans.length}`);
    }
    if (activePlan && activePlan.lifecycle_state !== 'active') {
      violations.push(`active delivery plan pointer targets a non-active entry: ${activePlanPath}`);
    }
    if (activePlan?.completion_state === 'completed') {
      violations.push(`completed delivery plan cannot be active: ${activePlanPath}`);
    }
    if (activePlan?.immutable) {
      violations.push(`immutable delivery plan cannot be active: ${activePlanPath}`);
    }
    if (activePlan && activePlan.role !== 'active-delivery-plan') {
      violations.push(`active delivery plan has the wrong role: ${activePlanPath}`);
    }
  }

  const declaredLedgers = contract.delivery_plans
    .filter(plan => plan.role === 'execution-ledger')
    .map(plan => plan.path);
  if (
    JSON.stringify(sorted(declaredLedgers)) !==
    JSON.stringify(sorted(contract.documentation_roles.execution_ledgers))
  ) {
    violations.push('documentation_roles.execution_ledgers does not match delivery plan metadata');
  }

  const declaredPlanningOnly = contract.delivery_plans
    .filter(plan => plan.lifecycle_state === 'planning-only')
    .map(plan => plan.path);
  if (
    JSON.stringify(sorted(declaredPlanningOnly)) !==
    JSON.stringify(sorted(contract.documentation_roles.planning_only))
  ) {
    violations.push('documentation_roles.planning_only does not match delivery plan metadata');
  }

  const statusDocuments = [
    contract.documentation_roles.architecture_reference,
    ...contract.delivery_plans.map(plan => plan.path),
  ];
  const activeClaimPattern = /(?:Sole active delivery plan|Active delivery plan):\s*`([^`]+)`/gi;
  for (const documentPath of statusDocuments) {
    if (!repositoryFiles.exists(documentPath)) {
      continue;
    }
    const banner = repositoryFiles.read(documentPath).split(/\r?\n/).slice(0, 24).join('\n');
    for (const match of banner.matchAll(activeClaimPattern)) {
      const claimedPath = match[1];
      if (activePlanPath === null) {
        violations.push(`document claims an active plan while the pointer is null: ${documentPath}`);
      } else if (claimedPath !== activePlanPath) {
        violations.push(`document claims a competing active plan: ${documentPath} -> ${claimedPath}`);
      }
    }
  }

  return violations;
}

describe('config/ci/governance-contract.json', () => {
  const repositoryFiles: RepositoryFiles = {
    exists: relativePath => fs.existsSync(path.join(process.cwd(), relativePath)),
    read: readUtf8,
  };

  it('declares one authoritative active plan and immutable completed ledgers', () => {
    const contract = readJson<GovernanceContract>('config/ci/governance-contract.json');

    expect(contract.version).toBe(2);
    expect(contract.documentation_roles.active_delivery_plan).toBe(
      'context-engine-remediation-plan-2026-07-14.md'
    );
    expect(validatePlanGovernance(contract, repositoryFiles)).toEqual([]);
  });

  it('rejects undeclared, missing, completed, and competing active plans', () => {
    const contract = readJson<GovernanceContract>('config/ci/governance-contract.json');

    const undeclared = cloneContract(contract);
    undeclared.documentation_roles.active_delivery_plan = 'undeclared-plan.md';
    expect(validatePlanGovernance(undeclared, repositoryFiles)).toContain(
      'active delivery plan is undeclared: undeclared-plan.md'
    );

    const missing = cloneContract(contract);
    const missingActive = missing.delivery_plans.find(plan => plan.lifecycle_state === 'active');
    expect(missingActive).toBeDefined();
    missingActive!.path = 'missing-active-plan.md';
    missing.documentation_roles.active_delivery_plan = 'missing-active-plan.md';
    expect(validatePlanGovernance(missing, repositoryFiles)).toContain(
      'active delivery plan does not exist: missing-active-plan.md'
    );

    const completed = cloneContract(contract);
    const currentActive = completed.delivery_plans.find(plan => plan.lifecycle_state === 'active');
    const completedLedger = completed.delivery_plans.find(
      plan => plan.path === 'context-engine-next-tranche-swarm-plan.md'
    );
    expect(currentActive).toBeDefined();
    expect(completedLedger).toBeDefined();
    currentActive!.lifecycle_state = 'reference-only';
    currentActive!.role = 'planning-reference';
    completedLedger!.lifecycle_state = 'active';
    completedLedger!.role = 'active-delivery-plan';
    completed.documentation_roles.active_delivery_plan = completedLedger!.path;
    expect(validatePlanGovernance(completed, repositoryFiles)).toContain(
      'completed delivery plan cannot be active: context-engine-next-tranche-swarm-plan.md'
    );

    const competing = cloneContract(contract);
    const secondActive = competing.delivery_plans.find(
      plan => plan.path === 'context-engine-next-tranche-swarm-plan.md'
    );
    expect(secondActive).toBeDefined();
    secondActive!.lifecycle_state = 'active';
    secondActive!.completion_state = 'in-progress';
    secondActive!.immutable = false;
    secondActive!.role = 'active-delivery-plan';
    expect(validatePlanGovernance(competing, repositoryFiles)).toContain(
      'expected exactly one active delivery plan entry; found 2'
    );
  });

  it('locks hierarchy, ownership, paired tests, and consuming-gate references', () => {
    const contract = readJson<GovernanceContract>('config/ci/governance-contract.json');
    const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
    const gateTierContract = readJson<GateTierContract>('config/ci/gate-tier-contract.json');
    const scripts = packageJson.scripts ?? {};
    const gatesById = new Map(gateTierContract.gates.map(gate => [gate.id, gate]));

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
    expect(contract.completion_states).toEqual(['not-started', 'in-progress', 'completed']);
    expect(contract.change_control).toEqual({
      require_paired_tests: true,
      require_consuming_gate_reference: true,
      pr_blockers_must_be_deterministic: true,
      nightly_to_blocker_promotion_requires_contract_update: true,
    });
    expect(gateTierContract.version).toBe(2);
    expect(gateTierContract.lifecycle_tiers).toEqual(expect.arrayContaining(['calibrated', 'pr_blocker']));

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
        const gateRecord = gatesById.get(gate);
        expect(gateRecord).toBeDefined();
        expect(gateRecord?.package_script).toBe(gate);
        expect(gateTierContract.lifecycle_tiers).toContain(gateRecord?.declared_tier);

        if (gateRecord?.declared_tier === 'pr_blocker') {
          expect(['package_script', 'jest_receipt']).toContain(gateRecord.kind);
          expect(gateRecord.workflow_status).toBe('wired');
          expect(gateRecord.workflow_mappings.length).toBeGreaterThan(0);
          expect(gateRecord.external_enforcement.status).toBe('verified');
          expect(gateRecord.external_enforcement.receipt).toEqual(expect.any(String));
        }
      }
    }
  });
});
