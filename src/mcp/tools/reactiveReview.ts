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
import { createAIAgentStepExecutor } from '../../reactive/executors/AIAgentStepExecutor.js';
import { createBatchReviewExecutor } from '../../reactive/executors/BatchReviewExecutor.js';
import { createClientBoundFactory } from '../tooling/serviceFactory.js';
import { validateMaxLength, validateNonEmptyString } from '../tooling/validation.js';

type ReactiveServiceBundle = {
    reactiveService: ReactiveReviewService;
    planningService: PlanningService;
    executionService: ExecutionTrackingService;
};

const reactiveServiceFactory = createClientBoundFactory<ReactiveServiceBundle, ContextServiceClient>(
    (serviceClient): ReactiveServiceBundle => {
        const planningService = new PlanningService(serviceClient);
        const executionService = new ExecutionTrackingService();
        const reactiveService = new ReactiveReviewService(
            serviceClient,
            planningService,
            executionService
        );
        return {
            reactiveService,
            planningService,
            executionService,
        };
    }
);

let cachedSecretScrubber: SecretScrubber | null = null;
let cachedValidationPipeline: ValidationPipeline | null = null;

function getReactiveReviewService(serviceClient: ContextServiceClient): ReactiveReviewService {
    return reactiveServiceFactory.get(serviceClient).reactiveService;
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
    return reactiveServiceFactory.get(serviceClient).planningService;
}

export function resetReactiveReviewCachesForTests(): void {
    reactiveServiceFactory.reset();
    cachedSecretScrubber = null;
    cachedValidationPipeline = null;
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
// Input Validation Constants & Helpers
// ============================================================================

const MAX_COMMIT_HASH_LENGTH = 200;
const MAX_BASE_REF_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_CHANGED_FILES_INPUT_LENGTH = 100_000;
const MAX_CHANGED_FILES_COUNT = 5000;
const MAX_FILE_PATH_LENGTH = 1024;
const MAX_LINES_CHANGED = 10_000_000;
const MAX_REACTIVE_WORKERS = 64;

function validateRequiredString(
    value: unknown,
    fieldName: string,
    maxLength: number,
    missingMessage = `${fieldName} is required`
): string {
    const trimmed = validateNonEmptyString(value, missingMessage).trim();
    if (!trimmed) {
        throw new Error(missingMessage);
    }

    validateMaxLength(trimmed, maxLength, `${fieldName} exceeds maximum length (${maxLength})`);

    return trimmed;
}

function validateOptionalNonNegativeInteger(
    value: unknown,
    fieldName: string,
    maxValue: number
): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`${fieldName} must be an integer`);
    }

    if (value < 0) {
        throw new Error(`${fieldName} must be non-negative`);
    }

    if (value > maxValue) {
        throw new Error(`${fieldName} exceeds maximum value (${maxValue})`);
    }

    return value;
}

