/**
 * Layer 3: MCP Interface Layer - Planning Tools
 *
 * Exposes planning mode capabilities as MCP tools.
 * These tools enable AI-powered software planning and architecture design.
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to PlanningService layer
 * - Format plan output for optimal consumption
 *
 * Tools:
 * - create_plan: Generate a new implementation plan
 * - refine_plan: Refine an existing plan based on feedback
 * - visualize_plan: Generate diagrams from a plan
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContextServiceClient } from '../serviceClient.js';
import { PlanningService } from '../services/planningService.js';
import { createClientBoundFactory } from '../tooling/serviceFactory.js';
import { parseJsonString, validateNonEmptyString, validateRequiredNumber, validateTrimmedNonEmptyString } from '../tooling/validation.js';
import {
  EnhancedPlanOutput,
  PlanGenerationOptions,
  PlanRefinementOptions,
  PlanResult,
  ExecutionMode,
  ExecutePlanResult,
  StepExecutionResult,
  ExecutionProgress,
  GeneratedCodeChange,
} from '../types/planning.js';

const planningServiceFactory = createClientBoundFactory(
  (serviceClient: ContextServiceClient) => new PlanningService(serviceClient)
);

function getPlanningService(serviceClient: ContextServiceClient): PlanningService {
  return planningServiceFactory.get(serviceClient);
}

// ============================================================================
// Tool Argument Types
// ============================================================================

export interface CreatePlanArgs {
  /** The task or goal to plan for */
  task: string;
  /** Maximum files to include in context (default: 10) */
  max_context_files?: number;
  /** Token budget for context retrieval (default: 12000) */
  context_token_budget?: number;
  /** Generate architecture diagrams (default: true) */
  generate_diagrams?: boolean;
  /** Focus on MVP only (default: false) */
  mvp_only?: boolean;
  /** Persist the generated plan for later use (default: true) */
  auto_save?: boolean;
  /** Optional custom name for saved plan */
  save_name?: string;
  /** Optional tags for saved plan */
  save_tags?: string[];
  /** Overwrite existing plan with same ID when auto-saving */
  save_overwrite?: boolean;
}

export interface RefinePlanArgs {
  /** The current plan (JSON string) */
  current_plan: string;
  /** User feedback on the current plan */
  feedback?: string;
  /** Clarification answers as JSON object */
  clarifications?: string;
  /** Specific step numbers to focus on */
  focus_steps?: number[];
}

export interface VisualizePlanArgs {
  /** The plan to visualize (JSON string) */
  plan: string;
  /** Type of diagram: 'dependencies', 'architecture', 'gantt' */
  diagram_type?: 'dependencies' | 'architecture' | 'gantt';
}

