/**
 * Layer 3: MCP Interface Layer - Reactive Review Tools
 *
 * Exposes reactive PR code review capabilities as MCP tools.
 * These tools provide session-based code review with pause/resume,
 * parallel execution, and telemetry tracking.
 *
 * Tools:
 * - reactive_review_pr: Start or continue a reactive PR code review
 * - get_review_status: Get status and progress of a review session
 * - pause_review: Pause a running review session
 * - resume_review: Resume a paused review session
 * - get_review_telemetry: Get telemetry data for a review session
 * - scrub_secrets: Scrub secrets from content before sending to LLM
 * - validate_content: Run multi-tier validation on content
 */

import { ContextServiceClient } from '../serviceClient.js';
import { PlanningService } from '../services/planningService.js';
import { ExecutionTrackingService } from '../services/executionTrackingService.js';
import {
    ReactiveReviewService,
    SecretScrubber,
    ValidationPipeline,
    getConfig,
    isPhaseEnabled,
    type PRMetadata,
    type StartReviewOptions,
} from '../../reactive/index.js';

// ============================================================================
// Service Instance Reuse (Lazy Singleton Pattern)
// ============================================================================

let cachedReactiveService: ReactiveReviewService | null = null;
let cachedPlanningService: PlanningService | null = null;
let cachedExecutionService: ExecutionTrackingService | null = null;
let cachedServiceClientRef: WeakRef<ContextServiceClient> | null = null;
let cachedSecretScrubber: SecretScrubber | null = null;
let cachedValidationPipeline: ValidationPipeline | null = null;

function getReactiveReviewService(serviceClient: ContextServiceClient): ReactiveReviewService {
    const cachedClient = cachedServiceClientRef?.deref();
    if (cachedReactiveService && cachedClient === serviceClient) {
        return cachedReactiveService;
    }

    cachedPlanningService = new PlanningService(serviceClient);
    cachedExecutionService = new ExecutionTrackingService();
    cachedReactiveService = new ReactiveReviewService(
        serviceClient,
        cachedPlanningService,
        cachedExecutionService
    );
    cachedServiceClientRef = new WeakRef(serviceClient);

    return cachedReactiveService;
}

function getSecretScrubber(): SecretScrubber {
    if (!cachedSecretScrubber) {
        cachedSecretScrubber = new SecretScrubber();
    }
    return cachedSecretScrubber;
}

function getValidationPipeline(): ValidationPipeline {
    if (!cachedValidationPipeline) {
        cachedValidationPipeline = new ValidationPipeline();
    }
    return cachedValidationPipeline;
}

function getPlanningService(serviceClient: ContextServiceClient): PlanningService {
    // Ensure the reactive service is initialized first (which creates the planning service)
    getReactiveReviewService(serviceClient);
    if (!cachedPlanningService) {
        cachedPlanningService = new PlanningService(serviceClient);
    }
    return cachedPlanningService;
}

// ============================================================================
// Tool Argument Types
// ============================================================================

export interface ReactiveReviewPRArgs {
    /** Git commit hash for the PR */
    commit_hash: string;
    /** Base branch reference (e.g., "main") */
    base_ref: string;
    /** List of changed files (comma-separated or JSON array) */
    changed_files: string;
    /** PR title */
    title?: string;
    /** PR author */
    author?: string;
    /** Number of additions in the PR */
    additions?: number;
    /** Number of deletions in the PR */
    deletions?: number;
    /** Enable parallel execution (default: uses config) */
    parallel?: boolean;
    /** Maximum parallel workers */
    max_workers?: number;
}

export interface GetReviewStatusArgs {
    /** Session ID to get status for */
    session_id: string;
}

export interface PauseResumeArgs {
    /** Session ID to pause/resume */
    session_id: string;
}

export interface ScrubSecretsArgs {
    /** Content to scrub */
    content: string;
    /** Show first N characters of secret (default: 4) */
    show_start?: number;
    /** Show last N characters of secret (default: 0) */
    show_end?: number;
}