function parseChangedFilesInput(changedFilesInput: unknown): string[] {
    const raw = validateRequiredString(
        changedFilesInput,
        'changed_files',
        MAX_CHANGED_FILES_INPUT_LENGTH
    );

    let parsedEntries: unknown[];
    const trimmed = raw.trim();

    if (trimmed.startsWith('[')) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            throw new Error('changed_files must be valid CSV or JSON array string');
        }

        if (!Array.isArray(parsed)) {
            throw new Error('changed_files JSON input must be an array of file paths');
        }

        parsedEntries = parsed;
    } else {
        parsedEntries = raw.split(',');
    }

    if (parsedEntries.length === 0) {
        throw new Error('changed_files must include at least one file path');
    }

    if (parsedEntries.length > MAX_CHANGED_FILES_COUNT) {
        throw new Error(`changed_files exceeds maximum entries (${MAX_CHANGED_FILES_COUNT})`);
    }

    return parsedEntries.map((entry, index) => {
        if (typeof entry !== 'string') {
            throw new Error(`changed_files[${index}] must be a string path`);
        }

        const path = entry.trim();
        if (!path) {
            throw new Error(`changed_files[${index}] must be a non-empty path`);
        }

        if (path.length > MAX_FILE_PATH_LENGTH) {
            throw new Error(`changed_files[${index}] exceeds maximum length (${MAX_FILE_PATH_LENGTH})`);
        }

        return path;
    });
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
        const commitHash = validateRequiredString(args.commit_hash, 'commit_hash', MAX_COMMIT_HASH_LENGTH);
        const baseRef = validateRequiredString(args.base_ref, 'base_ref', MAX_BASE_REF_LENGTH);
        const changedFiles = parseChangedFilesInput(args.changed_files);
        const additions = validateOptionalNonNegativeInteger(args.additions, 'additions', MAX_LINES_CHANGED);
        const deletions = validateOptionalNonNegativeInteger(args.deletions, 'deletions', MAX_LINES_CHANGED);
        const maxWorkers = validateOptionalNonNegativeInteger(args.max_workers, 'max_workers', MAX_REACTIVE_WORKERS);

        // Check if reactive features are enabled
        if (!isPhaseEnabled(2)) {
            return JSON.stringify({
                success: false,
                error: 'Reactive features are disabled. Set REACTIVE_ENABLED=true and REACTIVE_PARALLEL_EXEC=true',
            }, null, 2);
        }

        console.error('[reactive_review_pr] Starting reactive PR review...');

        // Build PR metadata
        const prMetadata: PRMetadata = {
            commit_hash: commitHash,
            base_ref: baseRef,
            changed_files: changedFiles,
            title: args.title,
            author: args.author,
            lines_added: additions,
            lines_removed: deletions,
        };

        // Build start options
        const options: StartReviewOptions = {
            max_workers: maxWorkers,
        };

        // Get services
        const service = getReactiveReviewService(serviceClient);
        const planningService = getPlanningService(serviceClient);

        // Start the review session (creates plan)
        const session = await service.startReactiveReview(prMetadata, options);

        const planCreationTime = Date.now() - startTime;
        console.error(`[reactive_review_pr] Session created in ${planCreationTime}ms: ${session.session_id}`);
        console.error(`[reactive_review_pr] Plan has ${session.total_steps} steps, starting execution...`);

        const stepExecutor = createReactiveStepExecutor(service, planningService, session.session_id);

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
 * Create the configured reactive step executor for a session.
 */
