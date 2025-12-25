/**
 * Reactive Review Service
 *
 * Phase 2: Thin coordinator that orchestrates existing services
 * for reactive PR code reviews.
 *
 * This service ties together:
 * - ContextServiceClient (for semantic search with commit-aware caching)
 * - PlanningService (for dependency analysis and parallel groups)
 * - ExecutionTrackingService (for parallel step execution)
 * - CodeReviewService (for actual review generation)
 */

import * as crypto from 'crypto';
import { ContextServiceClient } from '../mcp/serviceClient.js';
import { PlanningService } from '../mcp/services/planningService.js';
import { ExecutionTrackingService, StepExecutor, StepExecutionResult } from '../mcp/services/executionTrackingService.js';
import { PlanPersistenceService } from '../mcp/services/planPersistenceService.js';
import { EnhancedPlanOutput } from '../mcp/types/planning.js';
import {
    PRMetadata,
    ReviewSession,
    ReviewSessionStatus,
    ReviewStatus,
    getConfig,
    calculateAdaptiveTimeout,
    getCircuitBreakerConfig,
    getChunkedProcessingConfig,
    splitIntoChunks,
} from './index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for starting a reactive review
 */
export interface StartReviewOptions {
    /** Token budget for the review */
    token_budget?: number;

    /** Maximum parallel workers */
    max_workers?: number;

    /** Enable verbose logging */
    verbose?: boolean;
}

/**
 * Review findings aggregated from the review process
 */
export interface ReviewFindings {
    total_findings: number;
    by_severity: {
        critical: number;
        high: number;
        medium: number;
        low: number;
    };
    by_file: Map<string, number>;
}

// ============================================================================
// ReactiveReviewService
// ============================================================================

export class ReactiveReviewService {
    /** Active review sessions keyed by session_id */
    private sessions: Map<string, ReviewSession> = new Map();

    /** Associated plans for each session */
    private sessionPlans: Map<string, EnhancedPlanOutput> = new Map();

    /** Findings count per session */
    private sessionFindings: Map<string, number> = new Map();

    /** Session telemetry start times */
    private sessionStartTimes: Map<string, number> = new Map();

    /** Tokens used per session */
    private sessionTokensUsed: Map<string, number> = new Map();

    /** Last activity time for each session (for zombie detection) */
    private sessionLastActivity: Map<string, number> = new Map();

    /** Adaptive timeouts calculated per session based on file count */
    private sessionAdaptiveTimeouts: Map<string, number> = new Map();

    /** Cleanup timer for expired sessions */
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    /** Terminal session states that are eligible for cleanup */
    private static readonly TERMINAL_STATES: ReviewSessionStatus[] = ['completed', 'failed', 'cancelled'];

    /** Active session states that should be monitored for zombies */
    private static readonly ACTIVE_STATES: ReviewSessionStatus[] = ['initializing', 'analyzing', 'executing'];

    /** Plan persistence service for saving/loading plans to disk */
    private persistenceService: PlanPersistenceService | null = null;

    constructor(
        private contextClient: ContextServiceClient,
        private planningService: PlanningService,
        private executionService: ExecutionTrackingService,
        persistenceService?: PlanPersistenceService
    ) {
        // Store persistence service if provided
        this.persistenceService = persistenceService || null;

        // Start periodic cleanup (every 5 minutes)
        this.startCleanupTimer();
    }

    /**
     * Set the plan persistence service (for lazy initialization).
     */
    setPersistenceService(service: PlanPersistenceService): void {
        this.persistenceService = service;
    }