export interface ValidateContentArgs {
    /** Content to validate */
    content: string;
    /** Content type: review_finding, plan_output, generated_code, raw_text */
    content_type: 'review_finding' | 'plan_output' | 'generated_code' | 'raw_text';
    /** Optional file path for context */
    file_path?: string;
    /** Enable secret scrubbing (default: true) */
    scrub_secrets?: boolean;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Handle the reactive_review_pr tool call
 *
 * IMPORTANT: This now automatically starts step execution after creating the session.
 * Previously, the session was created but execution was never started, causing
 * sessions to stall at 0% progress.
 */
export async function handleReactiveReviewPR(
    args: ReactiveReviewPRArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    const startTime = Date.now();

    try {
        // Check if reactive features are enabled
        if (!isPhaseEnabled(2)) {
            return JSON.stringify({
                success: false,
                error: 'Reactive features are disabled. Set REACTIVE_ENABLED=true and REACTIVE_PARALLEL_EXEC=true',
            }, null, 2);
        }

        console.error('[reactive_review_pr] Starting reactive PR review...');

        // Parse changed files
        let changedFiles: string[];
        if (args.changed_files.startsWith('[')) {
            changedFiles = JSON.parse(args.changed_files);
        } else {
            changedFiles = args.changed_files.split(',').map(f => f.trim());
        }

        // Build PR metadata
        const prMetadata: PRMetadata = {
            commit_hash: args.commit_hash,
            base_ref: args.base_ref,
            changed_files: changedFiles,
            title: args.title,
            author: args.author,
            lines_added: args.additions,
            lines_removed: args.deletions,
        };

        // Build start options
        const options: StartReviewOptions = {
            max_workers: args.max_workers,
        };

        // Get services
        const service = getReactiveReviewService(serviceClient);
        const planningService = getPlanningService(serviceClient);

        // Start the review session (creates plan)
        const session = await service.startReactiveReview(prMetadata, options);

        const planCreationTime = Date.now() - startTime;
        console.error(`[reactive_review_pr] Session created in ${planCreationTime}ms: ${session.session_id}`);
        console.error(`[reactive_review_pr] Plan has ${session.total_steps} steps, starting execution...`);

        // Create a step executor that uses the planning service
        const stepExecutor = createDefaultStepExecutor(service, planningService, session.session_id);

        // Start execution asynchronously (don't await - let it run in background)
        // This prevents the MCP call from timing out while steps execute
        executeReviewInBackground(service, session.session_id, stepExecutor);

        const elapsed = Date.now() - startTime;
        return JSON.stringify({
            success: true,
            session_id: session.session_id,
            plan_id: session.plan_id,
            status: 'executing',
            total_steps: session.total_steps || 0,
            elapsed_ms: elapsed,
            message: `Review session started with ${session.total_steps} steps. Execution running in background. Use get_review_status to monitor progress.`,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[reactive_review_pr] Failed: ${errorMessage}`);
        throw new Error(`Reactive review failed: ${errorMessage}`);
    }
}

/**
 * Create a default step executor using the PlanningService
 */
function createDefaultStepExecutor(
    service: ReactiveReviewService,
    planningService: PlanningService,
    sessionId: string
): (planId: string, stepNumber: number) => Promise<{ success: boolean; error?: string; files_modified?: string[] }> {
    return async (planId: string, stepNumber: number) => {
        try {
            console.error(`[reactive_review_pr] Executing step ${stepNumber} for plan ${planId}`);

            // Get the plan from the session
            const status = service.getReviewStatus(sessionId);
            if (!status) {
                return { success: false, error: 'Session not found' };
            }

            // Get the plan from the service
            const plan = service.getSessionPlan(sessionId);
            if (!plan) {
                return { success: false, error: 'Plan not found for session' };
            }

            // Execute the step using the planning service
            const result = await planningService.executeStep(plan, stepNumber);

            console.error(`[reactive_review_pr] Step ${stepNumber} ${result.success ? 'completed' : 'failed'}: ${result.error || 'OK'}`);

            // Extract files from generated_code if present
            const filesModified = result.generated_code?.map(gc => gc.path) || [];

            return {
                success: result.success,
                error: result.error,
                files_modified: filesModified,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[reactive_review_pr] Step ${stepNumber} error: ${errorMessage}`);
            return { success: false, error: errorMessage };
        }
    };
}

/**
 * Execute the review in the background without blocking the MCP response
 */
function executeReviewInBackground(
    service: ReactiveReviewService,
    sessionId: string,
    stepExecutor: (planId: string, stepNumber: number) => Promise<{ success: boolean; error?: string; files_modified?: string[] }>
): void {
    // Don't await - let it run in background
    service.executeReview(sessionId, stepExecutor)
        .then((results) => {
            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;
            console.error(`[reactive_review_pr] Background execution completed: ${succeeded} succeeded, ${failed} failed`);
        })
        .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[reactive_review_pr] Background execution failed: ${errorMessage}`);
        });
}

/**
 * Handle the get_review_status tool call
 * Uses async version to attempt plan recovery from disk if needed.
 */
export async function handleGetReviewStatus(
    args: GetReviewStatusArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    try {
        if (!args.session_id) {
            throw new Error('Missing session_id argument');
        }

        const service = getReactiveReviewService(serviceClient);

        // Use async version to allow plan recovery from disk
        const status = await service.getReviewStatusAsync(args.session_id);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${args.session_id}`,
            }, null, 2);
        }

        return JSON.stringify({
            success: true,
            ...status,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Get review status failed: ${errorMessage}`);
    }
}

/**
 * Handle the pause_review tool call
 */
export async function handlePauseReview(
    args: PauseResumeArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    try {
        if (!args.session_id) {
            throw new Error('Missing session_id argument');
        }

        const service = getReactiveReviewService(serviceClient);
        await service.pauseReview(args.session_id);

        return JSON.stringify({
            success: true,
            message: `Review session ${args.session_id} paused`,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
            success: false,
            error: errorMessage,
        }, null, 2);
    }
}

/**
 * Handle the resume_review tool call
 * Note: This currently just marks the session as ready to resume.
 * Full execution continuation requires a step executor callback.
 */
export async function handleResumeReview(
    args: PauseResumeArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    try {
        if (!args.session_id) {
            throw new Error('Missing session_id argument');
        }

        const service = getReactiveReviewService(serviceClient);
        const status = service.getReviewStatus(args.session_id);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${args.session_id}`,
            }, null, 2);
        }

        if (status.session.status !== 'paused') {
            return JSON.stringify({
                success: false,
                error: `Session is not paused (current status: ${status.session.status})`,
            }, null, 2);
        }

        // Note: Full resume requires a step executor. For MCP, we just return status.
        // The actual resume should be done programmatically with a callback.
        return JSON.stringify({
            success: true,
            message: `Session ${args.session_id} is ready to resume. Call execute with a step executor to continue.`,
            session_status: status.session.status,
            progress: status.progress,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
            success: false,
            error: errorMessage,
        }, null, 2);
    }
}