function createReactiveStepExecutor(
    service: ReactiveReviewService,
    planningService: PlanningService,
    sessionId: string
): (planId: string, stepNumber: number) => Promise<{ success: boolean; error?: string; files_modified?: string[] }> {
    const config = getConfig();
    const stepExecutor = config.enable_batching
        ? createBatchReviewExecutor(service, sessionId, {
            max_batch_size: config.batch_size,
        })
        : config.use_ai_agent_executor
            ? createAIAgentStepExecutor(service, sessionId)
            : createDefaultStepExecutor(service, planningService, sessionId);

    if (config.enable_batching) {
        console.error(`[reactive_review_pr] Using Batch Review Executor (fastest mode, batch_size=${config.batch_size})`);
    } else if (config.use_ai_agent_executor) {
        console.error('[reactive_review_pr] Using AI Agent Step Executor (fast mode)');
    } else {
        console.error('[reactive_review_pr] Using Default Step Executor (API mode)');
    }

    return stepExecutor;
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
        const sessionId = validateRequiredString(
            args.session_id,
            'session_id',
            MAX_SESSION_ID_LENGTH,
            'Missing session_id argument'
        );

        const service = getReactiveReviewService(serviceClient);

        // Use async version to allow plan recovery from disk
        const status = await service.getReviewStatusAsync(sessionId);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${sessionId}`,
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
        const sessionId = validateRequiredString(
            args.session_id,
            'session_id',
            MAX_SESSION_ID_LENGTH,
            'Missing session_id argument'
        );

        const service = getReactiveReviewService(serviceClient);
        const status = service.getReviewStatus(sessionId);
        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${sessionId}`,
            }, null, 2);
        }

        if (status.session.status === 'paused') {
            return JSON.stringify({
                success: true,
                status: 'paused',
                message: `Review session ${sessionId} is already paused`,
                progress: status.progress,
            }, null, 2);
        }

        if (status.session.status !== 'executing') {
            return JSON.stringify({
                success: false,
                error: `Session is not executing (current status: ${status.session.status})`,
            }, null, 2);
        }

        await service.pauseReview(sessionId);

        return JSON.stringify({
            success: true,
            status: 'paused',
            message: `Review session ${sessionId} paused`,
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
 * Handle the resume_review tool call.
 * This resumes execution asynchronously in the background.
 */
export async function handleResumeReview(
    args: PauseResumeArgs,
    serviceClient: ContextServiceClient
): Promise<string> {
    try {
        const sessionId = validateRequiredString(
            args.session_id,
            'session_id',
            MAX_SESSION_ID_LENGTH,
            'Missing session_id argument'
        );

        const service = getReactiveReviewService(serviceClient);
        const status = service.getReviewStatus(sessionId);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${sessionId}`,
            }, null, 2);
        }

        if (status.session.status === 'executing') {
            return JSON.stringify({
                success: true,
                status: 'executing',
                message: `Review session ${sessionId} is already executing`,
                session_status: 'executing',
                progress: status.progress,
            }, null, 2);
        }

        if (status.session.status !== 'paused') {
            return JSON.stringify({
                success: false,
                error: `Session is not paused (current status: ${status.session.status})`,
            }, null, 2);
        }

        const planningService = getPlanningService(serviceClient);
        const stepExecutor = createReactiveStepExecutor(service, planningService, sessionId);
        executeResumeInBackground(service, sessionId, stepExecutor);

        return JSON.stringify({
            success: true,
            status: 'executing',
            message: `Review session ${sessionId} resumed. Execution running in background. Use get_review_status to monitor progress.`,
            session_status: 'executing',
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
 * Resume a paused review in the background without blocking the MCP response.
 */
function executeResumeInBackground(
    service: ReactiveReviewService,
    sessionId: string,
    stepExecutor: (planId: string, stepNumber: number) => Promise<{ success: boolean; error?: string; files_modified?: string[] }>
): void {
    // Don't await - let it run in background
    service.resumeReview(sessionId, stepExecutor)
        .then((results) => {
            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;
            console.error(`[resume_review] Background execution completed: ${succeeded} succeeded, ${failed} failed`);
        })
        .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[resume_review] Background execution failed: ${errorMessage}`);
        });
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
        const sessionId = validateRequiredString(
            args.session_id,
            'session_id',
            MAX_SESSION_ID_LENGTH,
            'Missing session_id argument'
        );

        const service = getReactiveReviewService(serviceClient);

        // Use async version to allow plan recovery from disk
        const status = await service.getReviewStatusAsync(sessionId);

        if (!status) {
            return JSON.stringify({
                success: false,
                error: `Session not found: ${sessionId}`,
            }, null, 2);
        }

        // Extract telemetry data
        const cacheStats = serviceClient.getCacheStats();
        const config = getConfig();

        return JSON.stringify({
            success: true,
            session_id: sessionId,
            telemetry: status.telemetry,
            session_status: status.session.status,
            session_error: status.session.error,
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
        const content = validateRequiredString(
            args.content,
            'content',
            MAX_CONTENT_LENGTH,
            'Missing content argument'
        );

        const scrubber = getSecretScrubber();
        const result = scrubber.scrub(content);

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
        const content = validateRequiredString(
            args.content,
            'content',
            MAX_CONTENT_LENGTH,
            'Missing content argument'
        );

        const pipeline = getValidationPipeline();
        const result = pipeline.validate({
            content,
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
            max_workers: {
                type: 'number',
                description: 'Maximum number of parallel workers for this review session',
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