export interface ExecutePlanArgs {
  /** The plan to execute (JSON string) */
  plan?: string;
  /** Optional plan ID to load from persisted storage */
  plan_id?: string;
  /** Execution mode: 'single_step', 'all_ready', or 'full_plan' */
  mode?: ExecutionMode;
  /** Specific step number to execute (required for single_step mode) */
  step_number?: number;
  /** Whether to apply changes automatically (default: false - preview only) */
  apply_changes?: boolean;
  /** Maximum steps to execute in one call (default: 5) */
  max_steps?: number;
  /** Whether to stop on first failure (default: true) */
  stop_on_failure?: boolean;
  /** Additional context to provide to the AI */
  additional_context?: string;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Handle the create_plan tool call
 */
export async function handleCreatePlan(
  args: CreatePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const {
    task,
    max_context_files,
    context_token_budget,
    generate_diagrams,
    mvp_only,
    auto_save = true,
    save_name,
    save_tags,
    save_overwrite,
  } = args;

  const validatedTask = validateTrimmedNonEmptyString(task, 'Task is required and must be a non-empty string');

  const planningService = getPlanningService(serviceClient);

  const options: PlanGenerationOptions = {
    max_context_files,
    context_token_budget,
    generate_diagrams,
    mvp_only,
  };

  console.error(`[create_plan] Generating plan for: "${validatedTask.substring(0, 100)}..."`);

  const result = await planningService.generatePlan(validatedTask, options);

  if (!result.success) {
    throw new Error(`Failed to generate plan: ${result.error}`);
  }

  let persistence: { saved: boolean; plan_id?: string; file_path?: string; error?: string } | undefined;
  if (auto_save && result.plan) {
    try {
      const workspacePath = typeof serviceClient.getWorkspacePath === 'function'
        ? serviceClient.getWorkspacePath()
        : null;
      if (!workspacePath) {
        persistence = { saved: false, error: 'Plan persistence unavailable (workspace path missing)' };
        return formatPlanResult(result, persistence);
      }
      const { PlanPersistenceService } = await import('../services/planPersistenceService.js');
      const service = new PlanPersistenceService(workspacePath);
      const saved = await service.savePlan(result.plan, {
        name: save_name,
        tags: save_tags,
        overwrite: save_overwrite,
      });
      persistence = {
        saved: saved.success,
        plan_id: saved.plan_id,
        file_path: saved.file_path,
        error: saved.error,
      };
    } catch (error) {
      persistence = {
        saved: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Format the result for output
  return formatPlanResult(result, persistence);
}

/**
 * Handle the refine_plan tool call
 */
export async function handleRefinePlan(
  args: RefinePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { current_plan, feedback, clarifications, focus_steps } = args;

  const currentPlan = validateNonEmptyString(
    current_plan,
    'current_plan is required and must be a valid JSON string'
  );
  const plan = parseJsonString<EnhancedPlanOutput>(currentPlan, 'current_plan must be valid JSON');

  let parsedClarifications: Record<string, string> | undefined;
  if (clarifications) {
    parsedClarifications = parseJsonString<Record<string, string>>(
      clarifications,
      'clarifications must be valid JSON'
    );
  }

  const planningService = getPlanningService(serviceClient);

  const options: PlanRefinementOptions = {
    feedback,
    clarifications: parsedClarifications,
    focus_steps,
  };

  console.error(`[refine_plan] Refining plan v${plan.version}`);

  const result = await planningService.refinePlan(plan, options);

  if (!result.success) {
    throw new Error(`Failed to refine plan: ${result.error}`);
  }

  return formatPlanResult(result);
}

/**
 * Handle the visualize_plan tool call
 */
export async function handleVisualizePlan(
  args: VisualizePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { plan: planJson, diagram_type = 'dependencies' } = args;

  const planInput = validateNonEmptyString(planJson, 'plan is required and must be a valid JSON string');
  const plan = parseJsonString<EnhancedPlanOutput>(planInput, 'plan must be valid JSON');

  const planningService = getPlanningService(serviceClient);

  let mermaid: string;

  switch (diagram_type) {
    case 'dependencies':
      mermaid = planningService.generateDependencyDiagram(plan);
      break;
    case 'architecture':
      // Find architecture diagram from plan or generate placeholder
      const archDiagram = plan.architecture.diagrams.find(d => d.type === 'architecture');
      mermaid = archDiagram?.mermaid || 'graph TD\n    A[No architecture diagram available]';
      break;
    case 'gantt':
      mermaid = generateGanttDiagram(plan);
      break;
    default:
      mermaid = planningService.generateDependencyDiagram(plan);
  }

  return JSON.stringify({
    diagram_type,
    mermaid,
    plan_id: plan.id,
    plan_version: plan.version,
  }, null, 2);
}

// ============================================================================
// File Apply Implementation
// ============================================================================

/**
 * Result of applying generated changes to files
 */
interface ApplyChangesResult {
  /** Files that were successfully applied */
  applied: string[];
  /** Errors encountered during application */
  errors: string[];
  /** Backup files created before overwriting */
  backups: string[];
}

/**
 * Validate that a file path is within the workspace and safe to write
 */
function validateFilePath(filePath: string, workspacePath: string): { valid: boolean; error?: string; fullPath?: string } {
  // Normalize the path
  const normalizedPath = path.normalize(filePath);

  // Check for path traversal attempts
  if (normalizedPath.includes('..')) {
    return { valid: false, error: `Path contains directory traversal: ${filePath}` };
  }

  // Build absolute path
  const fullPath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.join(workspacePath, normalizedPath);

  // Ensure the path is within workspace
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedPath = path.resolve(fullPath);

  if (!resolvedPath.startsWith(resolvedWorkspace)) {
    return { valid: false, error: `Path is outside workspace: ${filePath}` };
  }

  return { valid: true, fullPath: resolvedPath };
}

/**
 * Create a backup of an existing file before overwriting
 */
async function createBackup(filePath: string): Promise<string | null> {
  try {
    if (fs.existsSync(filePath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filePath}.backup.${timestamp}`;
      await fs.promises.copyFile(filePath, backupPath);
      console.error(`[apply_changes] Created backup: ${backupPath}`);
      return backupPath;
    }
  } catch (error) {
    console.error(`[apply_changes] Failed to create backup for ${filePath}:`, error);
  }
  return null;
}

/**
 * Ensure parent directories exist for a file path
 */
async function ensureParentDirectory(filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    await fs.promises.mkdir(parentDir, { recursive: true });
    console.error(`[apply_changes] Created directory: ${parentDir}`);
  }
}

/**
 * Apply a single code change to a file
 */
async function applyCodeChange(
  change: GeneratedCodeChange,
  workspacePath: string,
  backups: string[]
): Promise<{ success: boolean; error?: string }> {
  const { path: filePath, change_type, content, diff } = change;

  // Validate the path
  const validation = validateFilePath(filePath, workspacePath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  const fullPath = validation.fullPath!;

  try {
    switch (change_type) {
      case 'create':
        if (!content) {
          return { success: false, error: `No content provided for create operation: ${filePath}` };
        }
        // Check if file already exists
        if (fs.existsSync(fullPath)) {
          const backup = await createBackup(fullPath);
          if (backup) backups.push(backup);
        }
        await ensureParentDirectory(fullPath);
        await fs.promises.writeFile(fullPath, content, 'utf-8');
        console.error(`[apply_changes] Created file: ${filePath}`);
        return { success: true };

      case 'modify':
        if (!content && !diff) {
          return { success: false, error: `No content or diff provided for modify operation: ${filePath}` };
        }
        if (!fs.existsSync(fullPath)) {
          return { success: false, error: `File does not exist for modification: ${filePath}` };
        }
        // Create backup before modifying
        const modifyBackup = await createBackup(fullPath);
        if (modifyBackup) backups.push(modifyBackup);

        // For now, we use full content replacement
        // TODO: Support unified diff format application in future
        if (content) {
          await fs.promises.writeFile(fullPath, content, 'utf-8');
          console.error(`[apply_changes] Modified file: ${filePath}`);
        } else if (diff) {
          // Diff application would go here - for now just log a warning
          console.error(`[apply_changes] Warning: Diff-based modifications not yet implemented, skipping: ${filePath}`);
          return { success: false, error: `Diff-based modifications not yet implemented: ${filePath}` };
        }
        return { success: true };

      case 'delete':
        if (!fs.existsSync(fullPath)) {
          console.error(`[apply_changes] File already deleted or does not exist: ${filePath}`);
          return { success: true }; // Not an error if file is already gone
        }
        // Create backup before deleting
        const deleteBackup = await createBackup(fullPath);
        if (deleteBackup) backups.push(deleteBackup);
        await fs.promises.unlink(fullPath);
        console.error(`[apply_changes] Deleted file: ${filePath}`);
        return { success: true };

      case 'rename':
        // Rename requires both content (new path) and the file to exist
        console.error(`[apply_changes] Warning: Rename operations not yet implemented: ${filePath}`);
        return { success: false, error: `Rename operations not yet implemented: ${filePath}` };

      default:
        return { success: false, error: `Unknown change type: ${change_type}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[apply_changes] Error applying change to ${filePath}:`, error);
    return { success: false, error: `Failed to apply change to ${filePath}: ${errorMessage}` };
  }
}

/**
 * Apply generated code changes to files in the workspace
 *
 * This function takes the step execution results and writes the generated
 * code changes to the filesystem. It includes safety measures:
 * 1. Path validation to prevent directory traversal
 * 2. Backup creation before overwriting existing files
 * 3. Parent directory creation as needed
 */
async function applyGeneratedChanges(
  stepResults: StepExecutionResult[],
  workspacePath: string
): Promise<ApplyChangesResult> {
  const result: ApplyChangesResult = {
    applied: [],
    errors: [],
    backups: [],
  };

  for (const stepResult of stepResults) {
    if (!stepResult.success || !stepResult.generated_code || stepResult.generated_code.length === 0) {
      continue;
    }

    console.error(`[apply_changes] Processing step ${stepResult.step_number} with ${stepResult.generated_code.length} changes`);

    for (const change of stepResult.generated_code) {
      const applyResult = await applyCodeChange(change, workspacePath, result.backups);

      if (applyResult.success) {
        result.applied.push(change.path);
      } else if (applyResult.error) {
        result.errors.push(applyResult.error);
      }
    }
  }

  console.error(`[apply_changes] Applied ${result.applied.length} files, ${result.errors.length} errors, ${result.backups.length} backups created`);

  return result;
}

/**
 * Handle the execute_plan tool call
 */
export async function handleExecutePlan(
  args: ExecutePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const {
    plan: planJson,
    plan_id,
    mode = 'single_step',
    step_number,
    apply_changes = false,
    max_steps = 5,
    stop_on_failure = true,
    additional_context,
  } = args;

  // Resolve plan from JSON or persisted plan ID
  let plan: EnhancedPlanOutput | null = null;

  const workspacePath = typeof serviceClient.getWorkspacePath === 'function'
    ? serviceClient.getWorkspacePath()
    : null;

  if (planJson && typeof planJson === 'string' && planJson.trim().length > 0) {
    try {
      plan = JSON.parse(planJson);
    } catch {
      if (!plan_id && workspacePath) {
        const { PlanPersistenceService } = await import('../services/planPersistenceService.js');
        const service = new PlanPersistenceService(workspacePath);
        plan = await service.loadPlan(planJson.trim());
      }
    }
  }

  if (!plan && plan_id && workspacePath) {
    const { PlanPersistenceService } = await import('../services/planPersistenceService.js');
    const service = new PlanPersistenceService(workspacePath);
    plan = await service.loadPlan(plan_id);
  }

  if (!plan) {
    throw new Error('Plan is required and must be valid JSON or a valid plan_id');
  }

  // Validate mode-specific requirements
  if (mode === 'single_step') {
    validateRequiredNumber(step_number, 'step_number is required when mode is "single_step"');
  }

  const planningService = getPlanningService(serviceClient);
  const startTime = Date.now();
  const stepResults: StepExecutionResult[] = [];

  // Determine which steps to execute based on mode
  let stepsToExecute: number[] = [];

  switch (mode) {
    case 'single_step':
      stepsToExecute = [step_number!];
      break;
    case 'all_ready':
      stepsToExecute = getReadySteps(plan).slice(0, max_steps);
      break;
    case 'full_plan':
      stepsToExecute = plan.dependency_graph?.execution_order?.slice(0, max_steps) ||
        plan.steps.map(s => s.step_number).slice(0, max_steps);
      break;
  }

  if (stepsToExecute.length === 0) {
    return JSON.stringify({
      success: true,
      plan_id: plan.id,
      step_results: [],
      next_ready_steps: getReadySteps(plan),
      progress: calculateProgress(plan, []),
      duration_ms: Date.now() - startTime,
      message: 'No steps to execute',
    }, null, 2);
  }

  // Execute steps - use parallel execution for 'all_ready' mode when steps are independent
  // Note: Even though SearchQueue serializes API calls, parallel execution allows
  // preparation and post-processing to overlap, improving overall throughput
  if (mode === 'all_ready' && stepsToExecute.length > 1) {
    // For all_ready mode, steps have no dependencies on each other, so execute in parallel
    console.error(`[execute_plan] Executing ${stepsToExecute.length} steps in parallel (all_ready mode)`);

    const stepPromises = stepsToExecute.map(stepNum =>
      planningService.executeStep(plan, stepNum, additional_context)
        .catch(error => ({
          step_number: stepNum,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration_ms: 0,
        } as StepExecutionResult))
    );

    const results = await Promise.all(stepPromises);

    // Sort results by step number for consistent ordering
    results.sort((a, b) => a.step_number - b.step_number);
    stepResults.push(...results);

    // Check for failures
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0 && stop_on_failure) {
      console.error(`[execute_plan] ${failedResults.length} step(s) failed in parallel execution`);
    }
  } else {
    // Sequential execution for single_step, full_plan, or single step in all_ready
    for (const stepNum of stepsToExecute) {
      const result = await planningService.executeStep(plan, stepNum, additional_context);
      stepResults.push(result);

      if (!result.success && stop_on_failure) {
        break;
      }
    }
  }

  // Calculate progress
  const completedSteps = stepResults.filter(r => r.success).map(r => r.step_number);
  const progress = calculateProgress(plan, completedSteps);
  const nextReady = getReadySteps(plan, completedSteps);

  const response: ExecutePlanResult = {
    success: stepResults.every(r => r.success),
    plan_id: plan.id,
    step_results: stepResults,
    next_ready_steps: nextReady,
    progress,
    duration_ms: Date.now() - startTime,
  };

  if (!response.success) {
    const failedStep = stepResults.find(r => !r.success);
    response.error = `Step ${failedStep?.step_number} failed: ${failedStep?.error}`;
  }

  // Apply generated changes to files if requested
  if (apply_changes && stepResults.some(r => r.success && r.generated_code?.length)) {
    console.error(`[execute_plan] Applying generated changes to workspace: ${serviceClient.getWorkspacePath()}`);
    const applyResult = await applyGeneratedChanges(stepResults, serviceClient.getWorkspacePath());
    response.files_applied = applyResult.applied;
    response.apply_errors = applyResult.errors;
    response.backups_created = applyResult.backups;

    // If there were apply errors, note them but don't fail the overall response
    // (the step execution itself succeeded)
    if (applyResult.errors.length > 0) {
      console.error(`[execute_plan] File apply had ${applyResult.errors.length} errors`);
    }
  }

  // Format output
  return formatExecutionResult(response, apply_changes);
}

/**
 * Get steps that are ready to execute (all dependencies completed)
 */
function getReadySteps(plan: EnhancedPlanOutput, completedSteps: number[] = []): number[] {
  const completed = new Set(completedSteps);
  const ready: number[] = [];

  for (const step of plan.steps) {
    if (completed.has(step.step_number)) continue;

    const dependsOn = step.depends_on || [];
    const allDepsCompleted = dependsOn.every(dep => completed.has(dep));

    if (allDepsCompleted) {
      ready.push(step.step_number);
    }
  }

  return ready;
}

/**
 * Calculate execution progress
 */
function calculateProgress(plan: EnhancedPlanOutput, completedSteps: number[]): ExecutionProgress {
  const totalSteps = plan.steps.length;
  const completed = completedSteps.length;
  const completedSet = new Set(completedSteps);
  const readySteps = getReadySteps(plan, completedSteps);

  return {
    plan_id: plan.id,
    total_steps: totalSteps,
    completed_steps: completed,
    failed_steps: 0,
    skipped_steps: 0,
    in_progress_steps: 0,
    blocked_steps: totalSteps - completed - readySteps.length,
    ready_steps: readySteps.length,
    pending_steps: totalSteps - completed,
    percentage: totalSteps > 0 ? Math.round((completed / totalSteps) * 100) : 0,
    estimated_remaining: undefined,
  };
}

/**
 * Format execution result for output
 */
function formatExecutionResult(result: ExecutePlanResult, applyChanges: boolean): string {
  let output = `# Plan Execution Result\n\n`;
  output += `**Plan ID:** ${result.plan_id}\n`;
  output += `**Success:** ${result.success ? '✅ Yes' : '❌ No'}\n`;
  output += `**Duration:** ${result.duration_ms}ms\n`;
  output += `**Progress:** ${result.progress.completed_steps}/${result.progress.total_steps} steps (${result.progress.percentage}%)\n\n`;

  if (result.error) {
    output += `## Error\n${result.error}\n\n`;
  }

  output += `## Step Results\n\n`;
  for (const stepResult of result.step_results) {
    output += `### Step ${stepResult.step_number}\n`;
    output += `- **Status:** ${stepResult.success ? '✅ Success' : '❌ Failed'}\n`;
    output += `- **Duration:** ${stepResult.duration_ms}ms\n`;

    if (stepResult.reasoning) {
      output += `- **Reasoning:** ${stepResult.reasoning}\n`;
    }

    if (stepResult.error) {
      output += `- **Error:** ${stepResult.error}\n`;
    }

    if (stepResult.generated_code && stepResult.generated_code.length > 0) {
      output += `\n#### Generated Changes (${applyChanges ? 'Applied' : 'Preview Only'})\n\n`;
      for (const change of stepResult.generated_code) {
        output += `**${change.change_type.toUpperCase()}:** \`${change.path}\`\n`;
        output += `> ${change.explanation}\n\n`;

        if (change.content && !applyChanges) {
          // Show preview of content (first 50 lines)
          const lines = change.content.split('\n');
          const preview = lines.slice(0, 50).join('\n');
          output += '```\n' + preview;
          if (lines.length > 50) {
            output += `\n... (${lines.length - 50} more lines)`;
          }
          output += '\n```\n\n';
        }
      }
    }
    output += '\n';
  }

  // Display applied files information when apply_changes=true
  if (applyChanges) {
    output += `## File Apply Results\n\n`;

    if (result.files_applied && result.files_applied.length > 0) {
      output += `### ✅ Applied Files (${result.files_applied.length})\n`;
      for (const file of result.files_applied) {
        output += `- \`${file}\`\n`;
      }
      output += '\n';
    } else {
      output += `_No files were applied._\n\n`;
    }

    if (result.backups_created && result.backups_created.length > 0) {
      output += `### 📦 Backups Created (${result.backups_created.length})\n`;
      for (const backup of result.backups_created) {
        output += `- \`${backup}\`\n`;
      }
      output += '\n';
    }

    if (result.apply_errors && result.apply_errors.length > 0) {
      output += `### ⚠️ Apply Errors (${result.apply_errors.length})\n`;
      for (const error of result.apply_errors) {
        output += `- ${error}\n`;
      }
      output += '\n';
    }
  }

  if (result.next_ready_steps.length > 0) {
    output += `## Next Ready Steps\n`;
    output += `Steps ready to execute: ${result.next_ready_steps.join(', ')}\n\n`;
  }

  // Include full JSON for programmatic access
  output += `\n---\n\n<details>\n<summary>Full JSON Response</summary>\n\n`;
  output += '```json\n' + JSON.stringify(result, null, 2) + '\n```\n</details>\n';

  return output;
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format a plan result for output
 */
function formatPlanResult(
  result: PlanResult,
  persistence?: { saved: boolean; plan_id?: string; file_path?: string; error?: string }
): string {
  if (!result.plan) {
    return JSON.stringify({
      success: result.success,
      status: result.status,
      error: result.error,
      duration_ms: result.duration_ms,
    }, null, 2);
  }

  const plan = result.plan;

  // Safely extract arrays with defensive checks
  const scope = plan.scope || { included: [], excluded: [] };
  const scopeIncluded = Array.isArray(scope.included) ? scope.included : [];
  const scopeExcluded = Array.isArray(scope.excluded) ? scope.excluded : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const questions = Array.isArray(plan.questions_for_clarification) ? plan.questions_for_clarification : [];
  const depGraph = plan.dependency_graph || { parallel_groups: [], critical_path: [], nodes: [], edges: [], execution_order: [] };
  const parallelGroups = Array.isArray(depGraph.parallel_groups) ? depGraph.parallel_groups : [];
  const criticalPath = Array.isArray(depGraph.critical_path) ? depGraph.critical_path : [];

  // Build a formatted output with both summary and full JSON
  let output = `# Implementation Plan\n\n`;
  output += `**ID:** ${plan.id || 'unknown'}\n`;
  output += `**Version:** ${plan.version || 1}\n`;
  output += `**Status:** ${result.status || 'unknown'}\n`;
  output += `**Confidence:** ${((plan.confidence_score || 0) * 100).toFixed(0)}%\n`;
  output += `**Generated in:** ${result.duration_ms || 0}ms\n`;
  if (persistence) {
    const status = persistence.saved ? '✅ Saved' : '⚠️ Not saved';
    const id = persistence.plan_id || plan.id || 'unknown';
    output += `**Persistence:** ${status} (ID: ${id})\n`;
    if (!persistence.saved && persistence.error) {
      output += `**Save Error:** ${persistence.error}\n`;
    }
    output += '\n';
  } else {
    output += '\n';
  }

  output += `## Goal\n${plan.goal || 'No goal specified'}\n\n`;

  // Scope
  if (scopeIncluded.length > 0) {
    output += `## Scope\n`;
    output += `### Included\n`;
    for (const item of scopeIncluded) {
      output += `- ${item}\n`;
    }
    if (scopeExcluded.length > 0) {
      output += `### Excluded\n`;
      for (const item of scopeExcluded) {
        output += `- ${item}\n`;
      }
    }
    output += '\n';
  }

  // Steps summary
  output += `## Steps (${steps.length} total)\n\n`;
  for (const step of steps) {
    // Safely extract step arrays
    const filesToModify = Array.isArray(step.files_to_modify) ? step.files_to_modify : [];
    const filesToCreate = Array.isArray(step.files_to_create) ? step.files_to_create : [];
    const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];

    const priority = step.priority === 'critical' ? '🔴' :
                     step.priority === 'high' ? '🟠' :
                     step.priority === 'medium' ? '🟡' : '🟢';
    output += `### ${step.step_number || 0}. ${step.title || 'Untitled'} ${priority}\n`;
    output += `${step.description || ''}\n`;
    if (filesToModify.length > 0) {
      output += `- **Modify:** ${filesToModify.map(f => f?.path || 'unknown').join(', ')}\n`;
    }
    if (filesToCreate.length > 0) {
      output += `- **Create:** ${filesToCreate.map(f => f?.path || 'unknown').join(', ')}\n`;
    }
    if (dependsOn.length > 0) {
      output += `- **Depends on:** Step(s) ${dependsOn.join(', ')}\n`;
    }
    output += `- **Effort:** ${step.estimated_effort || 'unknown'}\n\n`;
  }

  // Parallel execution opportunities
  if (parallelGroups.length > 0) {
    output += `## Parallel Execution Opportunities\n`;
    for (const group of parallelGroups) {
      if (Array.isArray(group)) {
        output += `- Steps ${group.join(', ')} can run in parallel\n`;
      }
    }
    output += '\n';
  }

  // Critical path
  if (criticalPath.length > 0) {
    output += `## Critical Path\n`;
    output += `Steps ${criticalPath.join(' → ')}\n\n`;
  }

  // Risks
  if (risks.length > 0) {
    output += `## Risks\n`;
    for (const risk of risks) {
      if (!risk) continue;
      const likelihood = risk.likelihood === 'high' ? '🔴' :
                         risk.likelihood === 'medium' ? '🟠' : '🟢';
      output += `- ${likelihood} **${risk.issue || 'Unknown issue'}**\n`;
      output += `  - Mitigation: ${risk.mitigation || 'None specified'}\n`;
    }
    output += '\n';
  }

  // Questions needing clarification
  if (questions.length > 0) {
    output += `## ⚠️ Questions Needing Clarification\n`;
    for (const q of questions) {
      output += `- ${q}\n`;
    }
    output += '\n';
  }

  // Full JSON at the end for programmatic use
  output += `---\n\n`;
  output += `<details>\n<summary>Full Plan JSON</summary>\n\n`;
  output += '```json\n';
  output += JSON.stringify(plan, null, 2);
  output += '\n```\n</details>\n';

  return output;
}

/**
 * Generate a Gantt diagram from a plan
 */
function generateGanttDiagram(plan: EnhancedPlanOutput): string {
  let mermaid = 'gantt\n';
  mermaid += '    title Implementation Plan\n';
  mermaid += '    dateFormat YYYY-MM-DD\n';
  mermaid += '    excludes weekends\n\n';

  // Safely handle undefined arrays
  const milestones = plan.milestones || [];
  const steps = plan.steps || [];

  // Helper to get safe title
  const getSafeTitle = (step: EnhancedPlanOutput['steps'][0]): string => {
    const title = step.title || `Step ${step.step_number || 'unknown'}`;
    return title.substring(0, 20);
  };

  // Group by milestones if available
  if (milestones.length > 0) {
    for (const milestone of milestones) {
      const milestoneName = milestone.name || 'Milestone';
      mermaid += `    section ${milestoneName}\n`;
      const stepsIncluded = milestone.steps_included || [];
      for (const stepNum of stepsIncluded) {
        const step = steps.find(s => s.step_number === stepNum);
        if (step) {
          const dependsOn = step.depends_on || [];
          const deps = dependsOn.length > 0
            ? `after step${dependsOn[0]}`
            : '';
          mermaid += `    ${getSafeTitle(step)} :step${step.step_number}, ${deps || 'a1'}, 1d\n`;
        }
      }
    }
  } else {
    mermaid += '    section All Steps\n';
    for (const step of steps) {
      const dependsOn = step.depends_on || [];
      const deps = dependsOn.length > 0
        ? `after step${dependsOn[0]}`
        : '';
      mermaid += `    ${getSafeTitle(step)} :step${step.step_number}, ${deps || 'a1'}, 1d\n`;
    }
  }

  return mermaid;
}

// ============================================================================
// Tool Schema Definitions
// ============================================================================

/**
 * Tool schema for create_plan
 */
export const createPlanTool = {
  name: 'create_plan',
  description: `Generate a detailed implementation plan for a software development task.

This tool enters Planning Mode, where it:
1. Analyzes the codebase context relevant to your task
2. Generates a structured, actionable implementation plan
3. Identifies dependencies, risks, and parallelization opportunities
4. Creates architecture diagrams when helpful

**When to use this tool:**
- Before starting a complex feature or refactoring task
- When you need to understand the scope and approach
- To identify potential risks and dependencies upfront
- When coordinating work that touches multiple files

**What you get:**
- Clear goal with scope boundaries
- MVP vs nice-to-have feature breakdown
- Step-by-step implementation guide
- Dependency graph showing what can run in parallel
- Risk assessment with mitigations
- Testing strategy recommendations
- Confidence score and clarifying questions

The plan output includes both a human-readable summary and full JSON for programmatic use.
By default, plans are persisted so they can be executed later via plan_id.`,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task or goal to plan for. Be specific about what you want to accomplish.',
      },
      max_context_files: {
        type: 'number',
        description: 'Maximum number of files to include in context analysis (default: 10)',
        default: 10,
      },
      context_token_budget: {
        type: 'number',
        description: 'Token budget for context retrieval (default: 12000)',
        default: 12000,
      },
      generate_diagrams: {
        type: 'boolean',
        description: 'Generate architecture diagrams in the plan (default: true)',
        default: true,
      },
      mvp_only: {
        type: 'boolean',
        description: 'Focus on MVP features only, excluding nice-to-have (default: false)',
        default: false,
      },
      auto_save: {
        type: 'boolean',
        description: 'Persist the generated plan for later use (default: true)',
        default: true,
      },
      save_name: {
        type: 'string',
        description: 'Optional custom name for the saved plan',
      },
      save_tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for the saved plan',
      },
      save_overwrite: {
        type: 'boolean',
        description: 'Overwrite existing plan with same ID when auto-saving (default: false)',
        default: false,
      },
    },
    required: ['task'],
  },
};

/**
 * Tool schema for refine_plan
 */
export const refinePlanTool = {
  name: 'refine_plan',
  description: `Refine an existing implementation plan based on feedback or clarifications.

Use this tool to iterate on a plan after reviewing it or answering clarifying questions.

**When to use this tool:**
- After reviewing a plan and wanting adjustments
- To answer questions the plan raised
- To add more detail to specific steps
- To change the approach based on new information

**Input:**
- The current plan (JSON from a previous create_plan call)
- Your feedback or clarifications
- Optionally, specific steps to focus on`,
  inputSchema: {
    type: 'object',
    properties: {
      current_plan: {
        type: 'string',
        description: 'The current plan as a JSON string (from the Full Plan JSON output of create_plan)',
      },
      feedback: {
        type: 'string',
        description: 'Your feedback on the current plan - what to change, add, or remove',
      },
      clarifications: {
        type: 'string',
        description: 'Answers to clarifying questions as JSON object (e.g., {"question1": "answer1"})',
      },
      focus_steps: {
        type: 'array',
        items: { type: 'number' },
        description: 'Specific step numbers to focus refinement on',
      },
    },
    required: ['current_plan'],
  },
};

/**
 * Tool schema for visualize_plan
 */
export const visualizePlanTool = {
  name: 'visualize_plan',
  description: `Generate diagrams from an implementation plan.

Use this to visualize the plan's structure in different ways.

**Diagram types:**
- dependencies: Shows step dependencies as a DAG (who blocks whom)
- architecture: Shows the architecture diagram if one was generated
- gantt: Shows steps as a Gantt chart timeline

Returns Mermaid diagram code that can be rendered.`,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The plan as a JSON string',
      },
      diagram_type: {
        type: 'string',
        enum: ['dependencies', 'architecture', 'gantt'],
        description: 'Type of diagram to generate (default: dependencies)',
        default: 'dependencies',
      },
    },
    required: ['plan'],
  },
};

