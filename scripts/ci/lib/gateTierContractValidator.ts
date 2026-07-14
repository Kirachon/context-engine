/**
 * Shared gate-tier contract validator (Q1).
 *
 * This module is the single source of truth for validating
 * `config/ci/gate-tier-contract.json` against:
 * - the lifecycle-tier vocabulary and canonical promotion order,
 * - live `.github/workflows/**` YAML and `package.json` script chains,
 * - external branch-protection enforcement receipts.
 *
 * It is consumed by both the CI contract test suite
 * (`tests/ci/gateTierContract.test.ts`) and the standalone validator script
 * (`scripts/ci/check-gate-tier-contract.ts`) so the two surfaces can never
 * silently drift apart.
 *
 * This validator never promotes a gate's truth on its own. It only reports
 * whether the contract's own declarations (tier, workflow wiring, external
 * enforcement) are internally consistent and truthful against live
 * repository state. An uncalibrated or unwired gate is never treated as a
 * blocker by this validator.
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

export type Tier = 'report_only' | 'shadow_required_artifact' | 'calibrated' | 'pr_blocker';
export type EnforcementStatus = 'not-verified' | 'verified';

/** Canonical promotion order. A gate may never claim a tier out of this order. */
export const CANONICAL_LIFECYCLE_TIERS: Tier[] = [
  'report_only',
  'shadow_required_artifact',
  'calibrated',
  'pr_blocker',
];

export type WorkflowExecution = {
  workflow: string;
  job: string;
  step_index: number;
  step_name: string | null;
  entrypoint_script: string;
  events: string[];
  job_condition?: string;
};

export type Gate = {
  id: string;
  kind: 'package_script' | 'jest_receipt' | 'policy_marker';
  declared_tier: Tier;
  package_script?: string;
  entrypoint_scripts?: string[];
  receipts?: { contract?: string; corpus?: string; tests?: string[] };
  workflow_status: 'wired' | 'unwired';
  workflow_mappings: Array<{ execution: string; invocation: 'direct' | 'transitive' }>;
  external_enforcement: { status: EnforcementStatus; receipt: string | null };
};

export type Contract = {
  version: number;
  lifecycle_tiers: Tier[];
  mapping_scope: {
    workflow_globs: string[];
    explicit_npm_entrypoints_only: boolean;
    follow_package_script_chains: boolean;
    npm_lifecycle_side_effects: string;
  };
  external_enforcement_policy: {
    provider: string;
    statuses: EnforcementStatus[];
    verified_receipt_path_prefix: string;
    verified_receipt_schema_version: number;
    pr_blocker_requires_verified_receipt: boolean;
  };
  workflow_executions: Record<string, WorkflowExecution>;
  gates: Gate[];
};

export type Workflow = {
  on?: string | string[] | Record<string, unknown>;
  jobs?: Record<string, { if?: string; steps?: Array<{ name?: string; run?: string }> }>;
};

export type ResolvedExecution = Pick<
  WorkflowExecution,
  'workflow' | 'job' | 'step_index' | 'step_name' | 'entrypoint_script'
> & { invocation: 'direct' | 'transitive' };

export type BranchProtectionReceipt = {
  schema_version: number;
  gate_id: string;
  provider: string;
  repository: string;
  branch: string;
  protected: boolean;
  required_check: string;
  workflow: string;
  job: string;
  captured_at_utc: string;
};

export function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as T;
}

export function cloneContract(contract: Contract): Contract {
  return JSON.parse(JSON.stringify(contract)) as Contract;
}

export function readWorkflows(): Map<string, Workflow> {
  const directory = path.join(process.cwd(), '.github', 'workflows');
  return new Map(
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => {
        const relativePath = `.github/workflows/${name}`;
        return [
          relativePath,
          parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as Workflow,
        ];
      })
  );
}

