/**
 * Execution Tracking Service
 *
 * Tracks execution state for plans and individual steps.
 * Manages step completion, progress calculation, and dependency resolution.
 */

import {
  EnhancedPlanOutput,
  PlanExecutionState,
  StepExecutionState,
  StepExecutionStatus,
  ExecutionProgress,
  CompleteStepOptions,
  FailStepOptions,
  PlanStatus,
} from '../types/planning.js';

// ============================================================================
// ExecutionTrackingService
// ============================================================================

export class ExecutionTrackingService {
  private executionStates: Map<string, PlanExecutionState> = new Map();

  // ============================================================================
  // State Initialization
  // ============================================================================

  /**
   * Initialize execution state for a plan
   */
  initializeExecution(plan: EnhancedPlanOutput): PlanExecutionState {
    const steps: StepExecutionState[] = plan.steps.map(step => ({
      step_number: step.step_number,
      step_id: step.id,
      status: 'pending' as StepExecutionStatus,
      retry_count: 0,
    }));

    const state: PlanExecutionState = {
      plan_id: plan.id,
      plan_version: plan.version,
      status: 'ready' as PlanStatus,
      steps,
      current_steps: [],
      ready_steps: [],
      blocked_steps: [],
    };

    // Calculate initial ready steps (steps with no dependencies)
    this.updateReadySteps(state, plan);

    this.executionStates.set(plan.id, state);
    return state;
  }

  /**
   * Get execution state for a plan
   */
  getExecutionState(planId: string): PlanExecutionState | undefined {
    return this.executionStates.get(planId);
  }

  /**
   * Check if execution is initialized for a plan
   */
  hasExecutionState(planId: string): boolean {
    return this.executionStates.has(planId);
  }

  // ============================================================================
  // Step State Management
  // ============================================================================

  /**
   * Start a step (mark as in_progress)
   */
  startStep(planId: string, stepNumber: number): StepExecutionState | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;

    const stepState = state.steps.find(s => s.step_number === stepNumber);
    if (!stepState) return null;

    // Can only start pending or ready steps
    if (stepState.status !== 'pending' && stepState.status !== 'ready') {
      return null;
    }

    stepState.status = 'in_progress';
    stepState.started_at = new Date().toISOString();
    
    // Update current steps
    if (!state.current_steps.includes(stepNumber)) {
      state.current_steps.push(stepNumber);
    }
    
    // Remove from ready steps
    state.ready_steps = state.ready_steps.filter(s => s !== stepNumber);
    
    // Update overall status
    if (state.status === 'ready') {
      state.status = 'executing';
      state.started_at = new Date().toISOString();
    }