    /**
     * Start the periodic cleanup timer for expired sessions.
     */
    private startCleanupTimer(): void {
        const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpiredSessions();
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
     * Clean up expired sessions based on TTL and max session limits.
     * Also detects and cleans up zombie sessions (stuck in active state).
     */
    cleanupExpiredSessions(): number {
        const config = getConfig();
        const now = Date.now();
        let cleanedCount = 0;
        let zombieCount = 0;

        // First pass: detect and clean up zombie sessions
        for (const [sessionId, session] of this.sessions) {
            // Check for zombie sessions (active but with orphaned/missing plan)
            if (this.isZombieSession(sessionId, session)) {
                session.status = 'failed';
                session.error = 'Session became orphaned: plan or execution state missing';
                session.updated_at = new Date().toISOString();
                zombieCount++;
                console.error(`[ReactiveReviewService] Marked zombie session ${sessionId} as failed`);
                continue;
            }

            // Check for execution timeout (sessions stuck in active states too long)
            if (ReactiveReviewService.ACTIVE_STATES.includes(session.status)) {
                const lastActivity = this.sessionLastActivity.get(sessionId) || this.sessionStartTimes.get(sessionId) || 0;
                const inactiveTime = now - lastActivity;

                // Use adaptive timeout if available, otherwise fall back to config default
                const adaptiveTimeout = this.sessionAdaptiveTimeouts.get(sessionId);
                const effectiveTimeout = adaptiveTimeout || config.session_execution_timeout_ms;

                if (inactiveTime > effectiveTimeout) {
                    session.status = 'failed';
                    session.error = `Session execution timeout: no activity for ${Math.round(inactiveTime / 1000)}s (limit: ${Math.round(effectiveTimeout / 1000)}s${adaptiveTimeout ? ' adaptive' : ''})`;
                    session.updated_at = new Date().toISOString();
                    zombieCount++;
                    console.error(`[ReactiveReviewService] Session ${sessionId} timed out after ${Math.round(inactiveTime / 1000)}s of inactivity (adaptive timeout: ${adaptiveTimeout ? Math.round(adaptiveTimeout / 1000) + 's' : 'not set'})`);

                    // Clean up associated resources
                    this.contextClient.disableCommitCache();
                    if (session.plan_id) {
                        this.executionService.abortPlanExecution(session.plan_id);
                    }
                }
            }
        }

        // Second pass: remove terminal sessions that have exceeded TTL
        for (const [sessionId, session] of this.sessions) {
            if (!ReactiveReviewService.TERMINAL_STATES.includes(session.status)) {
                continue; // Only clean up terminal sessions
            }

            const startTime = this.sessionStartTimes.get(sessionId) || 0;
            const age = now - startTime;

            if (age > config.session_ttl_ms) {
                this.removeSession(sessionId);
                cleanedCount++;
            }
        }

        // Third pass: if still over max_sessions, remove oldest terminal sessions
        if (this.sessions.size > config.max_sessions) {
            const terminalSessions = Array.from(this.sessions.entries())
                .filter(([, session]) => ReactiveReviewService.TERMINAL_STATES.includes(session.status))
                .map(([id]) => ({
                    id,
                    startTime: this.sessionStartTimes.get(id) || 0,
                }))
                .sort((a, b) => a.startTime - b.startTime); // Oldest first

            const toRemove = this.sessions.size - config.max_sessions;
            for (let i = 0; i < Math.min(toRemove, terminalSessions.length); i++) {
                this.removeSession(terminalSessions[i].id);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0 || zombieCount > 0) {
            console.error(`[ReactiveReviewService] Cleanup: ${cleanedCount} expired, ${zombieCount} zombies handled, ${this.sessions.size} remaining`);
        }

        return cleanedCount + zombieCount;
    }

    /**
     * Remove a session and all its associated data.
     */
    private removeSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        this.sessionPlans.delete(sessionId);
        this.sessionFindings.delete(sessionId);
        this.sessionStartTimes.delete(sessionId);
        this.sessionTokensUsed.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
        this.sessionAdaptiveTimeouts.delete(sessionId);
    }

    /**
     * Update the last activity time for a session.
     */
    private touchSession(sessionId: string): void {
        this.sessionLastActivity.set(sessionId, Date.now());
    }

    /**
     * Check if a session is a zombie (stuck in active state with missing or orphaned plan).
     * This is the synchronous version used in cleanup - doesn't attempt disk recovery.
     */
    private isZombieSession(sessionId: string, session: ReviewSession): boolean {
        // Only check active states
        if (!ReactiveReviewService.ACTIVE_STATES.includes(session.status)) {
            return false;
        }

        // Check if the session has a plan_id but no corresponding plan in memory
        // Note: This doesn't check disk - use isZombieSessionAsync for disk recovery
        if (session.plan_id && !this.sessionPlans.has(sessionId)) {
            // If we have persistence service, don't immediately mark as zombie
            // The async version will attempt recovery
            if (this.persistenceService) {
                console.error(`[ReactiveReviewService] Session ${sessionId} has plan_id ${session.plan_id} but no plan in memory - may be recoverable from disk`);
                return false; // Let async recovery handle it
            }
            console.error(`[ReactiveReviewService] Zombie detected: Session ${sessionId} has plan_id ${session.plan_id} but no plan in memory (no persistence service)`);
            return true;
        }

        // Check if execution state exists for executing sessions
        if (session.status === 'executing' && session.plan_id) {
            const execState = this.executionService.getExecutionState(session.plan_id);
            if (!execState) {
                console.error(`[ReactiveReviewService] Zombie detected: Session ${sessionId} is executing but no execution state for plan ${session.plan_id}`);
                return true;
            }
        }

        return false;
    }

    /**
     * Async version of zombie check that attempts to recover plan from disk.
     * Returns true if session is a zombie that couldn't be recovered.
     */
    private async isZombieSessionAsync(sessionId: string, session: ReviewSession): Promise<boolean> {
        // Only check active states
        if (!ReactiveReviewService.ACTIVE_STATES.includes(session.status)) {
            return false;
        }

        // Check if the session has a plan_id but no corresponding plan
        if (session.plan_id && !this.sessionPlans.has(sessionId)) {
            // Attempt to recover from disk
            if (this.persistenceService) {
                console.error(`[ReactiveReviewService] Attempting to recover plan ${session.plan_id} from disk for session ${sessionId}`);
                const loadedPlan = await this.persistenceService.loadPlan(session.plan_id);
                if (loadedPlan) {
                    this.sessionPlans.set(sessionId, loadedPlan);
                    console.error(`[ReactiveReviewService] Successfully recovered plan ${session.plan_id} from disk`);
                    // Plan recovered, not a zombie
                } else {
                    console.error(`[ReactiveReviewService] Zombie detected: Session ${sessionId} has plan_id ${session.plan_id} but plan not found on disk`);
                    return true;
                }
            } else {
                console.error(`[ReactiveReviewService] Zombie detected: Session ${sessionId} has plan_id ${session.plan_id} but no plan in memory (no persistence service)`);
                return true;
            }
        }

        // Check if execution state exists for executing sessions
        if (session.status === 'executing' && session.plan_id) {
            const execState = this.executionService.getExecutionState(session.plan_id);
            if (!execState) {
                console.error(`[ReactiveReviewService] Zombie detected: Session ${sessionId} is executing but no execution state for plan ${session.plan_id}`);
                return true;
            }
        }

        return false;
    }

    /**
     * Get the current number of sessions (for monitoring).
     */
    getSessionCount(): { total: number; active: number; terminal: number } {
        let active = 0;
        let terminal = 0;
        for (const session of this.sessions.values()) {
            if (ReactiveReviewService.TERMINAL_STATES.includes(session.status)) {
                terminal++;
            } else {
                active++;
            }
        }
        return { total: this.sessions.size, active, terminal };
    }

    // ============================================================================
    // Session Management
    // ============================================================================

    /**
     * Start a new reactive review session for a PR.
     * 
     * @param prMetadata PR metadata including changed files
     * @param options Optional configuration
     * @returns New review session
     */
    async startReactiveReview(
        prMetadata: PRMetadata,
        options: StartReviewOptions = {}
    ): Promise<ReviewSession> {
        const config = getConfig();

        // Validate feature flag
        if (!config.enabled) {
            throw new Error('Reactive mode is disabled (set REACTIVE_ENABLED=true)');
        }

        const sessionId = crypto.randomUUID();
        const now = new Date().toISOString();

        // Create initial session
        const session: ReviewSession = {
            session_id: sessionId,
            plan_id: '', // Will be set after plan creation
            status: 'initializing',
            pr_metadata: prMetadata,
            created_at: now,
            updated_at: now,
        };

        const startTime = Date.now();
        this.sessions.set(sessionId, session);
        this.sessionStartTimes.set(sessionId, startTime);
        this.sessionLastActivity.set(sessionId, startTime);
        this.sessionTokensUsed.set(sessionId, 0);
        this.sessionFindings.set(sessionId, 0);

        console.error(`[ReactiveReviewService] Starting review session ${sessionId} for commit ${prMetadata.commit_hash.substring(0, 12)}`);

        // Track if commit cache was enabled so we can clean up on error
        let commitCacheEnabled = false;

        try {
            // Enable commit-aware caching
            if (config.commit_cache) {
                this.contextClient.enableCommitCache(prMetadata.commit_hash);
                commitCacheEnabled = true;

                // Prefetch context for changed files
                if (prMetadata.changed_files.length > 0) {
                    this.contextClient.prefetchFilesContext(prMetadata.changed_files, prMetadata.commit_hash);
                }
            }

            // Update status and activity
            session.status = 'analyzing';
            session.updated_at = new Date().toISOString();
            this.touchSession(sessionId);

            // Create a review plan using the planning service
            const plan = await this.createReviewPlan(prMetadata, options);

            // Validate plan was created successfully with a valid ID
            const planId = plan.id || sessionId;
            if (!plan || !planId) {
                throw new Error('Plan creation failed: no valid plan ID generated');
            }

            // Ensure plan has the ID set
            plan.id = planId;
            session.plan_id = planId;
            session.total_steps = plan.steps?.length || 0;

            // Store plan in memory
            this.sessionPlans.set(sessionId, plan);

            // Persist plan to disk if persistence service is available
            if (this.persistenceService) {
                const persistResult = await this.persistenceService.savePlan(plan, {
                    name: `Review: ${prMetadata.commit_hash.substring(0, 12)}`,
                    tags: ['reactive-review', `commit:${prMetadata.commit_hash.substring(0, 12)}`],
                    overwrite: true, // Allow overwrite if plan ID already exists
                });

                if (!persistResult.success) {
                    console.error(`[ReactiveReviewService] Warning: Failed to persist plan ${planId}: ${persistResult.error}`);
                    // Continue anyway - plan is still in memory
                } else {
                    console.error(`[ReactiveReviewService] Plan ${planId} persisted to ${persistResult.file_path}`);
                }
            }

            this.touchSession(sessionId);

            // Initialize execution tracking
            const execState = this.executionService.initializeExecution(plan);

            // Verify execution state was created
            if (!execState) {
                throw new Error(`Failed to initialize execution state for plan ${planId}`);
            }

            // Double-check execution state is retrievable
            const verifyState = this.executionService.getExecutionState(planId);
            if (!verifyState) {
                throw new Error(`Execution state not found after initialization for plan ${planId}`);
            }

            // Calculate adaptive timeout based on file count
            const fileCount = prMetadata.changed_files.length;
            const adaptiveTimeout = calculateAdaptiveTimeout({
                fileCount,
                avgTimePerFile: config.step_timeout_ms, // Use step timeout as baseline
                bufferMultiplier: 1.5,
                minTimeout: config.session_execution_timeout_ms,
            });

            console.error(`[ReactiveReviewService] Adaptive timeout calculated: ${Math.round(adaptiveTimeout/1000)}s for ${fileCount} files`);

            // Configure circuit breaker for resilience
            const cbConfig = getCircuitBreakerConfig();
            this.executionService.configureCircuitBreaker(cbConfig);

            // Enable parallel execution if configured
            if (config.parallel_exec) {
                this.executionService.enableParallelExecution({
                    max_workers: options.max_workers || config.max_workers,
                    step_timeout_ms: config.step_timeout_ms,
                    max_retries: config.max_retries,
                });
            }

            // Update session status
            session.status = 'executing';
            session.updated_at = new Date().toISOString();
            this.touchSession(sessionId);

            // Store adaptive timeout for session monitoring
            this.sessionAdaptiveTimeouts.set(sessionId, adaptiveTimeout);

            console.error(`[ReactiveReviewService] Review plan created with ${session.total_steps} steps, plan_id=${planId}, adaptive_timeout=${Math.round(adaptiveTimeout/1000)}s`);

            return session;
        } catch (error) {
            // Clean up commit cache if it was enabled
            if (commitCacheEnabled) {
                this.contextClient.disableCommitCache();
            }
            session.status = 'failed';
            session.error = error instanceof Error ? error.message : String(error);
            session.updated_at = new Date().toISOString();
            console.error(`[ReactiveReviewService] Failed to start review: ${session.error}`);
            throw error;
        }
    }

    /**
     * Execute the review plan for a session.
     *
     * @param sessionId Session ID
     * @param stepExecutor Custom step executor function
     */
    async executeReview(
        sessionId: string,
        stepExecutor: StepExecutor
    ): Promise<StepExecutionResult[]> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        let plan = this.sessionPlans.get(sessionId);

        // Try to recover plan from disk if not in memory
        if (!plan && session.plan_id && this.persistenceService) {
            console.error(`[ReactiveReviewService] Plan not in memory, attempting to load from disk: ${session.plan_id}`);
            const loadedPlan = await this.persistenceService.loadPlan(session.plan_id);
            if (loadedPlan) {
                plan = loadedPlan;
                this.sessionPlans.set(sessionId, plan);
                console.error(`[ReactiveReviewService] Successfully recovered plan ${session.plan_id} from disk`);
            }
        }

        if (!plan) {
            // Mark as failed if plan is missing (zombie prevention)
            session.status = 'failed';
            session.error = 'Plan not found in memory or on disk - session may have become orphaned';
            session.updated_at = new Date().toISOString();
            throw new Error(`No plan found for session: ${sessionId} (plan may have been evicted or failed to persist)`);
        }

        if (session.status !== 'executing') {
            throw new Error(`Session is not in executing state: ${session.status}`);
        }

        // Verify execution state exists before proceeding
        const execState = this.executionService.getExecutionState(session.plan_id);
        if (!execState) {
            session.status = 'failed';
            session.error = 'Execution state not found - session may have become orphaned';
            session.updated_at = new Date().toISOString();
            throw new Error(`Execution state not found for plan ${session.plan_id} (zombie session detected)`);
        }

        // Track activity at start of execution
        this.touchSession(sessionId);

        try {
            // Create a wrapped executor that tracks activity
            const wrappedExecutor: StepExecutor = async (step, context) => {
                this.touchSession(sessionId);
                const result = await stepExecutor(step, context);
                this.touchSession(sessionId);
                return result;
            };

            // Execute steps (parallel or sequential based on config)
            const results = await this.executionService.executeReadyStepsParallel(
                session.plan_id,
                plan,
                wrappedExecutor
            );

            // Track activity after execution
            this.touchSession(sessionId);

            // Update session based on results
            const allSucceeded = results.every(r => r.success);
            session.status = allSucceeded ? 'completed' : 'failed';
            session.updated_at = new Date().toISOString();

            return results;
        } catch (error) {
            session.status = 'failed';
            session.error = error instanceof Error ? error.message : String(error);
            session.updated_at = new Date().toISOString();
            throw error;
        } finally {
            // Always clean up commit cache, whether success or failure
            this.contextClient.disableCommitCache();
        }
    }