export function npmEntrypoints(command: string): string[] {
  const names = new Set<string>();
  const pattern = /\bnpm\s+run(?:(?:\s+--?[A-Za-z][\w-]*)*)\s+([A-Za-z0-9][\w:.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) names.add(match[1]);
  if (/\bnpm\s+test\b/.test(command)) names.add('test');
  return [...names];
}

export function reaches(
  scripts: Record<string, string>,
  entrypoint: string,
  target: string,
  visited = new Set<string>()
): boolean {
  if (entrypoint === target) return true;
  if (visited.has(entrypoint) || typeof scripts[entrypoint] !== 'string') return false;
  visited.add(entrypoint);
  return npmEntrypoints(scripts[entrypoint]).some((child) =>
    reaches(scripts, child, target, new Set(visited))
  );
}

function core(execution: WorkflowExecution, invocation: ResolvedExecution['invocation']): ResolvedExecution {
  return {
    workflow: execution.workflow,
    job: execution.job,
    step_index: execution.step_index,
    step_name: execution.step_name,
    entrypoint_script: execution.entrypoint_script,
    invocation,
  };
}

export function sortedExecutions(executions: ResolvedExecution[]): ResolvedExecution[] {
  return [...executions].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function actualExecutions(
  gate: Gate,
  scripts: Record<string, string>,
  workflows: Map<string, Workflow>
): ResolvedExecution[] {
  if (gate.kind === 'policy_marker') return [];
  const found: ResolvedExecution[] = [];

  for (const [workflowPath, workflow] of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const [stepIndex, step] of (job.steps ?? []).entries()) {
        for (const entrypoint of npmEntrypoints(step.run ?? '')) {
          const matches =
            gate.kind === 'package_script'
              ? reaches(scripts, entrypoint, gate.package_script ?? '')
              : (gate.entrypoint_scripts ?? []).includes(entrypoint);
          if (matches) {
            found.push({
              workflow: workflowPath,
              job: jobName,
              step_index: stepIndex,
              step_name: step.name ?? null,
              entrypoint_script: entrypoint,
              invocation:
                gate.kind === 'package_script' && entrypoint !== gate.package_script
                  ? 'transitive'
                  : 'direct',
            });
          }
        }
      }
    }
  }
  return sortedExecutions(found);
}

function validateExternalReceipt(gate: Gate, contract: Contract, errors: string[]): void {
  const receiptPath = gate.external_enforcement.receipt;
  if (!receiptPath) {
    errors.push(`${gate.id}: verified external enforcement requires a receipt path`);
    return;
  }
  if (!receiptPath.startsWith(contract.external_enforcement_policy.verified_receipt_path_prefix)) {
    errors.push(`${gate.id}: external receipt is outside the approved receipt path`);
    return;
  }
  if (!fs.existsSync(path.join(process.cwd(), receiptPath))) {
    errors.push(`${gate.id}: external receipt does not exist`);
    return;
  }

  const receipt = readJson<BranchProtectionReceipt>(receiptPath);
  const mappedJobs = gate.workflow_mappings
    .map(({ execution }) => contract.workflow_executions[execution])
    .filter((value): value is WorkflowExecution => Boolean(value));
  if (
    receipt.schema_version !== contract.external_enforcement_policy.verified_receipt_schema_version ||
    receipt.gate_id !== gate.id ||
    receipt.provider !== contract.external_enforcement_policy.provider ||
    !receipt.repository ||
    !receipt.branch ||
    receipt.protected !== true ||
    !receipt.required_check ||
    !receipt.captured_at_utc ||
    !mappedJobs.some(({ workflow, job }) => workflow === receipt.workflow && job === receipt.job)
  ) {
    errors.push(`${gate.id}: external receipt does not prove the mapped required check`);
  }
}

/**
 * Validates lifecycle-tier truthfulness for one gate:
 * - the declared tier must be one of the contract's own declared tiers;
 * - the declared tier must be a member of, and correctly ranked within,
 *   the canonical `report_only -> shadow_required_artifact -> calibrated ->
 *   pr_blocker` promotion order (an invalid/unknown tier name, or a tier
 *   promoted past what live evidence supports, is a lifecycle-transition
 *   violation, not merely a naming issue);
 * - promotion past `report_only` requires the gate to actually be wired
 *   into a live workflow (a gate cannot be "calibrated" or higher while
 *   `workflow_status` is `unwired`);
 * - promotion to `pr_blocker` additionally requires verified external
 *   branch-protection enforcement.
 */
function validateLifecycleTransition(gate: Gate, contract: Contract, errors: string[]): void {
  if (!contract.lifecycle_tiers.includes(gate.declared_tier)) {
    errors.push(`${gate.id}: unknown declared tier`);
    return;
  }
  if (!CANONICAL_LIFECYCLE_TIERS.includes(gate.declared_tier)) {
    errors.push(`${gate.id}: declared tier is not part of the canonical lifecycle promotion order`);
    return;
  }

  const tierRank = CANONICAL_LIFECYCLE_TIERS.indexOf(gate.declared_tier);
  const reportOnlyRank = CANONICAL_LIFECYCLE_TIERS.indexOf('report_only');

  if (gate.workflow_status === 'unwired' && tierRank > reportOnlyRank) {
    errors.push(
      `${gate.id}: invalid lifecycle transition - an unwired gate cannot be promoted past report_only`
    );
  }
}

