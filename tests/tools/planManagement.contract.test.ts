import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleComparePlanVersions,
  handleCompleteStep,
  handleDeletePlan,
  handleFailStep,
  handleListPlans,
  handleLoadPlan,
  handleRequestApproval,
  handleRespondApproval,
  handleRollbackPlan,
  handleSavePlan,
  handleStartStep,
  handleViewHistory,
  handleViewProgress,
  initializePlanManagementServices,
} from '../../src/mcp/tools/planManagement.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

function createContractPlan(version = 1): EnhancedPlanOutput {
  return {
    id: 'plan_contract',
    version,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: version === 1 ? '2025-01-01T00:00:00.000Z' : '2025-01-02T00:00:00.000Z',
    goal: version === 1 ? 'Plan v1' : 'Plan v2',
    scope: { included: ['Batch A'], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: 'Contract fixture', patterns_used: [], diagrams: [] },
    risks: [],
    milestones: [],
    steps: [
      {
        step_number: 1,
        id: 'step_1',
        title: 'Step 1',
        description: 'Start contract flow',
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [],
        blocks: [2],
        can_parallel_with: [],
        priority: 'high',
        estimated_effort: '1h',
        acceptance_criteria: [],
      },
      {
        step_number: 2,
        id: 'step_2',
        title: version === 1 ? 'Step 2' : 'Step 2 Updated',
        description: 'Continue contract flow',
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [1],
        blocks: [],
        can_parallel_with: [],
        priority: 'medium',
        estimated_effort: '30m',
        acceptance_criteria: [],
      },
    ],
    dependency_graph: {
      nodes: [{ id: 'step_1', step_number: 1 }, { id: 'step_2', step_number: 2 }],
      edges: [{ from: 'step_1', to: 'step_2', type: 'blocks' }],
      critical_path: [1, 2],
      parallel_groups: [],
      execution_order: [1, 2],
    },
    testing_strategy: { unit: 'Jest', integration: 'N/A', coverage_target: '80%' },
    acceptance_criteria: [],
    confidence_score: 0.8,
    questions_for_clarification: [],
    context_files: [],
    codebase_insights: [],
  };
}

function normalizeContractOutput(value: unknown, tmpDir: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeContractOutput(item, tmpDir));
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === 'created_at' ||
        key === 'updated_at' ||
        key === 'last_modified_at' ||
        key === 'started_at' ||
        key === 'completed_at' ||
        key === 'resolved_at'
      ) {
        normalized[key] = '<fixed-time>';
        continue;
      }
      if (key === 'duration_ms' && typeof innerValue === 'number') {
        normalized[key] = 0;
        continue;
      }
      if (key === 'id' && typeof innerValue === 'string' && innerValue.startsWith('approval_')) {
        normalized[key] = '<approval-id>';
        continue;
      }
      normalized[key] = normalizeContractOutput(innerValue, tmpDir);
      if (key === 'file_path' && typeof normalized[key] === 'string') {
        normalized[key] = (normalized[key] as string).replaceAll('\\', '/');
      }
    }
    return normalized;
  }

  if (typeof value === 'string') {
    if (value.startsWith('approval_')) return '<approval-id>';
    if (value.includes(tmpDir)) {
      return value.replaceAll(tmpDir, '<workspace>').replaceAll('\\', '/');
    }
    return value;
  }

  return value;
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function expectOperationFailureEnvelope(
  actual: Record<string, unknown>,
  expectedError: string,
  expectedRetryGuidance: string
): void {
  expect(actual).toEqual({
    success: false,
    error: expectedError,
    retry_guidance: expectedRetryGuidance,
  });
  expect(Object.keys(actual).sort()).toEqual(['error', 'retry_guidance', 'success']);
}