    /**
     * Execute review with chunked processing for large PRs.
     * Splits files into chunks and processes them with delays between chunks.
     *
     * @param sessionId Session ID
     * @param stepExecutor Custom step executor function
     * @returns Array of execution results from all chunks
     */
    async executeReviewChunked(
        sessionId: string,
        stepExecutor: StepExecutor
    ): Promise<StepExecutionResult[]> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        const chunkedConfig = getChunkedProcessingConfig();
        const fileCount = session.pr_metadata.changed_files.length;

        // If chunking not needed, use regular execution
        if (!chunkedConfig.enabled || fileCount <= chunkedConfig.chunkThreshold) {
            console.error(`[ReactiveReviewService] Chunking not needed for ${fileCount} files (threshold: ${chunkedConfig.chunkThreshold})`);
            return this.executeReview(sessionId, stepExecutor);
        }

        console.error(`[ReactiveReviewService] Executing chunked review: ${fileCount} files in chunks of ${chunkedConfig.chunkSize}`);

        // Split files into chunks
        const fileChunks = splitIntoChunks(session.pr_metadata.changed_files, chunkedConfig);
        const allResults: StepExecutionResult[] = [];

        for (let i = 0; i < fileChunks.length; i++) {
            const chunk = fileChunks[i];
            const isLastChunk = i === fileChunks.length - 1;

            console.error(`[ReactiveReviewService] Processing chunk ${i + 1}/${fileChunks.length}: ${chunk.length} files`);

            // Execute this chunk
            const chunkResults = await this.executeReview(sessionId, stepExecutor);
            allResults.push(...chunkResults);

            // Add delay between chunks (unless it's the last one)
            if (!isLastChunk && chunkedConfig.interChunkDelay > 0) {
                console.error(`[ReactiveReviewService] Waiting ${chunkedConfig.interChunkDelay}ms before next chunk`);
                await new Promise(resolve => setTimeout(resolve, chunkedConfig.interChunkDelay));
            }

            // Check if session failed during chunk execution
            const updatedSession = this.sessions.get(sessionId);
            if (updatedSession?.status === 'failed') {
                console.error(`[ReactiveReviewService] Session failed during chunk ${i + 1}, stopping`);
                break;
            }
        }