export function validateGateTierContract(contract: Contract): string[] {
  const errors: string[] = [];

  if (JSON.stringify(contract.lifecycle_tiers) !== JSON.stringify(CANONICAL_LIFECYCLE_TIERS)) {
    errors.push(
      'lifecycle_tiers must declare exactly the canonical report_only -> shadow_required_artifact -> calibrated -> pr_blocker promotion order'
    );
  }

  const scripts = readJson<{ scripts?: Record<string, string> }>('package.json').scripts ?? {};
  const workflows = readWorkflows();
  const gateIds = new Set<string>();

  for (const [id, execution] of Object.entries(contract.workflow_executions)) {
    const workflow = workflows.get(execution.workflow);
    const job = workflow?.jobs?.[execution.job];
    const step = job?.steps?.[execution.step_index];
    const workflowEvents = new Set(
      typeof workflow?.on === 'string'
        ? [workflow.on]
        : Array.isArray(workflow?.on)
          ? workflow.on
          : Object.keys(workflow?.on ?? {})
    );
    if (!workflow || !job || !step || typeof step.run !== 'string') {
      errors.push(`${id}: workflow/job/step mapping does not exist`);
      continue;
    }
    if (
      (step.name ?? null) !== execution.step_name ||
      !npmEntrypoints(step.run).includes(execution.entrypoint_script) ||
      (job.if ?? null) !== (execution.job_condition ?? null) ||
      execution.events.length === 0 ||
      execution.events.some((event) => !workflowEvents.has(event))
    ) {
      errors.push(`${id}: workflow/job/step mapping is not exact`);
    }
  }

  for (const gate of contract.gates) {
    if (gateIds.has(gate.id)) errors.push(`${gate.id}: duplicate gate id`);
    gateIds.add(gate.id);

    validateLifecycleTransition(gate, contract, errors);

    if (gate.kind === 'package_script' && typeof scripts[gate.package_script ?? ''] !== 'string') {
      errors.push(`${gate.id}: package script does not exist`);
    }
    for (const receiptPath of [
      gate.receipts?.contract,
      gate.receipts?.corpus,
      ...(gate.receipts?.tests ?? []),
    ].filter((value): value is string => Boolean(value))) {
      if (!fs.existsSync(path.join(process.cwd(), receiptPath))) {
        errors.push(`${gate.id}: receipt path does not exist: ${receiptPath}`);
      }
    }

    const declared = gate.workflow_mappings.flatMap(({ execution, invocation }) => {
      const resolved = contract.workflow_executions[execution];
      if (!resolved) {
        errors.push(`${gate.id}: unknown workflow execution: ${execution}`);
        return [];
      }
      if (
        gate.kind === 'package_script' &&
        (!reaches(scripts, resolved.entrypoint_script, gate.package_script ?? '') ||
          invocation !==
            (resolved.entrypoint_script === gate.package_script ? 'direct' : 'transitive'))
      ) {
        errors.push(`${gate.id}: package-script invocation chain is not truthful`);
      }
      if (
        gate.kind === 'jest_receipt' &&
        (!(gate.entrypoint_scripts ?? []).includes(resolved.entrypoint_script) ||
          invocation !== 'direct')
      ) {
        errors.push(`${gate.id}: Jest receipt entrypoint is not truthful`);
      }
      return [core(resolved, invocation)];
    });
    const actual = actualExecutions(gate, scripts, workflows);
    if (JSON.stringify(actual) !== JSON.stringify(sortedExecutions(declared))) {
      errors.push(`${gate.id}: workflow mapping inventory disagrees with live workflows`);
    }
    const expectedStatus = actual.length ? 'wired' : 'unwired';
    if (gate.workflow_status !== expectedStatus) {
      errors.push(`${gate.id}: workflow status must be ${expectedStatus}`);
    }
    if (gate.workflow_status === 'unwired' && gate.declared_tier !== 'report_only') {
      errors.push(`${gate.id}: an unwired gate must remain report_only`);
    }

    if (!contract.external_enforcement_policy.statuses.includes(gate.external_enforcement.status)) {
      errors.push(`${gate.id}: unknown external enforcement status`);
    } else if (gate.external_enforcement.status === 'not-verified') {
      if (gate.external_enforcement.receipt !== null) {
        errors.push(`${gate.id}: not-verified external enforcement must not cite a receipt`);
      }
    } else {
      validateExternalReceipt(gate, contract, errors);
    }
    if (gate.declared_tier === 'pr_blocker' && gate.external_enforcement.status !== 'verified') {
      errors.push(`${gate.id}: pr_blocker requires verified external branch protection`);
    }
  }
  return errors;
}