    return stepState;
  }

  /**
   * Complete a step
   */
  completeStep(
    planId: string,
    stepNumber: number,
    plan: EnhancedPlanOutput,
    options: CompleteStepOptions = {}
  ): StepExecutionState | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;

    const stepState = state.steps.find(s => s.step_number === stepNumber);
    if (!stepState) return null;

    // Calculate duration if started
    if (stepState.started_at) {
      stepState.duration_ms = Date.now() - new Date(stepState.started_at).getTime();
    }

    stepState.status = 'completed';
    stepState.completed_at = new Date().toISOString();
    stepState.notes = options.notes;
    stepState.files_modified = options.files_modified;
    
    // Remove from current steps
    state.current_steps = state.current_steps.filter(s => s !== stepNumber);
    
    // Update ready/blocked steps based on dependencies
    this.updateReadySteps(state, plan);
    
    // Check if all steps complete
    this.updateOverallStatus(state);

    return stepState;
  }

  /**
   * Fail a step
   */
  failStep(
    planId: string,
    stepNumber: number,
    plan: EnhancedPlanOutput,
    options: FailStepOptions
  ): StepExecutionState | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;

    const stepState = state.steps.find(s => s.step_number === stepNumber);
    if (!stepState) return null;

    if (options.retry && stepState.retry_count < 3) {
      // Retry: put back to pending
      stepState.status = 'pending';
      stepState.retry_count++;
      stepState.error = options.error;
    } else if (options.skip) {
      stepState.status = 'skipped';
      stepState.error = options.error;
    } else {
      stepState.status = 'failed';
      stepState.error = options.error;
    }

    // Remove from current steps
    state.current_steps = state.current_steps.filter(s => s !== stepNumber);

    // Handle dependent steps
    if (options.skip_dependents) {
      this.skipDependentSteps(state, stepNumber, plan);
    }

    // Calculate duration if started
    if (stepState.started_at && !stepState.duration_ms) {
      stepState.duration_ms = Date.now() - new Date(stepState.started_at).getTime();
    }
    stepState.completed_at = new Date().toISOString();

    // Update ready/blocked steps
    this.updateReadySteps(state, plan);
    this.updateOverallStatus(state);

    return stepState;
  }

  /**
   * Skip a step
   */
  skipStep(
    planId: string,
    stepNumber: number,
    plan: EnhancedPlanOutput,
    skipDependents: boolean = false
  ): StepExecutionState | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;

    const stepState = state.steps.find(s => s.step_number === stepNumber);
    if (!stepState) return null;

    stepState.status = 'skipped';
    stepState.completed_at = new Date().toISOString();
    stepState.notes = 'Manually skipped';

    if (skipDependents) {
      this.skipDependentSteps(state, stepNumber, plan);
    }

    // Update ready/blocked steps
    this.updateReadySteps(state, plan);
    this.updateOverallStatus(state);

    return stepState;
  }

  // ============================================================================
  // Progress Calculation
  // ============================================================================

  /**
   * Calculate execution progress
   */
  getProgress(planId: string): ExecutionProgress | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;

    const total = state.steps.length;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let inProgress = 0;
    let blocked = 0;
    let ready = 0;
    let pending = 0;

    for (const step of state.steps) {
      switch (step.status) {
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'in_progress':
          inProgress++;
          break;
        case 'blocked':
          blocked++;
          break;
        case 'ready':
          ready++;
          break;
        case 'pending':
          pending++;
          break;
      }
    }

    const percentage = total > 0
      ? Math.round(((completed + skipped) / total) * 100)
      : 0;

    return {
      plan_id: planId,
      total_steps: total,
      completed_steps: completed,
      failed_steps: failed,
      skipped_steps: skipped,
      in_progress_steps: inProgress,
      blocked_steps: blocked,
      ready_steps: ready,
      pending_steps: pending,
      percentage,
    };
  }

  /**
   * Get step state
   */
  getStepState(planId: string, stepNumber: number): StepExecutionState | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;
    return state.steps.find(s => s.step_number === stepNumber) || null;
  }

  /**
   * Get next steps ready for execution
   */
  getReadySteps(planId: string): number[] {
    const state = this.executionStates.get(planId);
    if (!state) return [];
    return [...state.ready_steps];
  }

  /**
   * Get currently executing steps
   */
  getCurrentSteps(planId: string): number[] {
    const state = this.executionStates.get(planId);
    if (!state) return [];
    return [...state.current_steps];
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Update ready and blocked steps based on current state
   */
  private updateReadySteps(state: PlanExecutionState, plan: EnhancedPlanOutput): void {
    const ready: number[] = [];
    const blocked: number[] = [];

    for (const step of state.steps) {
      if (step.status !== 'pending') continue;

      const planStep = plan.steps.find(s => s.step_number === step.step_number);
      if (!planStep) continue;

      // Check if all dependencies are completed or skipped
      const depsComplete = planStep.depends_on.every(depNum => {
        const depState = state.steps.find(s => s.step_number === depNum);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });

      // Check if any dependencies failed
      const depsFailed = planStep.depends_on.some(depNum => {
        const depState = state.steps.find(s => s.step_number === depNum);
        return depState && depState.status === 'failed';
      });

      if (depsFailed) {
        step.status = 'blocked';
        blocked.push(step.step_number);
      } else if (depsComplete) {
        step.status = 'ready';
        ready.push(step.step_number);
      } else {
        blocked.push(step.step_number);
      }
    }

    state.ready_steps = ready;
    state.blocked_steps = blocked;
  }

  /**
   * Update overall plan status
   */
  private updateOverallStatus(state: PlanExecutionState): void {
    const allDone = state.steps.every(
      s => s.status === 'completed' || s.status === 'skipped' || s.status === 'failed'
    );

    if (allDone) {
      const anyFailed = state.steps.some(s => s.status === 'failed');
      state.status = anyFailed ? 'failed' : 'completed';
      state.completed_at = new Date().toISOString();
    }
  }

  /**
   * Skip all steps that depend on a given step
   */
  private skipDependentSteps(
    state: PlanExecutionState,
    stepNumber: number,
    plan: EnhancedPlanOutput
  ): void {
    const planStep = plan.steps.find(s => s.step_number === stepNumber);
    if (!planStep) return;

    for (const blockedNum of planStep.blocks) {
      const blockedState = state.steps.find(s => s.step_number === blockedNum);
      if (blockedState && blockedState.status === 'pending') {
        blockedState.status = 'skipped';
        blockedState.notes = `Skipped due to failure of step ${stepNumber}`;
        blockedState.completed_at = new Date().toISOString();

        // Recursively skip dependents
        this.skipDependentSteps(state, blockedNum, plan);
      }
    }
  }

  /**
   * Reset execution state for a plan
   */
  resetExecution(planId: string, plan: EnhancedPlanOutput): PlanExecutionState | null {
    const existing = this.executionStates.get(planId);
    if (!existing) return null;

    // Reinitialize
    return this.initializeExecution(plan);
  }

  /**
   * Remove execution state for a plan
   */
  removeExecutionState(planId: string): boolean {
    return this.executionStates.delete(planId);
  }

  /**
   * Export execution state to JSON
   */
  exportState(planId: string): string | null {
    const state = this.executionStates.get(planId);
    if (!state) return null;
    return JSON.stringify(state, null, 2);
  }

  /**
   * Import execution state from JSON
   */
  importState(stateJson: string): boolean {
    try {
      const state = JSON.parse(stateJson) as PlanExecutionState;
      this.executionStates.set(state.plan_id, state);
      return true;
    } catch {
      return false;
    }
  }
}

