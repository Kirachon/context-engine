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
// Parallel Execution Types (Phase 2)
// ============================================================================

/**
 * Options for parallel step execution
 */
export interface ParallelExecutionOptions {
  /** Maximum concurrent workers (default: 3) */
  max_workers: number;

  /** Enable parallel execution mode */
  enabled: boolean;

  /** Timeout per step in milliseconds (default: 60000) */
  step_timeout_ms: number;

  /** Maximum retries per step (default: 2) */
  max_retries: number;

  /** Whether to stop all execution on first failure */
  stop_on_failure: boolean;
}

/**
 * Step executor function type
 * The function that actually executes a step and returns the result
 */
export type StepExecutor = (
  planId: string,
  stepNumber: number
) => Promise<{ success: boolean; error?: string; files_modified?: string[] }>;

/**
 * Execution result for a single step
 */
export interface StepExecutionResult {
  step_number: number;
  success: boolean;
  duration_ms: number;
  error?: string;
  files_modified?: string[];
  retries: number;
}

// ============================================================================
// ExecutionTrackingService
// ============================================================================

export class ExecutionTrackingService {
  private executionStates: Map<string, PlanExecutionState> = new Map();

  // ============================================================================
  // Parallel Execution State (Phase 2)
  // ============================================================================

  /** Default options for parallel execution */
  private static readonly DEFAULT_PARALLEL_OPTIONS: ParallelExecutionOptions = {
    max_workers: 3,
    enabled: false,
    step_timeout_ms: 60000,
    max_retries: 2,
    stop_on_failure: true,
  };

  /** Current parallel execution options */
  private parallelOptions: ParallelExecutionOptions = { ...ExecutionTrackingService.DEFAULT_PARALLEL_OPTIONS };

  /** Active worker promises keyed by planId:stepNumber */
  private activeWorkers: Map<string, Promise<StepExecutionResult>> = new Map();

  /** Aborted flag for stopping execution on failure */
  private abortedPlans: Set<string> = new Set();

  // ============================================================================
  // Circuit Breaker State
  // ============================================================================

  /** Circuit breaker state: 'closed' (normal), 'open' (failing), 'half-open' (testing) */
  private circuitBreakerState: 'closed' | 'open' | 'half-open' = 'closed';

  /** Consecutive timeout/failure count for circuit breaker */
  private consecutiveFailures: number = 0;

  /** Consecutive successes count (for half-open state) */
  private consecutiveSuccesses: number = 0;

  /** Timestamp when circuit was opened */
  private circuitOpenedAt: number = 0;

  /** Circuit breaker configuration */
  private circuitBreakerConfig = {
    failureThreshold: 3,      // Open circuit after 3 consecutive failures
    resetTimeout: 60000,      // Try to reset after 1 minute
    successThreshold: 2,      // Close circuit after 2 successes in half-open
    fallbackToSequential: true,
  };

  /** Whether circuit breaker triggered fallback to sequential */
  private circuitBreakerFallbackActive: boolean = false;

  // ============================================================================
  // Memory Management
  // ============================================================================

  /** Default TTL for completed execution states (1 hour) */
  private static readonly DEFAULT_STATE_TTL_MS = 60 * 60 * 1000;

  /** Maximum number of execution states to keep */
  private static readonly MAX_EXECUTION_STATES = 100;