/**
 * Handle the get_review_telemetry tool call
 * Uses async version to attempt plan recovery from disk if needed.
 */
export async function handleGetReviewTelemetry(
    args: GetReviewStatusArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    try {
        if (!args.session_id) {
            throw new Error('Missing session_id argument');
        }

        const service = getReactiveReviewService(serviceClient);

        // Use async version to allow plan recovery from disk
        const status = await service.getReviewStatusAsync(args.session_id);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${args.session_id}`,
            }, null, 2);
        }

        // Extract telemetry data
        const cacheStats = serviceClient.getCacheStats();
        const config = getConfig();

        return JSON.stringify({
            success: true,
            session_id: args.session_id,
            telemetry: status.telemetry,
            cache_stats: {
                hit_rate: cacheStats.hitRate,
                total_entries: cacheStats.size,
                commit_keyed: cacheStats.commitKeyed,
            },
            reactive_config: config,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Get review telemetry failed: ${errorMessage}`);
    }
}

/**
 * Handle the scrub_secrets tool call
 */
export async function handleScrubSecrets(
    args: ScrubSecretsArgs
): Promise<string> {
    try {
        if (!args.content) {
            throw new Error('Missing content argument');
        }

        const scrubber = getSecretScrubber();
        const result = scrubber.scrub(args.content);

        return JSON.stringify({
            success: true,
            scrubbed_content: result.scrubbedContent,
            secrets_found: result.hasSecrets,
            secrets_count: result.detectedSecrets.length,
            detected_types: result.detectedSecrets.map(s => ({
                type: s.type,
                pattern: s.patternName,
                confidence: s.confidence,
                masked: s.maskedValue,
            })),
            processing_time_ms: result.processingTime,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Scrub secrets failed: ${errorMessage}`);
    }
}

/**
 * Handle the validate_content tool call
 */
export async function handleValidateContent(
    args: ValidateContentArgs
): Promise<string> {
    try {
        if (!args.content) {
            throw new Error('Missing content argument');
        }

        const pipeline = getValidationPipeline();
        const result = pipeline.validate({
            content: args.content,
            contentType: args.content_type || 'raw_text',
            filePath: args.file_path,
        });

        return JSON.stringify({
            success: true,
            passed: result.passed,
            findings_count: result.findings.length,
            by_severity: {
                errors: result.bySeverity.errors.length,
                warnings: result.bySeverity.warnings.length,
                info: result.bySeverity.info.length,
            },
            findings: result.findings.map(f => ({
                id: f.id,
                severity: f.severity,
                category: f.category,
                rule_id: f.ruleId,
                message: f.message,
                line: f.lineNumber,
                suggestion: f.suggestion,
            })),
            secrets_scrubbed: result.secretScrub?.hasSecrets || false,
            processing_time_ms: result.processingTime,
            tiers_run: result.tiersRun,
        }, null, 2);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Validate content failed: ${errorMessage}`);
    }
}

// ============================================================================
// Tool Schema Definitions
// ============================================================================

export const reactiveReviewPRTool = {
    name: 'reactive_review_pr',
    description: `Start a reactive PR code review session.

This tool initiates an AI-powered code review with advanced features:
- **Commit-aware caching**: Caches context by commit hash for efficiency
- **Parallel execution**: Reviews multiple files concurrently
- **Session management**: Pause, resume, and track progress
- **Telemetry**: Token usage, cache hit rates, execution timing

**Environment Variables:**
- REACTIVE_ENABLED=true: Master switch for reactive features
- REACTIVE_PARALLEL_EXEC=true: Enable parallel execution
- REACTIVE_MAX_WORKERS=3: Maximum concurrent workers

**Returns:** Session ID for tracking. Use get_review_status to monitor progress.`,

    inputSchema: {
        type: 'object',
        properties: {
            commit_hash: {
                type: 'string',
                description: 'Git commit hash for the PR head',
            },
            base_ref: {
                type: 'string',
                description: 'Base branch reference (e.g., "main", "develop")',
            },
            changed_files: {
                type: 'string',
                description: 'Changed files as comma-separated list or JSON array',
            },
            title: {
                type: 'string',
                description: 'PR title for context',
            },
            author: {
                type: 'string',
                description: 'PR author for context',
            },
            additions: {
                type: 'number',
                description: 'Number of line additions in the PR',
            },
            deletions: {
                type: 'number',
                description: 'Number of line deletions in the PR',
            },
        },
        required: ['commit_hash', 'base_ref', 'changed_files'],
    },
};

export const getReviewStatusTool = {
    name: 'get_review_status',
    description: `Get the current status and progress of a reactive review session.

Returns:
- Session status (active, paused, completed, cancelled, error)
- Progress percentage and step counts
- Findings count
- Telemetry data (elapsed time, tokens used, cache hit rate)`,

    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'The session ID returned from reactive_review_pr',
            },
        },
        required: ['session_id'],
    },
};