/**
 * Tool schema for execute_plan
 */
export const executePlanTool = {
  name: 'execute_plan',
  description: `Execute steps from an implementation plan, generating code changes.

This tool orchestrates the execution of plan steps, using AI to generate the actual code changes needed for each step.

**Execution Modes:**
- single_step: Execute a specific step by number (requires step_number)
- all_ready: Execute all steps whose dependencies are satisfied
- full_plan: Execute steps in dependency order (respects max_steps limit)

**Output:**
- Generated code changes for each step (preview by default)
- Success/failure status for each step
- Next steps that are ready to execute
- Overall progress tracking

You can pass a saved plan_id instead of the full plan JSON.

**Important:**
- By default, changes are shown as preview only (apply_changes=false)
- Set apply_changes=true to actually write the generated code to files
- Use stop_on_failure=true (default) to halt on first error`,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The plan as a JSON string (from create_plan output). Optional if plan_id is provided.',
      },
      plan_id: {
        type: 'string',
        description: 'Plan ID to load from saved plans (alternative to providing plan JSON)',
      },
      mode: {
        type: 'string',
        enum: ['single_step', 'all_ready', 'full_plan'],
        description: 'Execution mode (default: single_step)',
        default: 'single_step',
      },
      step_number: {
        type: 'number',
        description: 'Step number to execute (required for single_step mode)',
      },
      apply_changes: {
        type: 'boolean',
        description: 'Whether to apply changes to files (default: false - preview only)',
        default: false,
      },
      max_steps: {
        type: 'number',
        description: 'Maximum steps to execute in one call (default: 5)',
        default: 5,
      },
      stop_on_failure: {
        type: 'boolean',
        description: 'Whether to stop on first failure (default: true)',
        default: true,
      },
      additional_context: {
        type: 'string',
        description: 'Additional context to provide to the AI for code generation',
      },
    },
    required: [],
  },
};