        return allResults;
    }

    /**
     * Get circuit breaker status from the execution service.
     */
    getCircuitBreakerStatus(): {
        state: 'closed' | 'open' | 'half-open';
        consecutiveFailures: number;
        consecutiveSuccesses: number;
        fallbackActive: boolean;
    } {
        return this.executionService.getCircuitBreakerState();
    }

    /**
     * Reset the circuit breaker to initial state.
     */
    resetCircuitBreaker(): void {
        this.executionService.resetCircuitBreaker();
    }

    /**
     * Get the current status of a review session.
     * Also checks for zombie state and updates session if detected.
     * Note: This is the sync version - use getReviewStatusAsync for plan recovery.
     */
    getReviewStatus(sessionId: string): ReviewStatus | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        // Check for zombie state when getting status (sync version - no disk recovery)
        if (this.isZombieSession(sessionId, session)) {
            session.status = 'failed';
            session.error = 'Session became orphaned: plan or execution state missing';
            session.updated_at = new Date().toISOString();
            console.error(`[ReactiveReviewService] Zombie session ${sessionId} detected during status check`);
        }

        return this.buildReviewStatus(sessionId, session);
    }

    /**
     * Get the current status of a review session with async plan recovery.
     * Attempts to recover plans from disk before marking as zombie.
     */
    async getReviewStatusAsync(sessionId: string): Promise<ReviewStatus | null> {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        // Check for zombie state with async recovery attempt
        if (await this.isZombieSessionAsync(sessionId, session)) {
            session.status = 'failed';
            session.error = 'Session became orphaned: plan or execution state missing (recovery failed)';
            session.updated_at = new Date().toISOString();
            console.error(`[ReactiveReviewService] Zombie session ${sessionId} detected during async status check`);
        }

        return this.buildReviewStatus(sessionId, session);
    }

    /**
     * Get the plan associated with a session.
     * Returns undefined if the session or plan is not found.
     */
    getSessionPlan(sessionId: string): EnhancedPlanOutput | undefined {
        return this.sessionPlans.get(sessionId);
    }

    /**
     * Build the ReviewStatus object from session data.
     */
    private buildReviewStatus(sessionId: string, session: ReviewSession): ReviewStatus {
        const progress = this.executionService.getProgress(session.plan_id);
        const startTime = this.sessionStartTimes.get(sessionId) || Date.now();
        const tokensUsed = this.sessionTokensUsed.get(sessionId) || 0;
        const findingsCount = this.sessionFindings.get(sessionId) || 0;
        const lastActivity = this.sessionLastActivity.get(sessionId) || startTime;

        // Get cache stats for hit rate
        const cacheStats = this.contextClient.getCacheStats();

        // Calculate if session appears stalled (no activity for 2+ minutes)
        const inactiveMs = Date.now() - lastActivity;
        const appearsStalled = ReactiveReviewService.ACTIVE_STATES.includes(session.status) && inactiveMs > 120000;

        return {
            session,
            progress: progress ? {
                completed_steps: progress.completed_steps,
                total_steps: progress.total_steps,
                percentage: progress.percentage,
            } : {
                completed_steps: 0,
                total_steps: session.total_steps || 0,
                percentage: 0,
            },
            telemetry: {
                start_time: new Date(startTime).toISOString(),
                elapsed_ms: Date.now() - startTime,
                tokens_used: tokensUsed,
                cache_hit_rate: cacheStats.hitRate,
                last_activity_ms: inactiveMs,
                appears_stalled: appearsStalled,
            },
            findings_count: findingsCount,
        };
    }

    /**
     * Pause a review session at the next checkpoint.
     */
    async pauseReview(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        if (session.status !== 'executing') {
            throw new Error(`Cannot pause session in state: ${session.status}`);
        }

        // Abort execution (will stop after current step completes)
        this.executionService.abortPlanExecution(session.plan_id);

        session.status = 'paused';
        session.updated_at = new Date().toISOString();

        console.error(`[ReactiveReviewService] Paused review session ${sessionId}`);
    }

    /**
     * Resume a paused review session.
     */
    async resumeReview(sessionId: string, stepExecutor: StepExecutor): Promise<StepExecutionResult[]> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        if (session.status !== 'paused') {
            throw new Error(`Cannot resume session in state: ${session.status}`);
        }

        let plan = this.sessionPlans.get(sessionId);

        // Try to recover plan from disk if not in memory
        if (!plan && session.plan_id && this.persistenceService) {
            console.error(`[ReactiveReviewService] Plan not in memory for resume, attempting to load from disk: ${session.plan_id}`);
            const loadedPlan = await this.persistenceService.loadPlan(session.plan_id);
            if (loadedPlan) {
                plan = loadedPlan;
                this.sessionPlans.set(sessionId, plan);
                console.error(`[ReactiveReviewService] Successfully recovered plan ${session.plan_id} from disk for resume`);
            }
        }

        if (!plan) {
            throw new Error(`No plan found for session: ${sessionId} (not in memory or on disk)`);
        }

        // Clear abort state and resume
        this.executionService.clearAbortState(session.plan_id);

        session.status = 'executing';
        session.updated_at = new Date().toISOString();

        console.error(`[ReactiveReviewService] Resuming review session ${sessionId}`);

        return this.executeReview(sessionId, stepExecutor);
    }

    /**
     * Cancel a review session.
     */
    cancelReview(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        this.executionService.abortPlanExecution(session.plan_id);

        session.status = 'cancelled';
        session.updated_at = new Date().toISOString();

        // Clean up
        this.contextClient.disableCommitCache();

        console.error(`[ReactiveReviewService] Cancelled review session ${sessionId}`);
    }

    /**
     * Get a session by ID.
     */
    getSession(sessionId: string): ReviewSession | null {
        return this.sessions.get(sessionId) || null;
    }

    /**
     * List all active sessions.
     */
    listSessions(status?: ReviewSessionStatus): ReviewSession[] {
        const sessions = Array.from(this.sessions.values());
        if (status) {
            return sessions.filter(s => s.status === status);
        }
        return sessions;
    }

    /**
     * Record tokens used for a session.
     */
    recordTokensUsed(sessionId: string, tokens: number): void {
        const current = this.sessionTokensUsed.get(sessionId) || 0;
        this.sessionTokensUsed.set(sessionId, current + tokens);
    }

    /**
     * Increment findings count for a session.
     */
    recordFinding(sessionId: string): void {
        const current = this.sessionFindings.get(sessionId) || 0;
        this.sessionFindings.set(sessionId, current + 1);
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    /**
     * Create a review plan from PR metadata.
     */
    private async createReviewPlan(
        prMetadata: PRMetadata,
        options: StartReviewOptions
    ): Promise<EnhancedPlanOutput> {
        // Build a task description from PR metadata
        const taskDescription = this.buildReviewTaskDescription(prMetadata);

        // Use the planning service to generate a plan
        const planResult = await this.planningService.generatePlan(taskDescription, {
            context_token_budget: options.token_budget || getConfig().token_budget,
            mvp_only: true, // Focus on core review tasks
            generate_diagrams: false, // Skip diagrams for speed
        });

        // Extract the plan from the result
        const plan = planResult.plan;

        // Mark as a reactive plan with context metadata
        return {
            ...plan,
            reactive_mode: true,
        } as EnhancedPlanOutput & { reactive_mode: true };
    }

    /**
     * Build a review task description from PR metadata.
     */
    private buildReviewTaskDescription(prMetadata: PRMetadata): string {
        const fileList = prMetadata.changed_files.slice(0, 20).join('\n- ');
        const hasMoreFiles = prMetadata.changed_files.length > 20;

        return `Review the following code changes for a pull request:

${prMetadata.title ? `**Title**: ${prMetadata.title}` : ''}
${prMetadata.author ? `**Author**: ${prMetadata.author}` : ''}
**Base Branch**: ${prMetadata.base_ref}
**Commit**: ${prMetadata.commit_hash.substring(0, 12)}
${prMetadata.lines_added ? `**Lines Added**: ${prMetadata.lines_added}` : ''}
${prMetadata.lines_removed ? `**Lines Removed**: ${prMetadata.lines_removed}` : ''}

**Changed Files (${prMetadata.changed_files.length} total)**:
- ${fileList}${hasMoreFiles ? `\n... and ${prMetadata.changed_files.length - 20} more files` : ''}

Please review for:
1. Correctness - bugs, logic errors, edge cases
2. Security - vulnerabilities, injection risks, auth issues
3. Performance - inefficiencies, memory leaks, N+1 queries
4. Maintainability - code clarity, modularity, complexity
5. Best practices - naming, patterns, documentation`;
    }
}