  /** Cleanup timer */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Terminal plan statuses eligible for cleanup */
  private static readonly TERMINAL_STATUSES: PlanStatus[] = ['completed', 'failed'];

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Start periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredStates();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clean up expired execution states.
   * Removes states that have been in terminal status for longer than TTL.
   * Also cleans up orphaned entries in abortedPlans set.
   */
  cleanupExpiredStates(): number {
    const now = Date.now();
    let cleanedCount = 0;

    // First pass: remove states that have exceeded TTL
    for (const [planId, state] of this.executionStates) {
      if (!ExecutionTrackingService.TERMINAL_STATUSES.includes(state.status)) {
        continue;
      }

      if (state.completed_at) {
        const completedTime = new Date(state.completed_at).getTime();
        const age = now - completedTime;

        if (age > ExecutionTrackingService.DEFAULT_STATE_TTL_MS) {
          this.executionStates.delete(planId);
          this.abortedPlans.delete(planId);
          cleanedCount++;
        }
      }
    }

    // Second pass: if still over limit, remove oldest terminal states
    if (this.executionStates.size > ExecutionTrackingService.MAX_EXECUTION_STATES) {
      const terminalStates = Array.from(this.executionStates.entries())
        .filter(([, state]) => ExecutionTrackingService.TERMINAL_STATUSES.includes(state.status))
        .map(([id, state]) => ({
          id,
          completedAt: state.completed_at ? new Date(state.completed_at).getTime() : 0,
        }))
        .sort((a, b) => a.completedAt - b.completedAt); // Oldest first

      const toRemove = this.executionStates.size - ExecutionTrackingService.MAX_EXECUTION_STATES;
      for (let i = 0; i < Math.min(toRemove, terminalStates.length); i++) {
        this.executionStates.delete(terminalStates[i].id);
        this.abortedPlans.delete(terminalStates[i].id);
        cleanedCount++;
      }
    }

    // Third pass: clean up orphaned entries in abortedPlans
    // (entries that no longer have corresponding execution state)
    for (const planId of this.abortedPlans) {
      if (!this.executionStates.has(planId)) {
        this.abortedPlans.delete(planId);
        // Don't increment cleanedCount since this is just an orphaned flag, not a state
      }
    }

    if (cleanedCount > 0) {
      console.error(`[ExecutionTrackingService] Cleaned up ${cleanedCount} expired states, ${this.executionStates.size} remaining`);
    }

    return cleanedCount;
  }

  /**
   * Get the current state count (for monitoring).
   */
  getStateCount(): { total: number; active: number; terminal: number } {
    let active = 0;
    let terminal = 0;
    for (const state of this.executionStates.values()) {
      if (ExecutionTrackingService.TERMINAL_STATUSES.includes(state.status)) {
        terminal++;
      } else {
        active++;
      }
    }
    return { total: this.executionStates.size, active, terminal };
  }

  // ============================================================================
  // State Initialization
  // ============================================================================

