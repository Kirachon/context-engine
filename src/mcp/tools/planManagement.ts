/**
 * Plan Management MCP Tools
 *
 * Phase 2 tools for plan persistence, approval workflows, execution tracking,
 * and version history management.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PlanPersistenceService } from '../services/planPersistenceService.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import { ExecutionTrackingService } from '../services/executionTrackingService.js';
import { PlanHistoryService } from '../services/planHistoryService.js';
import {
  CompletePlanState,
  EnhancedPlanOutput,
  PlanExecutionState,
  PlanStatus,
  StepExecutionState,
} from '../types/planning.js';
import {
  parseJsonString,
  validateFiniteNumberInRange,
  validateNonEmptyString,
  validateOneOf,
  validateRequiredNumber,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

// ============================================================================
// Service Instances (lazily initialized)
// ============================================================================

let persistenceService: PlanPersistenceService | null = null;
let approvalService: ApprovalWorkflowService | null = null;
let executionService: ExecutionTrackingService | null = null;
let historyService: PlanHistoryService | null = null;

export function initializePlanManagementServices(workspaceRoot: string): void {
  persistenceService = new PlanPersistenceService(workspaceRoot);
  approvalService = new ApprovalWorkflowService();
  executionService = new ExecutionTrackingService();
  historyService = new PlanHistoryService(workspaceRoot);
}

function getPersistenceService(): PlanPersistenceService {
  if (!persistenceService) throw new Error('Plan management services not initialized');
  return persistenceService;
}

export function getPlanPersistenceService(): PlanPersistenceService {
  return getPersistenceService();
}

function getApprovalService(): ApprovalWorkflowService {
  if (!approvalService) throw new Error('Plan management services not initialized');
  return approvalService;
}

function getExecutionService(): ExecutionTrackingService {
  if (!executionService) throw new Error('Plan management services not initialized');
  return executionService;
}

function getHistoryService(): PlanHistoryService {
  if (!historyService) throw new Error('Plan management services not initialized');
  return historyService;
}

export function getPlanHistoryService(): PlanHistoryService {
  return getHistoryService();
}

export type PersistedPlanStateReadReason =
  | 'plan_not_found'
  | 'plan_unavailable'
  | 'plan_services_uninitialized';

export type PersistedPlanStateReadResult =
  | {
    ok: true;
    plan_id: string;
    state: CompletePlanState;
  }
  | {
    ok: false;
    plan_id: string;
    reason: PersistedPlanStateReadReason;
    message: string;
  };

export interface PersistedPlanStateReadServices {
  getPersistenceService: () => Pick<PlanPersistenceService, 'getPlanMetadata' | 'loadPlan'>;
  getApprovalService?: () => Pick<ApprovalWorkflowService, 'getPendingApprovalsForPlan'>;
  getExecutionService?: () => Pick<ExecutionTrackingService, 'getExecutionState'>;
  getHistoryService?: () => Pick<PlanHistoryService, 'getHistory'>;
}

function buildDefaultExecutionState(plan: EnhancedPlanOutput, status: PlanStatus): PlanExecutionState {
  const steps: StepExecutionState[] = (plan.steps ?? []).map((step) => ({
    step_number: step.step_number,
    step_id: step.id,
    status: 'pending',
    retry_count: 0,
  }));

  return {
    plan_id: plan.id,
    plan_version: plan.version,
    status,
    steps,
    current_steps: [],
    ready_steps: [],
    blocked_steps: [],
  };
}

function isPlanServicesUninitializedError(error: unknown): boolean {
  return error instanceof Error && /services not initialized/i.test(error.message);
}

export async function readPersistedPlanState(
  planId: string,
  services: PersistedPlanStateReadServices = {
    getPersistenceService,
    getApprovalService,
    getExecutionService,
    getHistoryService,
  }
): Promise<PersistedPlanStateReadResult> {
  try {
    const persistence = services.getPersistenceService();
    const metadata = await persistence.getPlanMetadata(planId);

    if (!metadata) {
      return {
        ok: false,
        plan_id: planId,
        reason: 'plan_not_found',
        message: `No persisted plan metadata found for ${planId}.`,
      };
    }

    const plan = await persistence.loadPlan(planId);
    if (!plan) {
      return {
        ok: false,
        plan_id: planId,
        reason: 'plan_unavailable',
        message: `Persisted plan ${planId} could not be loaded from disk.`,
      };
    }

    const execution = services.getExecutionService?.()?.getExecutionState(planId)
      ?? buildDefaultExecutionState(plan, metadata.status);
    const pendingApprovals = services.getApprovalService?.()?.getPendingApprovalsForPlan(planId) ?? [];
    const history = services.getHistoryService?.()?.getHistory(planId, { include_plans: false });

    return {
      ok: true,
      plan_id: planId,
      state: {
        plan,
        execution,
        pending_approvals: pendingApprovals,
        version_count: history?.versions.length ?? 0,
        metadata,
      },
    };
  } catch (error) {
    return {
      ok: false,
      plan_id: planId,
      reason: isPlanServicesUninitializedError(error) ? 'plan_services_uninitialized' : 'plan_unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function operationFailureResponse(error: string, retryGuidance: string): string {
  return JSON.stringify({
    success: false,
    error,
    retry_guidance: retryGuidance,
  });
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const savePlanTool: Tool = {
  name: 'save_plan',
  description: 'Save a plan to persistent storage for later retrieval and execution tracking.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'JSON string of the EnhancedPlanOutput to save' },
      name: { type: 'string', description: 'Optional custom name for the plan' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for organization' },
      overwrite: { type: 'boolean', description: 'Whether to overwrite existing plan with same ID' },
    },
    required: ['plan'],
  },
};

export const loadPlanTool: Tool = {
  name: 'load_plan',
  description: 'Load a previously saved plan by ID or name.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID to load' },
      name: { type: 'string', description: 'Plan name to load (alternative to plan_id)' },
    },
    required: [],
  },
};

export const listPlansTool: Tool = {
  name: 'list_plans',
  description: 'List all saved plans with optional filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'approved', 'executing', 'completed', 'failed'], description: 'Filter by status' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
      limit: { type: 'number', description: 'Maximum number of plans to return' },
    },
    required: [],
  },
};

export const deletePlanTool: Tool = {
  name: 'delete_plan',
  description: 'Delete a saved plan from storage.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID to delete' },
    },
    required: ['plan_id'],
  },
};

export const requestApprovalTool: Tool = {
  name: 'request_approval',
  description: 'Create an approval request for a plan or specific steps.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID to request approval for' },
      step_numbers: { type: 'array', items: { type: 'number' }, description: 'Optional specific step numbers to approve' },
    },
    required: ['plan_id'],
  },
};

export const respondApprovalTool: Tool = {
  name: 'respond_approval',
  description: 'Respond to a pending approval request (approve, reject, or request modifications).',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string', description: 'Approval request ID' },
      action: { type: 'string', enum: ['approve', 'reject', 'request_modification'], description: 'Action to take' },
      comment: { type: 'string', description: 'Optional comment' },
      modifications: { type: 'string', description: 'Requested modifications (if action is request_modification)' },
    },
    required: ['request_id', 'action'],
  },
};

export const startStepTool: Tool = {
  name: 'start_step',
  description: 'Mark a step as in-progress to begin execution.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      step_number: { type: 'number', description: 'Step number to start' },
    },
    required: ['plan_id', 'step_number'],
  },
};

export const completeStepTool: Tool = {
  name: 'complete_step',
  description: 'Mark a step as completed with optional notes.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      step_number: { type: 'number', description: 'Step number to complete' },
      notes: { type: 'string', description: 'Completion notes' },
      files_modified: { type: 'array', items: { type: 'string' }, description: 'List of files actually modified' },
    },
    required: ['plan_id', 'step_number'],
  },
};

export const failStepTool: Tool = {
  name: 'fail_step',
  description: 'Mark a step as failed with error details.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      step_number: { type: 'number', description: 'Step number that failed' },
      error: { type: 'string', description: 'Error message' },
      retry: { type: 'boolean', description: 'Whether to retry the step' },
      skip: { type: 'boolean', description: 'Skip this step and continue' },
      skip_dependents: { type: 'boolean', description: 'Skip all steps that depend on this one' },
    },
    required: ['plan_id', 'step_number', 'error'],
  },
};

export const viewProgressTool: Tool = {
  name: 'view_progress',
  description: 'View execution progress for a plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
    },
    required: ['plan_id'],
  },
};

export const viewHistoryTool: Tool = {
  name: 'view_history',
  description: 'View version history for a plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      limit: { type: 'number', description: 'Number of versions to retrieve' },
      include_plans: { type: 'boolean', description: 'Include full plan content in each version' },
    },
    required: ['plan_id'],
  },
};

export const comparePlanVersionsTool: Tool = {
  name: 'compare_plan_versions',
  description: 'Generate a diff between two versions of a plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      from_version: { type: 'number', description: 'Earlier version number' },
      to_version: { type: 'number', description: 'Later version number' },
    },
    required: ['plan_id', 'from_version', 'to_version'],
  },
};

export const rollbackPlanTool: Tool = {
  name: 'rollback_plan',
  description: 'Rollback a plan to a previous version.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'Plan ID' },
      target_version: { type: 'number', description: 'Version to rollback to' },
      reason: { type: 'string', description: 'Reason for rollback' },
    },
    required: ['plan_id', 'target_version'],
  },
};

// ============================================================================
// All Phase 2 Tools
// ============================================================================

export const planManagementTools: Tool[] = [
  savePlanTool,
  loadPlanTool,
  listPlansTool,
  deletePlanTool,
  requestApprovalTool,
  respondApprovalTool,
  startStepTool,
  completeStepTool,
  failStepTool,
  viewProgressTool,
  viewHistoryTool,
  comparePlanVersionsTool,
  rollbackPlanTool,
];

// ============================================================================
// Tool Handlers
// ============================================================================

export async function handleSavePlan(args: Record<string, unknown>): Promise<string> {
  const planJson = validateNonEmptyString(args.plan, 'plan is required and must be a JSON string');
  const plan = parseJsonString<EnhancedPlanOutput>(planJson, 'plan must be valid JSON');

  const service = getPersistenceService();
  const result = await service.savePlan(plan, {
    name: args.name as string | undefined,
    tags: args.tags as string[] | undefined,
    overwrite: args.overwrite as boolean | undefined,
  });

  // Record in history
  if (result.success) {
    getHistoryService().recordVersion(plan, 'created', 'Plan saved');
  }

  return JSON.stringify(result, null, 2);
}

export async function handleLoadPlan(args: Record<string, unknown>): Promise<string> {
  let plan: EnhancedPlanOutput | null = null;

  if (args.plan_id !== undefined) {
    const planId = validateTrimmedNonEmptyString(
      args.plan_id,
      'plan_id must be a non-empty string'
    );
    const service = getPersistenceService();
    plan = await service.loadPlan(planId);
  } else if (args.name !== undefined) {
    const name = validateTrimmedNonEmptyString(args.name, 'name must be a non-empty string');
    const service = getPersistenceService();
    plan = await service.loadPlanByName(name);
  } else {
    throw new Error('Either plan_id or name is required');
  }

  if (!plan) {
    return operationFailureResponse(
      'Plan not found',
      'Verify plan_id or name exists, then retry.'
    );
  }

  return JSON.stringify({ success: true, plan }, null, 2);
}

export async function handleListPlans(args: Record<string, unknown>): Promise<string> {
  validateFiniteNumberInRange(
    args.limit,
    Number.EPSILON,
    Number.MAX_SAFE_INTEGER,
    'limit must be a finite positive number'
  );

  const service = getPersistenceService();
  const plans = await service.listPlans({
    status: args.status as PlanStatus | undefined,
    tags: args.tags as string[] | undefined,
    limit: args.limit as number | undefined,
  });

  return JSON.stringify({ success: true, plans, count: plans.length }, null, 2);
}

export async function handleDeletePlan(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');

  const service = getPersistenceService();
  const result = await service.deletePlan(planId);

  // Also delete history
  if (result.success) {
    getHistoryService().deleteHistory(planId);
    getExecutionService().removeExecutionState(planId);
  }

  return JSON.stringify(result, null, 2);
}

export async function handleRequestApproval(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');

  const persistService = getPersistenceService();
  const plan = await persistService.loadPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const approvalSvc = getApprovalService();
  const stepNumbers = args.step_numbers as number[] | undefined;

  let request;
  if (stepNumbers && stepNumbers.length > 0) {
    if (stepNumbers.length === 1) {
      request = approvalSvc.createStepApprovalRequest(plan, stepNumbers[0]);
    } else {
      request = approvalSvc.createStepGroupApprovalRequest(plan, stepNumbers);
    }
  } else {
    request = approvalSvc.createPlanApprovalRequest(plan);
  }

  return JSON.stringify({ success: true, request }, null, 2);
}

export async function handleRespondApproval(args: Record<string, unknown>): Promise<string> {
  const requestId = validateNonEmptyString(args.request_id, 'request_id is required');
  const action = validateNonEmptyString(args.action, 'action is required');
  validateOneOf(
    action,
    ['approve', 'reject', 'request_modification'] as const,
    'action must be one of: approve, reject, request_modification'
  );

  const approvalSvc = getApprovalService();
  const result = approvalSvc.processApprovalResponse({
    request_id: requestId,
    action,
    comment: args.comment as string | undefined,
    modifications: args.modifications as string | undefined,
  });

  // Update plan status if approved
  if (result.success && result.request?.status === 'approved') {
    const persistService = getPersistenceService();
    await persistService.updatePlanStatus(result.request.plan_id, 'approved');
  }

  return JSON.stringify(result, null, 2);
}

export async function handleStartStep(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');
  const stepNumber = validateRequiredNumber(args.step_number, 'step_number is required');

  const execService = getExecutionService();

  // Initialize if needed
  if (!execService.hasExecutionState(planId)) {
    const plan = await getPersistenceService().loadPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    execService.initializeExecution(plan);
    await getPersistenceService().updatePlanStatus(planId, 'executing');
  }

  const result = execService.startStep(planId, stepNumber);
  if (!result) {
    return operationFailureResponse(
      'Could not start step',
      'Verify plan_id and step_number are valid and ready, then retry.'
    );
  }

  return JSON.stringify({ success: true, step: result }, null, 2);
}

export async function handleCompleteStep(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');
  const stepNumber = validateRequiredNumber(args.step_number, 'step_number is required');

  const persistService = getPersistenceService();
  const plan = await persistService.loadPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const execService = getExecutionService();
  const result = execService.completeStep(planId, stepNumber, plan, {
    notes: args.notes as string | undefined,
    files_modified: args.files_modified as string[] | undefined,
  });

  if (!result) {
    return operationFailureResponse(
      'Could not complete step',
      'Initialize execution state and verify step_number, then retry.'
    );
  }

  const progress = execService.getProgress(planId);

  // Update plan status if all done
  if (progress && progress.percentage === 100) {
    await persistService.updatePlanStatus(planId, 'completed');
  }

  return JSON.stringify({ success: true, step: result, progress }, null, 2);
}

export async function handleFailStep(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');
  const stepNumber = validateRequiredNumber(args.step_number, 'step_number is required');
  const error = validateNonEmptyString(args.error, 'error is required');

  const persistService = getPersistenceService();
  const plan = await persistService.loadPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const execService = getExecutionService();
  const result = execService.failStep(planId, stepNumber, plan, {
    error,
    retry: args.retry as boolean | undefined,
    skip: args.skip as boolean | undefined,
    skip_dependents: args.skip_dependents as boolean | undefined,
  });

  if (!result) {
    return operationFailureResponse(
      'Could not mark step as failed',
      'Initialize execution state and verify step_number, then retry.'
    );
  }

  const progress = execService.getProgress(planId);
  return JSON.stringify({ success: true, step: result, progress }, null, 2);
}

export async function handleViewProgress(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');

  const execService = getExecutionService();
  const progress = execService.getProgress(planId);

  if (!progress) {
    return operationFailureResponse(
      'No execution state found for plan',
      'Initialize execution state for this plan, then retry.'
    );
  }

  const state = execService.getExecutionState(planId);
  return JSON.stringify({
    success: true,
    progress,
    ready_steps: state?.ready_steps || [],
    current_steps: state?.current_steps || [],
  }, null, 2);
}

export async function handleViewHistory(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');

  const histService = getHistoryService();
  const history = histService.getHistory(planId, {
    limit: args.limit as number | undefined,
    include_plans: args.include_plans as boolean | undefined,
  });

  if (!history) {
    return operationFailureResponse(
      'No history found for plan',
      'Verify plan_id exists and has recorded history, then retry.'
    );
  }

  return JSON.stringify({ success: true, history }, null, 2);
}

export async function handleComparePlanVersions(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');
  const fromVersion = validateRequiredNumber(args.from_version, 'from_version is required');
  const toVersion = validateRequiredNumber(args.to_version, 'to_version is required');

  const histService = getHistoryService();
  const diff = histService.generateDiff(planId, fromVersion, toVersion);

  if (!diff) {
    return operationFailureResponse(
      'Could not generate diff',
      'Verify plan_id and requested versions exist in history, then retry.'
    );
  }

  return JSON.stringify({ success: true, diff }, null, 2);
}

export async function handleRollbackPlan(args: Record<string, unknown>): Promise<string> {
  const planId = validateNonEmptyString(args.plan_id, 'plan_id is required');
  const targetVersion = validateRequiredNumber(args.target_version, 'target_version is required');

  const histService = getHistoryService();
  const result = histService.rollback(planId, {
    target_version: targetVersion,
    reason: args.reason as string | undefined,
  });

  // Update persisted plan if rollback successful
  if (result.success && result.plan) {
    const persistService = getPersistenceService();
    await persistService.savePlan(result.plan, { overwrite: true });
  }

  return JSON.stringify(result, null, 2);
}
