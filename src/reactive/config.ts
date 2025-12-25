/**
 * Reactive AI Code Review Engine - Configuration
 *
 * Phase 1: Feature flags and configuration for reactive mode
 *
 * All reactive features are OPT-IN by default to ensure
 * zero impact on existing functionality until explicitly enabled.
 */

// ============================================================================
// Configuration Interface
// ============================================================================

/**
 * Configuration for the Reactive AI Code Review Engine
 */
export interface ReactiveConfig {
    // ============================================================================
    // Master Switch
    // ============================================================================

    /**
     * Master switch for all reactive features
     * Set REACTIVE_ENABLED=false to disable everything
     * @default true
     */
    enabled: boolean;

    // ============================================================================
    // Phase-specific Feature Flags
    // ============================================================================

    /**
     * Phase 1: Enable commit-hash keyed caching
     * Improves cache consistency during PR reviews
     * @default false (opt-in)
     */
    commit_cache: boolean;

    /**
     * Phase 2: Enable parallel step execution
     * Speeds up reviews by running independent steps concurrently
     * @default false (opt-in)
     */
    parallel_exec: boolean;

    /**
     * Phase 3: Enable SQLite backend for persistence
     * Provides better query performance and deduplication
     * @default false (opt-in)
     */
    sqlite_backend: boolean;

    /**
     * Phase 4: Enable guardrails and validation pipeline
     * Adds secret scanning, token limits, and HITL checkpoints
     * @default false (opt-in)
     */
    guardrails: boolean;

    // ============================================================================
    // Tuning Parameters
    // ============================================================================

    /**
     * Maximum parallel workers for step execution
     * @default 3
     */
    max_workers: number;

    /**
     * Maximum token budget for a single review
     * @default 10000
     */
    token_budget: number;

    /**
     * Cache TTL in milliseconds
     * @default 300000 (5 minutes)
     */
    cache_ttl_ms: number;

    /**
     * Step execution timeout in milliseconds
     * @default 60000 (1 minute)
     */
    step_timeout_ms: number;

    /**
     * Maximum retries for failed steps
     * @default 2
     */
    max_retries: number;

    /**
     * Session TTL in milliseconds - completed/failed sessions are cleaned up after this time
     * @default 3600000 (1 hour)
     */
    session_ttl_ms: number;

    /**
     * Maximum number of sessions to keep in memory
     * @default 100
     */
    max_sessions: number;

    /**
     * Timeout for sessions in executing state without progress
     * Sessions are marked as failed if they exceed this time without completing
     * @default 600000 (10 minutes)
     */
    session_execution_timeout_ms: number;