describe('plan management contract snapshots', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mgmt-contract-'));
    initializePlanManagementServices(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('captures end-to-end management handler output contracts', async () => {
    const planV1 = createContractPlan(1);
    const planV2 = createContractPlan(2);

    const saveV1 = parse(await handleSavePlan({ plan: JSON.stringify(planV1), name: 'Contract Plan', tags: ['batch-a'] }));
    const saveV2 = parse(await handleSavePlan({ plan: JSON.stringify(planV2), overwrite: true }));

    const loadPlan = parse(await handleLoadPlan({ plan_id: planV1.id }));
    const listPlans = parse(await handleListPlans({ limit: 10 }));

    const requestApproval = parse(await handleRequestApproval({ plan_id: planV1.id, step_numbers: [1] }));
    const requestId = ((requestApproval.request as Record<string, unknown>).id as string);
    const respondApproval = parse(await handleRespondApproval({ request_id: requestId, action: 'approve', comment: 'approved for contract test' }));

    const startStep = parse(await handleStartStep({ plan_id: planV1.id, step_number: 1 }));
    const completeStep = parse(
      await handleCompleteStep({
        plan_id: planV1.id,
        step_number: 1,
        notes: 'completed in contract test',
        files_modified: ['tests/tools/planManagement.contract.test.ts'],
      })
    );
    const failStep = parse(await handleFailStep({ plan_id: planV1.id, step_number: 2, error: 'intentional failure', skip: true }));

    const viewProgress = parse(await handleViewProgress({ plan_id: planV1.id }));
    const viewHistory = parse(await handleViewHistory({ plan_id: planV1.id, limit: 5, include_plans: false }));
    const compareVersions = parse(await handleComparePlanVersions({ plan_id: planV1.id, from_version: 1, to_version: 2 }));
    const rollbackPlan = parse(await handleRollbackPlan({ plan_id: planV1.id, target_version: 1, reason: 'validate rollback contract' }));
    const deletePlan = parse(await handleDeletePlan({ plan_id: planV1.id }));

    expect(
      normalizeContractOutput(
        {
          save_plan_v1: saveV1,
          save_plan_v2: saveV2,
          load_plan: loadPlan,
          list_plans: listPlans,
          request_approval: requestApproval,
          respond_approval: respondApproval,
          start_step: startStep,
          complete_step: completeStep,
          fail_step: failStep,
          view_progress: viewProgress,
          view_history: viewHistory,
          compare_plan_versions: compareVersions,
          rollback_plan: rollbackPlan,
          delete_plan: deletePlan,
        },
        tmpDir
      )
    ).toMatchSnapshot();
  });

  it('returns stable retry_guidance for operation-level failure responses', async () => {
    const plan = createContractPlan(1);
    const planNoExecution = { ...createContractPlan(1), id: 'plan_no_execution' };
    await handleSavePlan({ plan: JSON.stringify(plan), name: 'Failure Contract Plan' });
    await handleSavePlan({ plan: JSON.stringify(planNoExecution), name: 'No Execution Plan' });

    const loadPlanNotFound = parse(await handleLoadPlan({ plan_id: 'missing_plan' }));
    expectOperationFailureEnvelope(
      loadPlanNotFound,
      'Plan not found',
      'Verify plan_id or name exists, then retry.'
    );

    const startStepFailure = parse(await handleStartStep({ plan_id: plan.id, step_number: 999 }));
    expectOperationFailureEnvelope(
      startStepFailure,
      'Could not start step',
      'Verify plan_id and step_number are valid and ready, then retry.'
    );

    const completeStepFailure = parse(
      await handleCompleteStep({
        plan_id: planNoExecution.id,
        step_number: 1,
      })
    );
    expectOperationFailureEnvelope(
      completeStepFailure,
      'Could not complete step',
      'Initialize execution state and verify step_number, then retry.'
    );

    const failStepFailure = parse(
      await handleFailStep({
        plan_id: planNoExecution.id,
        step_number: 1,
        error: 'forced failure',
      })
    );
    expectOperationFailureEnvelope(
      failStepFailure,
      'Could not mark step as failed',
      'Initialize execution state and verify step_number, then retry.'
    );

    const viewProgressNoState = parse(await handleViewProgress({ plan_id: 'no_execution_plan' }));
    expectOperationFailureEnvelope(
      viewProgressNoState,
      'No execution state found for plan',
      'Initialize execution state for this plan, then retry.'
    );

    const viewHistoryNoHistory = parse(await handleViewHistory({ plan_id: 'no_history_plan' }));
    expectOperationFailureEnvelope(
      viewHistoryNoHistory,
      'No history found for plan',
      'Verify plan_id exists and has recorded history, then retry.'
    );

    const compareVersionsDiffFail = parse(
      await handleComparePlanVersions({
        plan_id: plan.id,
        from_version: 1,
        to_version: 2,
      })
    );
    expectOperationFailureEnvelope(
      compareVersionsDiffFail,
      'Could not generate diff',
      'Verify plan_id and requested versions exist in history, then retry.'
    );
  });
});
