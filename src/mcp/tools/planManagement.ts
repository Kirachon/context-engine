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
import { EnhancedPlanOutput, PlanStatus } from '../types/planning.js';

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
  const planJson = args.plan as string;
  if (!planJson || typeof planJson !== 'string') {
    throw new Error('plan is required and must be a JSON string');
  }

  let plan: EnhancedPlanOutput;
  try {
    plan = JSON.parse(planJson) as EnhancedPlanOutput;
  } catch {
    throw new Error('plan must be valid JSON');
  }

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
  const service = getPersistenceService();

  let plan: EnhancedPlanOutput | null = null;

  if (args.plan_id) {
    plan = await service.loadPlan(args.plan_id as string);
  } else if (args.name) {
    plan = await service.loadPlanByName(args.name as string);
  } else {
    throw new Error('Either plan_id or name is required');
  }

  if (!plan) {
    return JSON.stringify({ success: false, error: 'Plan not found' });
  }

  return JSON.stringify({ success: true, plan }, null, 2);
}

export async function handleListPlans(args: Record<string, unknown>): Promise<string> {
  const service = getPersistenceService();
  const plans = await service.listPlans({
    status: args.status as PlanStatus | undefined,
    tags: args.tags as string[] | undefined,
    limit: args.limit as number | undefined,
  });

  return JSON.stringify({ success: true, plans, count: plans.length }, null, 2);
}

export async function handleDeletePlan(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  if (!planId) throw new Error('plan_id is required');

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
  const planId = args.plan_id as string;
  if (!planId) throw new Error('plan_id is required');

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
  const requestId = args.request_id as string;
  if (!requestId) throw new Error('request_id is required');

  const action = args.action as 'approve' | 'reject' | 'request_modification';
  if (!action) throw new Error('action is required');

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
  const planId = args.plan_id as string;
  const stepNumber = args.step_number as number;
  if (!planId) throw new Error('plan_id is required');
  if (typeof stepNumber !== 'number') throw new Error('step_number is required');

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
    return JSON.stringify({ success: false, error: 'Could not start step' });
  }

  return JSON.stringify({ success: true, step: result }, null, 2);
}

export async function handleCompleteStep(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  const stepNumber = args.step_number as number;
  if (!planId) throw new Error('plan_id is required');
  if (typeof stepNumber !== 'number') throw new Error('step_number is required');

  const persistService = getPersistenceService();
  const plan = await persistService.loadPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const execService = getExecutionService();
  const result = execService.completeStep(planId, stepNumber, plan, {
    notes: args.notes as string | undefined,
    files_modified: args.files_modified as string[] | undefined,
  });

  if (!result) {
    return JSON.stringify({ success: false, error: 'Could not complete step' });
  }

  const progress = execService.getProgress(planId);

  // Update plan status if all done
  if (progress && progress.percentage === 100) {
    await persistService.updatePlanStatus(planId, 'completed');
  }

  return JSON.stringify({ success: true, step: result, progress }, null, 2);
}

export async function handleFailStep(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  const stepNumber = args.step_number as number;
  const error = args.error as string;
  if (!planId) throw new Error('plan_id is required');
  if (typeof stepNumber !== 'number') throw new Error('step_number is required');
  if (!error) throw new Error('error is required');

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
    return JSON.stringify({ success: false, error: 'Could not mark step as failed' });
  }

  const progress = execService.getProgress(planId);
  return JSON.stringify({ success: true, step: result, progress }, null, 2);
}

export async function handleViewProgress(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  if (!planId) throw new Error('plan_id is required');

  const execService = getExecutionService();
  const progress = execService.getProgress(planId);

  if (!progress) {
    return JSON.stringify({ success: false, error: 'No execution state found for plan' });
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
  const planId = args.plan_id as string;
  if (!planId) throw new Error('plan_id is required');

  const histService = getHistoryService();
  const history = histService.getHistory(planId, {
    limit: args.limit as number | undefined,
    include_plans: args.include_plans as boolean | undefined,
  });

  if (!history) {
    return JSON.stringify({ success: false, error: 'No history found for plan' });
  }

  return JSON.stringify({ success: true, history }, null, 2);
}

export async function handleComparePlanVersions(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  const fromVersion = args.from_version as number;
  const toVersion = args.to_version as number;
  if (!planId) throw new Error('plan_id is required');
  if (typeof fromVersion !== 'number') throw new Error('from_version is required');
  if (typeof toVersion !== 'number') throw new Error('to_version is required');

  const histService = getHistoryService();
  const diff = histService.generateDiff(planId, fromVersion, toVersion);

  if (!diff) {
    return JSON.stringify({ success: false, error: 'Could not generate diff' });
  }

  return JSON.stringify({ success: true, diff }, null, 2);
}

export async function handleRollbackPlan(args: Record<string, unknown>): Promise<string> {
  const planId = args.plan_id as string;
  const targetVersion = args.target_version as number;
  if (!planId) throw new Error('plan_id is required');
  if (typeof targetVersion !== 'number') throw new Error('target_version is required');

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