    /**
     * Path to SQLite database (if enabled)
     * @default ~/.context-engine/reactive.db
     */
    sqlite_path?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * BALANCED CONFIGURATION (Option 2)
 *
 * Optimized for reliability with large PRs (20+ files):
 * - Reduced parallelism (2 workers) to prevent resource contention
 * - Extended step timeout (180s) to accommodate slow AI responses
 * - Dynamic session timeout based on file count (see calculateAdaptiveTimeout)
 * - Higher retry count (3) for transient failures
 *
 * This configuration addresses timeout issues seen with large PRs by:
 * 1. Allowing more time per step (AI responses can take 30-180s)
 * 2. Running fewer parallel workers to reduce memory pressure
 * 3. Automatically adjusting session timeout based on workload
 */
const DEFAULT_CONFIG: ReactiveConfig = {
    // Master switch - enabled by default, but features are opt-in
    enabled: true,

    // Phase flags - all opt-in (false by default)
    commit_cache: false,
    parallel_exec: false,
    sqlite_backend: false,
    guardrails: false,

    // Tuning parameters - BALANCED for reliability
    max_workers: 2,                        // Reduced from 3 to prevent resource contention
    token_budget: 10000,
    cache_ttl_ms: 300000,                  // 5 minutes
    step_timeout_ms: 180000,               // 3 minutes (up from 1 minute)
    max_retries: 3,                        // Increased from 2 for better resilience
    session_ttl_ms: 3600000,               // 1 hour
    max_sessions: 100,
    session_execution_timeout_ms: 1800000, // 30 minutes (up from 10 minutes)
};

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Get the current reactive configuration from environment variables
 *
 * Environment variables:
 * - REACTIVE_ENABLED: Master switch (default: true)
 * - REACTIVE_COMMIT_CACHE: Phase 1 commit-keyed cache (default: false)
 * - REACTIVE_PARALLEL_EXEC: Phase 2 parallel execution (default: false)
 * - REACTIVE_SQLITE_BACKEND: Phase 3 SQLite persistence (default: false)
 * - REACTIVE_GUARDRAILS: Phase 4 validation pipeline (default: false)
 * - REACTIVE_MAX_WORKERS: Max parallel workers (default: 3)
 * - REACTIVE_TOKEN_BUDGET: Max tokens per review (default: 10000)
 * - REACTIVE_CACHE_TTL: Cache TTL in ms (default: 300000)
 * - REACTIVE_STEP_TIMEOUT: Step timeout in ms (default: 60000)
 * - REACTIVE_MAX_RETRIES: Max retries per step (default: 2)
 * - REACTIVE_SESSION_TTL: Session TTL in ms (default: 3600000)
 * - REACTIVE_MAX_SESSIONS: Max sessions in memory (default: 100)
 * - REACTIVE_SQLITE_PATH: Path to SQLite database
 */
export function getConfig(): ReactiveConfig {
    return {
        // Master switch - only disabled if explicitly set to "false"
        enabled: process.env.REACTIVE_ENABLED !== 'false',

        // Phase flags - only enabled if explicitly set to "true" (opt-in)
        commit_cache: process.env.REACTIVE_COMMIT_CACHE === 'true',
        parallel_exec: process.env.REACTIVE_PARALLEL_EXEC === 'true',
        sqlite_backend: process.env.REACTIVE_SQLITE_BACKEND === 'true',
        guardrails: process.env.REACTIVE_GUARDRAILS === 'true',

        // Tuning parameters with defaults
        max_workers: parseIntSafe(process.env.REACTIVE_MAX_WORKERS, DEFAULT_CONFIG.max_workers),
        token_budget: parseIntSafe(process.env.REACTIVE_TOKEN_BUDGET, DEFAULT_CONFIG.token_budget),
        cache_ttl_ms: parseIntSafe(process.env.REACTIVE_CACHE_TTL, DEFAULT_CONFIG.cache_ttl_ms),
        step_timeout_ms: parseIntSafe(process.env.REACTIVE_STEP_TIMEOUT, DEFAULT_CONFIG.step_timeout_ms),
        max_retries: parseIntSafe(process.env.REACTIVE_MAX_RETRIES, DEFAULT_CONFIG.max_retries),
        session_ttl_ms: parseIntSafe(process.env.REACTIVE_SESSION_TTL, DEFAULT_CONFIG.session_ttl_ms),
        max_sessions: parseIntSafe(process.env.REACTIVE_MAX_SESSIONS, DEFAULT_CONFIG.max_sessions),
        session_execution_timeout_ms: parseIntSafe(process.env.REACTIVE_EXECUTION_TIMEOUT, DEFAULT_CONFIG.session_execution_timeout_ms),

        // Optional paths
        sqlite_path: process.env.REACTIVE_SQLITE_PATH,
    };
}

/**
 * Parse an integer from a string with a default fallback
 */
function parseIntSafe(value: string | undefined, defaultValue: number): number {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Check if any reactive feature is enabled
 */
export function isReactiveEnabled(): boolean {
    const config = getConfig();
    return config.enabled && (
        config.commit_cache ||
        config.parallel_exec ||
        config.sqlite_backend ||
        config.guardrails
    );
}

/**
 * Check if a specific phase is enabled
 */
export function isPhaseEnabled(phase: 1 | 2 | 3 | 4): boolean {
    const config = getConfig();
    if (!config.enabled) return false;

    switch (phase) {
        case 1:
            return config.commit_cache;
        case 2:
            return config.parallel_exec;
        case 3:
            return config.sqlite_backend;
        case 4:
            return config.guardrails;
        default:
            return false;
    }
}

/**
 * Get a summary of enabled features for logging
 */
export function getConfigSummary(): string {
    const config = getConfig();
    const features: string[] = [];

    if (config.commit_cache) features.push('commit_cache');
    if (config.parallel_exec) features.push('parallel_exec');
    if (config.sqlite_backend) features.push('sqlite_backend');
    if (config.guardrails) features.push('guardrails');

    if (!config.enabled) {
        return '[reactive] DISABLED';
    }

    if (features.length === 0) {
        return '[reactive] enabled (no features active)';
    }

    return `[reactive] enabled: ${features.join(', ')}`;
}

/**
 * Log the current configuration (for debugging)
 */
export function logConfig(): void {
    console.error(getConfigSummary());
}

// ============================================================================
// Adaptive Timeout Calculation
// ============================================================================

/**
 * Options for adaptive timeout calculation
 */
export interface AdaptiveTimeoutOptions {
    /** Number of files to process */
    fileCount: number;
    /** Average expected time per file in milliseconds (default: 60000 = 1 minute) */
    avgTimePerFile?: number;
    /** Buffer multiplier for variance (default: 1.5 = 50% buffer) */
    bufferMultiplier?: number;
    /** Minimum timeout in milliseconds (default: 300000 = 5 minutes) */
    minTimeout?: number;
    /** Maximum timeout in milliseconds (default: 3600000 = 1 hour) */
    maxTimeout?: number;
}

/**
 * Calculate adaptive session timeout based on workload.
 *
 * Formula: timeout = (fileCount × avgTimePerFile / parallelFactor) × bufferMultiplier
 *
 * For example, with 27 files, 2 workers, 60s avg per file:
 * - Parallel batches: ceil(27 / 2) = 14 batches
 * - Expected time: 14 × 60s = 840s (14 minutes)
 * - With 1.5x buffer: 840 × 1.5 = 1260s (21 minutes)
 * - Plus startup overhead: +2 minutes = 23 minutes
 *
 * @param options Timeout calculation options
 * @returns Calculated timeout in milliseconds
 */
export function calculateAdaptiveTimeout(options: AdaptiveTimeoutOptions): number {
    const config = getConfig();
    const {
        fileCount,
        avgTimePerFile = 60000,      // 1 minute default per file
        bufferMultiplier = 1.5,      // 50% buffer for variance
        minTimeout = 300000,         // 5 minutes minimum
        maxTimeout = 3600000,        // 1 hour maximum
    } = options;

    // Calculate parallel factor based on configuration
    const parallelFactor = config.parallel_exec ? config.max_workers : 1;

    // Calculate expected parallel batches
    const parallelBatches = Math.ceil(fileCount / parallelFactor);

    // Base time calculation
    const baseTime = parallelBatches * avgTimePerFile;

    // Apply buffer for variance in AI response times
    const bufferedTime = baseTime * bufferMultiplier;

    // Add startup/teardown overhead (2 minutes)
    const startupOverhead = 120000;
    const totalTime = bufferedTime + startupOverhead;

    // Clamp to min/max bounds
    const clampedTime = Math.max(minTimeout, Math.min(maxTimeout, totalTime));

    console.error(`[AdaptiveTimeout] fileCount=${fileCount}, workers=${parallelFactor}, ` +
        `batches=${parallelBatches}, baseTime=${Math.round(baseTime/1000)}s, ` +
        `calculated=${Math.round(clampedTime/1000)}s`);

    return Math.round(clampedTime);
}

/**
 * Get recommended timeout for a PR with given file count.
 * Convenience wrapper around calculateAdaptiveTimeout.
 *
 * @param fileCount Number of files in the PR
 * @returns Recommended session timeout in milliseconds
 */
export function getRecommendedTimeout(fileCount: number): number {
    return calculateAdaptiveTimeout({ fileCount });
}

// ============================================================================
// Circuit Breaker Configuration
// ============================================================================

/**
 * Circuit breaker state
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker configuration options
 */
export interface CircuitBreakerConfig {
    /** Number of consecutive failures before opening circuit (default: 3) */
    failureThreshold: number;
    /** Time in ms before attempting to close circuit (default: 60000 = 1 minute) */
    resetTimeout: number;
    /** Number of successful operations needed to close circuit (default: 2) */
    successThreshold: number;
    /** Whether to fall back to sequential on circuit open (default: true) */
    fallbackToSequential: boolean;
}

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 3,
    resetTimeout: 60000,
    successThreshold: 2,
    fallbackToSequential: true,
};

/**
 * Get circuit breaker configuration from environment
 */
export function getCircuitBreakerConfig(): CircuitBreakerConfig {
    return {
        failureThreshold: parseIntSafe(process.env.REACTIVE_CB_FAILURE_THRESHOLD, DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold),
        resetTimeout: parseIntSafe(process.env.REACTIVE_CB_RESET_TIMEOUT, DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeout),
        successThreshold: parseIntSafe(process.env.REACTIVE_CB_SUCCESS_THRESHOLD, DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold),
        fallbackToSequential: process.env.REACTIVE_CB_FALLBACK_SEQUENTIAL !== 'false',
    };
}

// ============================================================================
// Chunked Processing Configuration
// ============================================================================

/**
 * Configuration for chunked processing of large PRs
 */
export interface ChunkedProcessingConfig {
    /** Enable chunked processing for large PRs (default: true) */
    enabled: boolean;
    /** File count threshold to trigger chunking (default: 15) */
    chunkThreshold: number;
    /** Maximum files per chunk (default: 10) */
    chunkSize: number;
    /** Delay between chunks in ms (default: 5000 = 5 seconds) */
    interChunkDelay: number;
}

/**
 * Default chunked processing configuration
 */
export const DEFAULT_CHUNKED_PROCESSING_CONFIG: ChunkedProcessingConfig = {
    enabled: true,
    chunkThreshold: 15,
    chunkSize: 10,
    interChunkDelay: 5000,
};

/**
 * Get chunked processing configuration from environment
 */
export function getChunkedProcessingConfig(): ChunkedProcessingConfig {
    return {
        enabled: process.env.REACTIVE_CHUNKED_PROCESSING !== 'false',
        chunkThreshold: parseIntSafe(process.env.REACTIVE_CHUNK_THRESHOLD, DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkThreshold),
        chunkSize: parseIntSafe(process.env.REACTIVE_CHUNK_SIZE, DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkSize),
        interChunkDelay: parseIntSafe(process.env.REACTIVE_INTER_CHUNK_DELAY, DEFAULT_CHUNKED_PROCESSING_CONFIG.interChunkDelay),
    };
}

/**
 * Split files into chunks for processing large PRs.
 *
 * @param files Array of file paths to process
 * @param config Optional chunked processing configuration
 * @returns Array of file path chunks
 */
export function splitIntoChunks<T>(files: T[], config?: Partial<ChunkedProcessingConfig>): T[][] {
    const cfg = { ...getChunkedProcessingConfig(), ...config };

    // If chunking is disabled or below threshold, return single chunk
    if (!cfg.enabled || files.length <= cfg.chunkThreshold) {
        return [files];
    }

    const chunks: T[][] = [];
    for (let i = 0; i < files.length; i += cfg.chunkSize) {
        chunks.push(files.slice(i, i + cfg.chunkSize));
    }

    console.error(`[ChunkedProcessing] Split ${files.length} files into ${chunks.length} chunks of max ${cfg.chunkSize} files each`);
    return chunks;
}