  /**
   * Initialize execution state for a plan
   */
  initializeExecution(plan: EnhancedPlanOutput): PlanExecutionState {
    // Safely handle undefined steps array - ensure it's an array before calling map
    const planSteps = Array.isArray(plan.steps) ? plan.steps : [];

    const steps: StepExecutionState[] = planSteps.map(step => ({
      step_number: step.step_number || 0,
      step_id: step.id || `step_${step.step_number || 'unknown'}`,
      status: 'pending' as StepExecutionStatus,
      retry_count: 0,
    }));

    const state: PlanExecutionState = {
      plan_id: plan.id || `plan_${Date.now()}`,
      plan_version: plan.version || 1,
      status: 'ready' as PlanStatus,
      steps,
      current_steps: [],
      ready_steps: [],
      blocked_steps: [],
    };

    // Calculate initial ready steps (steps with no dependencies)
    this.updateReadySteps(state, plan);

    this.executionStates.set(state.plan_id, state);
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

    // Safely handle undefined steps array
    const planSteps = plan.steps || [];

    for (const step of state.steps) {
      if (step.status !== 'pending') continue;

      const planStep = planSteps.find(s => s.step_number === step.step_number);
      if (!planStep) continue;

      // Safely handle undefined depends_on array - ensure it's an array before calling methods
      const dependsOn = Array.isArray(planStep.depends_on) ? planStep.depends_on : [];

      // Check if all dependencies are completed or skipped
      const depsComplete = dependsOn.every(depNum => {
        const depState = state.steps.find(s => s.step_number === depNum);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });

      // Check if any dependencies failed
      const depsFailed = dependsOn.some(depNum => {
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
    // Safely handle undefined steps array
    const steps = plan.steps || [];
    const planStep = steps.find(s => s.step_number === stepNumber);
    if (!planStep) return;

    // Safely handle undefined blocks array - ensure it's an array before iteration
    const blocks = Array.isArray(planStep.blocks) ? planStep.blocks : [];

    for (const blockedNum of blocks) {
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

  // ============================================================================
  // Parallel Execution Methods (Phase 2)
  // ============================================================================

  /**
   * Enable parallel execution mode with optional custom options.
   * Requires REACTIVE_PARALLEL_EXEC=true environment variable.
   * 
   * @param options Partial options to override defaults
   */
  enableParallelExecution(options?: Partial<ParallelExecutionOptions>): void {
    if (process.env.REACTIVE_PARALLEL_EXEC !== 'true') {
      console.error('[ExecutionTrackingService] Parallel execution feature flag not enabled (set REACTIVE_PARALLEL_EXEC=true)');
      return;
    }

    this.parallelOptions = {
      ...ExecutionTrackingService.DEFAULT_PARALLEL_OPTIONS,
      ...options,
      enabled: true,
    };

    console.error(`[ExecutionTrackingService] Parallel execution enabled: max_workers=${this.parallelOptions.max_workers}, timeout=${this.parallelOptions.step_timeout_ms}ms`);
  }

  /**
   * Disable parallel execution mode and reset to defaults.
   */
  disableParallelExecution(): void {
    if (this.parallelOptions.enabled) {
      console.error('[ExecutionTrackingService] Parallel execution disabled');
    }
    this.parallelOptions = { ...ExecutionTrackingService.DEFAULT_PARALLEL_OPTIONS };
  }

  /**
   * Check if parallel execution is currently enabled.
   */
  isParallelExecutionEnabled(): boolean {
    return this.parallelOptions.enabled;
  }

  /**
   * Get the current number of active workers.
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Get parallel execution options (for telemetry).
   */
  getParallelOptions(): Readonly<ParallelExecutionOptions> {
    return { ...this.parallelOptions };
  }

  // ============================================================================
  // Circuit Breaker Methods
  // ============================================================================

  /**
   * Configure the circuit breaker.
   * @param config Partial configuration to merge with defaults
   */
  configureCircuitBreaker(config: Partial<typeof this.circuitBreakerConfig>): void {
    this.circuitBreakerConfig = { ...this.circuitBreakerConfig, ...config };
    console.error(`[ExecutionTrackingService] Circuit breaker configured: ${JSON.stringify(this.circuitBreakerConfig)}`);
  }

  /**
   * Get current circuit breaker state.
   */
  getCircuitBreakerState(): {
    state: 'closed' | 'open' | 'half-open';
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    fallbackActive: boolean;
  } {
    return {
      state: this.circuitBreakerState,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      fallbackActive: this.circuitBreakerFallbackActive,
    };
  }

  /**
   * Record a successful step execution for circuit breaker.
   */
  recordCircuitBreakerSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;

    if (this.circuitBreakerState === 'half-open') {
      if (this.consecutiveSuccesses >= this.circuitBreakerConfig.successThreshold) {
        this.closeCircuit();
      }
    }
  }

  /**
   * Record a failed step execution for circuit breaker.
   * @param isTimeout Whether the failure was due to timeout
   */
  recordCircuitBreakerFailure(isTimeout: boolean = false): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    console.error(`[CircuitBreaker] Failure recorded: count=${this.consecutiveFailures}, isTimeout=${isTimeout}, state=${this.circuitBreakerState}`);

    if (this.circuitBreakerState === 'closed') {
      if (this.consecutiveFailures >= this.circuitBreakerConfig.failureThreshold) {
        this.openCircuit();
      }
    } else if (this.circuitBreakerState === 'half-open') {
      // Any failure in half-open state reopens the circuit
      this.openCircuit();
    }
  }

  /**
   * Check if circuit breaker allows execution.
   * Also handles state transitions from open to half-open.
   */
  isCircuitBreakerAllowing(): boolean {
    if (this.circuitBreakerState === 'closed') {
      return true;
    }

    if (this.circuitBreakerState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= this.circuitBreakerConfig.resetTimeout) {
        this.halfOpenCircuit();
        return true;
      }
      return false;
    }

    // Half-open state - allow limited testing
    return true;
  }

  /**
   * Open the circuit breaker (trigger fallback).
   */
  private openCircuit(): void {
    this.circuitBreakerState = 'open';
    this.circuitOpenedAt = Date.now();
    this.consecutiveSuccesses = 0;

    console.error(`[CircuitBreaker] OPENED after ${this.consecutiveFailures} consecutive failures`);

    if (this.circuitBreakerConfig.fallbackToSequential && this.parallelOptions.enabled) {
      console.error('[CircuitBreaker] Falling back to sequential execution');
      this.circuitBreakerFallbackActive = true;
      // Don't fully disable parallel - just mark fallback active
      // so we can restore after circuit closes
    }
  }

  /**
   * Transition circuit to half-open state.
   */
  private halfOpenCircuit(): void {
    this.circuitBreakerState = 'half-open';
    this.consecutiveSuccesses = 0;
    console.error('[CircuitBreaker] Transitioned to HALF-OPEN state, testing recovery');
  }

  /**
   * Close the circuit breaker (restore normal operation).
   */
  private closeCircuit(): void {
    this.circuitBreakerState = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.circuitBreakerFallbackActive = false;
    console.error('[CircuitBreaker] CLOSED - normal operation restored');
  }

  /**
   * Reset circuit breaker to initial state.
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerState = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.circuitOpenedAt = 0;
    this.circuitBreakerFallbackActive = false;
    console.error('[CircuitBreaker] Reset to initial state');
  }

  /**
   * Check if circuit breaker fallback to sequential is active.
   */
  isCircuitBreakerFallbackActive(): boolean {
    return this.circuitBreakerFallbackActive;
  }

  /**
   * Execute a single step with timeout protection.
   * 
   * @param planId Plan ID
   * @param stepNumber Step number to execute
   * @param executor Function that executes the step
   * @returns Execution result
   */
  async executeStepWithTimeout(
    planId: string,
    stepNumber: number,
    executor: StepExecutor
  ): Promise<StepExecutionResult> {
    const workerKey = `${planId}:${stepNumber}`;
    const startTime = Date.now();
    let retries = 0;

    // Check if execution has been aborted
    if (this.abortedPlans.has(planId)) {
      return {
        step_number: stepNumber,
        success: false,
        duration_ms: 0,
        error: 'Plan execution was aborted',
        retries: 0,
      };
    }

    // Start the step
    this.startStep(planId, stepNumber);

    const executeWithRetry = async (): Promise<StepExecutionResult> => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        // Create timeout promise with clearable timer
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Step ${stepNumber} timed out after ${this.parallelOptions.step_timeout_ms}ms`));
          }, this.parallelOptions.step_timeout_ms);
        });

        // Race between execution and timeout
        const result = await Promise.race([
          executor(planId, stepNumber),
          timeoutPromise,
        ]);

        // Clear timeout since execution completed before timeout
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        const duration = Date.now() - startTime;

        if (result.success) {
          // Record success for circuit breaker
          this.recordCircuitBreakerSuccess();
          return {
            step_number: stepNumber,
            success: true,
            duration_ms: duration,
            files_modified: result.files_modified,
            retries,
          };
        } else {
          // Execution returned failure
          if (retries < this.parallelOptions.max_retries) {
            retries++;
            console.error(`[ExecutionTrackingService] Retrying step ${stepNumber} (attempt ${retries + 1})`);
            return executeWithRetry();
          }
          // Record failure for circuit breaker (non-timeout)
          this.recordCircuitBreakerFailure(false);
          return {
            step_number: stepNumber,
            success: false,
            duration_ms: duration,
            error: result.error || 'Step execution failed',
            retries,
          };
        }
      } catch (error) {
        // Clear timeout on error as well
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimeout = errorMessage.includes('timed out');

        // Retry on non-abort errors
        if (retries < this.parallelOptions.max_retries && !this.abortedPlans.has(planId)) {
          retries++;
          console.error(`[ExecutionTrackingService] Retrying step ${stepNumber} after error: ${errorMessage} (attempt ${retries + 1})`);
          return executeWithRetry();
        }

        // Record failure for circuit breaker (with timeout flag)
        this.recordCircuitBreakerFailure(isTimeout);
        return {
          step_number: stepNumber,
          success: false,
          duration_ms: duration,
          error: errorMessage,
          retries,
        };
      }
    };

    // Track the worker
    const workerPromise = executeWithRetry();
    this.activeWorkers.set(workerKey, workerPromise);

    try {
      const result = await workerPromise;
      return result;
    } finally {
      // Clean up worker tracking
      this.activeWorkers.delete(workerKey);
    }
  }

  /**
   * Execute all ready steps in parallel with worker limit.
   * Continues executing as steps become ready until all are complete or failure occurs.
   * 
   * @param planId Plan ID
   * @param plan The plan being executed
   * @param executor Function that executes each step
   * @returns Array of execution results
   */
  async executeReadyStepsParallel(
    planId: string,
    plan: EnhancedPlanOutput,
    executor: StepExecutor
  ): Promise<StepExecutionResult[]> {
    if (!this.parallelOptions.enabled) {
      console.error('[ExecutionTrackingService] Parallel execution not enabled, falling back to sequential');
      return this.executeStepsSequentially(planId, plan, executor);
    }

    // Check circuit breaker state - fall back to sequential if triggered
    if (this.circuitBreakerFallbackActive) {
      console.error('[ExecutionTrackingService] Circuit breaker fallback active, using sequential execution');
      return this.executeStepsSequentially(planId, plan, executor);
    }

    // Check if circuit breaker allows parallel execution
    if (!this.isCircuitBreakerAllowing()) {
      console.error('[ExecutionTrackingService] Circuit breaker OPEN, using sequential execution');
      return this.executeStepsSequentially(planId, plan, executor);
    }

    const results: StepExecutionResult[] = [];
    const state = this.getExecutionState(planId);
    if (!state) {
      console.error(`[ExecutionTrackingService] No execution state found for plan ${planId}`);
      return results;
    }

    // Clear any previous abort state
    this.abortedPlans.delete(planId);

    const cbState = this.getCircuitBreakerState();
    console.error(`[ExecutionTrackingService] Starting parallel execution for plan ${planId} (circuit breaker: ${cbState.state})`);

    // Process steps until all are complete or aborted
    while (!this.abortedPlans.has(planId)) {
      const readySteps = this.getReadySteps(planId);

      if (readySteps.length === 0) {
        // Check if there are still running workers
        if (this.activeWorkers.size === 0) {
          break; // All done
        }
        // Wait for at least one worker to complete
        await Promise.race(Array.from(this.activeWorkers.values()));
        continue;
      }

      // Limit steps to max_workers
      const availableSlots = this.parallelOptions.max_workers - this.activeWorkers.size;
      if (availableSlots <= 0) {
        // Wait for a slot to free up
        await Promise.race(Array.from(this.activeWorkers.values()));
        continue;
      }

      const stepsToExecute = readySteps.slice(0, availableSlots);
      console.error(`[ExecutionTrackingService] Executing ${stepsToExecute.length} steps in parallel: [${stepsToExecute.join(', ')}]`);

      // Start all steps in parallel
      const stepPromises = stepsToExecute.map(stepNumber =>
        this.executeStepWithTimeout(planId, stepNumber, executor)
          .then(result => {
            // Update plan state based on result
            if (result.success) {
              this.completeStep(planId, stepNumber, plan, {
                files_modified: result.files_modified,
                notes: `Completed in ${result.duration_ms}ms with ${result.retries} retries`,
              });
            } else {
              this.failStep(planId, stepNumber, plan, {
                error: result.error || 'Unknown error',
                skip_dependents: this.parallelOptions.stop_on_failure,
              });

              // Abort if stop_on_failure is enabled
              if (this.parallelOptions.stop_on_failure) {
                this.abortPlanExecution(planId);
              }
            }
            results.push(result);
            return result;
          })
      );

      // Wait for this batch to complete (at least one)
      await Promise.race(stepPromises);
    }

    // Wait for any remaining workers to complete
    if (this.activeWorkers.size > 0) {
      console.error(`[ExecutionTrackingService] Waiting for ${this.activeWorkers.size} remaining workers`);
      await Promise.all(Array.from(this.activeWorkers.values()));
    }

    console.error(`[ExecutionTrackingService] Parallel execution completed: ${results.length} steps executed`);
    return results;
  }

  /**
   * Fallback sequential execution when parallel is disabled.
   */
  private async executeStepsSequentially(
    planId: string,
    plan: EnhancedPlanOutput,
    executor: StepExecutor
  ): Promise<StepExecutionResult[]> {
    const results: StepExecutionResult[] = [];

    while (true) {
      const readySteps = this.getReadySteps(planId);
      if (readySteps.length === 0) break;

      const stepNumber = readySteps[0];
      const result = await this.executeStepWithTimeout(planId, stepNumber, executor);

      if (result.success) {
        this.completeStep(planId, stepNumber, plan, {
          files_modified: result.files_modified,
        });
      } else {
        this.failStep(planId, stepNumber, plan, {
          error: result.error || 'Unknown error',
        });
        break; // Stop on failure in sequential mode
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Abort execution for a plan (stops all pending steps).
   */
  abortPlanExecution(planId: string): void {
    console.error(`[ExecutionTrackingService] Aborting execution for plan ${planId}`);
    this.abortedPlans.add(planId);
  }

  /**
   * Check if execution has been aborted for a plan.
   */
  isExecutionAborted(planId: string): boolean {
    return this.abortedPlans.has(planId);
  }

  /**
   * Clear abort state for a plan (allows resumption).
   */
  clearAbortState(planId: string): void {
    this.abortedPlans.delete(planId);
  }
}