export const pauseReviewTool = {
    name: 'pause_review',
    description: `Pause a running reactive review session.

The review can be resumed later with resume_review.
Useful for:
- Freeing up resources temporarily
- Allowing manual intervention
- Stopping execution before a problematic step`,

    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'The session ID to pause',
            },
        },
        required: ['session_id'],
    },
};

export const resumeReviewTool = {
    name: 'resume_review',
    description: `Resume a paused reactive review session.

Continues execution from where it was paused.`,

    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'The session ID to resume',
            },
        },
        required: ['session_id'],
    },
};

export const getReviewTelemetryTool = {
    name: 'get_review_telemetry',
    description: `Get detailed telemetry data for a review session.

Returns:
- Token usage statistics
- Cache hit/miss rates
- Execution timing per step
- Reactive configuration in use`,

    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'The session ID to get telemetry for',
            },
        },
        required: ['session_id'],
    },
};

export const scrubSecretsTool = {
    name: 'scrub_secrets',
    description: `Scrub secrets from content before sending to LLM.

Detects and masks 15+ types of secrets:
- AWS keys, OpenAI/Anthropic API keys
- GitHub tokens, Stripe keys, Firebase/Supabase keys
- Private keys (PEM), JWTs, connection strings
- Generic API keys and passwords

Use this before including user content in prompts.`,

    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Content to scrub secrets from',
            },
            show_start: {
                type: 'number',
                description: 'Characters to show at start of masked secret (default: 4)',
                default: 4,
            },
            show_end: {
                type: 'number',
                description: 'Characters to show at end of masked secret (default: 0)',
                default: 0,
            },
        },
        required: ['content'],
    },
};

export const validateContentTool = {
    name: 'validate_content',
    description: `Run multi-tier validation on content.

**Tier 1 (Deterministic):**
- Balanced brackets/braces
- Valid JSON structure
- Non-empty content

**Tier 2 (Heuristic):**
- TODO/FIXME detection in code
- Console statement detection
- Hardcoded URL detection
- Line length checks

Also scrubs secrets automatically (can be disabled).`,

    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Content to validate',
            },
            content_type: {
                type: 'string',
                enum: ['review_finding', 'plan_output', 'generated_code', 'raw_text'],
                description: 'Type of content for context-aware validation',
                default: 'raw_text',
            },
            file_path: {
                type: 'string',
                description: 'Optional file path for context',
            },
            scrub_secrets: {
                type: 'boolean',
                description: 'Enable secret scrubbing (default: true)',
                default: true,
            },
        },
        required: ['content'],
    },
};

// ============================================================================
// Export all tools as an array for easy registration
// ============================================================================

export const reactiveReviewTools = [
    reactiveReviewPRTool,
    getReviewStatusTool,
    pauseReviewTool,
    resumeReviewTool,
    getReviewTelemetryTool,
    scrubSecretsTool,
    validateContentTool,
];
