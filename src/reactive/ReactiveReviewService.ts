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
import { EnhancedPlanOutput } from '../mcp/types/planning.js';
import {
    PRMetadata,
    ReviewSession,
    ReviewSessionStatus,
    ReviewStatus,
    getConfig,
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

    /** Cleanup timer for expired sessions */
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    /** Terminal session states that are eligible for cleanup */
    private static readonly TERMINAL_STATES: ReviewSessionStatus[] = ['completed', 'failed', 'cancelled'];

    constructor(
        private contextClient: ContextServiceClient,
        private planningService: PlanningService,
        private executionService: ExecutionTrackingService
    ) {
        // Start periodic cleanup (every 5 minutes)
        this.startCleanupTimer();
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
     * Sessions in terminal states (completed, failed, cancelled) are eligible for cleanup.
     */
    cleanupExpiredSessions(): number {
        const config = getConfig();
        const now = Date.now();
        let cleanedCount = 0;

        // First pass: remove sessions that have exceeded TTL
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

        // Second pass: if still over max_sessions, remove oldest terminal sessions
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

        if (cleanedCount > 0) {
            console.error(`[ReactiveReviewService] Cleaned up ${cleanedCount} expired sessions, ${this.sessions.size} remaining`);
        }

        return cleanedCount;
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

        this.sessions.set(sessionId, session);
        this.sessionStartTimes.set(sessionId, Date.now());
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

            // Update status
            session.status = 'analyzing';
            session.updated_at = new Date().toISOString();

            // Create a review plan using the planning service
            const plan = await this.createReviewPlan(prMetadata, options);
            session.plan_id = plan.id || sessionId;
            session.total_steps = plan.steps?.length || 0;
            this.sessionPlans.set(sessionId, plan);

            // Initialize execution tracking
            this.executionService.initializeExecution(plan);

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

            console.error(`[ReactiveReviewService] Review plan created with ${session.total_steps} steps`);

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

        const plan = this.sessionPlans.get(sessionId);
        if (!plan) {
            throw new Error(`No plan found for session: ${sessionId}`);
        }

        if (session.status !== 'executing') {
            throw new Error(`Session is not in executing state: ${session.status}`);
        }

        try {
            // Execute steps (parallel or sequential based on config)
            const results = await this.executionService.executeReadyStepsParallel(
                session.plan_id,
                plan,
                stepExecutor
            );

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
     * Get the current status of a review session.
     */
    getReviewStatus(sessionId: string): ReviewStatus | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const progress = this.executionService.getProgress(session.plan_id);
        const startTime = this.sessionStartTimes.get(sessionId) || Date.now();
        const tokensUsed = this.sessionTokensUsed.get(sessionId) || 0;
        const findingsCount = this.sessionFindings.get(sessionId) || 0;

        // Get cache stats for hit rate
        const cacheStats = this.contextClient.getCacheStats();

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

        const plan = this.sessionPlans.get(sessionId);
        if (!plan) {
            throw new Error(`No plan found for session: ${sessionId}`);
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
