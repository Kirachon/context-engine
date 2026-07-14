/**
 * Reactive AI Code Review Engine - Configuration
 *
 * Phase 1: Feature flags and configuration for reactive mode
 *
 * All reactive features are OPT-IN by default to ensure
 * zero impact on existing functionality until explicitly enabled.
 */
import os from 'os';
import { envInt } from '../config/env.js';

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

    /**
     * Use AI agent for step execution (faster, no external API)
     * Replaces slow searchAndAsk() calls with direct file analysis
     * @default false (opt-in)
     */
    use_ai_agent_executor: boolean;

    /**
     * Enable multi-layer response caching (additional 2-4x speedup)
     * Implements memory + commit + file hash caching layers
     * @default false (opt-in)
     */
    enable_multilayer_cache: boolean;

    /**
     * Enable continuous batching (additional 2-3x speedup)
     * Processes multiple files in single AI request
     * @default false (opt-in)
     */
    enable_batching: boolean;

    /**
     * Maximum files per batch when batching is enabled
     * Bounded to [1, 100]. Out-of-range values are clamped; malformed values fall back to the default.
     * @default 5
     */
    batch_size: number;

    /**
     * Enable worker pool optimization (additional 1.5-2x speedup)
     * Optimizes worker count based on CPU cores and load balancing
     * @default false (opt-in)
     */
    optimize_workers: boolean;
    // ============================================================================
    // Tuning Parameters
    // ============================================================================

    /**
     * Maximum parallel workers for step execution
     * Bounded to [1, 32] (also applied to the CPU-derived value when optimize_workers is enabled).
     * Out-of-range values are clamped; malformed values fall back to the default.
     * @default 2
     */
    max_workers: number;

    /**
     * Maximum token budget for a single review
     * Bounded to [100, 200000]. Out-of-range values are clamped; malformed values fall back to the default.
     * @default 10000
     */
    token_budget: number;

    /**
     * Cache TTL in milliseconds
     * Bounded to [1000, 86400000] (1 second to 24 hours). Out-of-range values are clamped; malformed values fall back to the default.
     * @default 300000 (5 minutes)
     */
    cache_ttl_ms: number;

    /**
     * Step execution timeout in milliseconds
     * Bounded to [1000, 1800000] (1 second to 30 minutes). Out-of-range values are clamped; malformed values fall back to the default.
     * @default 180000 (3 minutes)
     */
    step_timeout_ms: number;

    /**
     * Maximum retries for failed steps
     * Bounded to [0, 10]. Out-of-range values are clamped; malformed values fall back to the default.
     * @default 3
     */
    max_retries: number;

    /**
     * Session TTL in milliseconds - completed/failed sessions are cleaned up after this time
     * Bounded to [60000, 86400000] (1 minute to 24 hours). Out-of-range values are clamped; malformed values fall back to the default.
     * @default 3600000 (1 hour)
     */
    session_ttl_ms: number;

    /**
     * Maximum number of sessions to keep in memory
     * Bounded to [1, 10000]. Out-of-range values are clamped; malformed values fall back to the default.
     * @default 100
     */
    max_sessions: number;

    /**
     * Timeout for sessions in executing state without progress
     * Sessions are marked as failed if they exceed this time without completing
     * Bounded to [60000, 86400000] (1 minute to 24 hours). Out-of-range values are clamped; malformed values fall back to the default.
     * @default 1800000 (30 minutes)
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
    use_ai_agent_executor: false,
    enable_multilayer_cache: false,
    enable_batching: false,
    batch_size: 5,
    optimize_workers: false,

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
// Numeric Bounds
// ============================================================================

/**
 * Explicit [min, max] ranges for every bounded numeric reactive config field.
 *
 * Behavior contract (consistent across all fields below):
 * - Malformed input (non-numeric, empty, whitespace-only) -> falls back to the documented default.
 * - Well-formed but out-of-range input (negative, zero below min, overflow above max) -> clamped to
 *   the nearest bound (min or max), never silently accepted unbounded.
 * - Well-formed in-range input (including exact boundary values) -> used as-is.
 *
 * This "clamp in-range-shape, default on unparseable" split keeps counts/durations/retries always
 * positive/bounded while avoiding surprising silent resets for values that are simply out of range.
 */
const REACTIVE_CONFIG_BOUNDS = {
    batch_size: { min: 1, max: 100 },
    max_workers: { min: 1, max: 32 },
    token_budget: { min: 100, max: 200_000 },
    cache_ttl_ms: { min: 1_000, max: 86_400_000 },
    step_timeout_ms: { min: 1_000, max: 1_800_000 },
    max_retries: { min: 0, max: 10 },
    session_ttl_ms: { min: 60_000, max: 86_400_000 },
    max_sessions: { min: 1, max: 10_000 },
    session_execution_timeout_ms: { min: 60_000, max: 86_400_000 },
} as const;

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Get the current reactive configuration from environment variables
 *
 * Environment variables (bounded numeric fields use REACTIVE_CONFIG_BOUNDS: malformed
 * values fall back to the default, out-of-range values are clamped to [min, max]):
 * - REACTIVE_ENABLED: Master switch (default: true)
 * - REACTIVE_COMMIT_CACHE: Phase 1 commit-keyed cache (default: false)
 * - REACTIVE_PARALLEL_EXEC: Phase 2 parallel execution (default: false)
 * - REACTIVE_SQLITE_BACKEND: Phase 3 SQLite persistence (default: false)
 * - REACTIVE_GUARDRAILS: Phase 4 validation pipeline (default: false)
 * - REACTIVE_BATCH_SIZE: Max files per batch, bounded [1, 100] (default: 5)
 * - REACTIVE_MAX_WORKERS: Max parallel workers, bounded [1, 32] (default: 2)
 * - REACTIVE_TOKEN_BUDGET: Max tokens per review, bounded [100, 200000] (default: 10000)
 * - REACTIVE_CACHE_TTL: Cache TTL in ms, bounded [1000, 86400000] (default: 300000)
 * - REACTIVE_STEP_TIMEOUT: Step timeout in ms, bounded [1000, 1800000] (default: 180000)
 * - REACTIVE_MAX_RETRIES: Max retries per step, bounded [0, 10] (default: 3)
 * - REACTIVE_SESSION_TTL: Session TTL in ms, bounded [60000, 86400000] (default: 3600000)
 * - REACTIVE_MAX_SESSIONS: Max sessions in memory, bounded [1, 10000] (default: 100)
 * - REACTIVE_EXECUTION_TIMEOUT: Session execution timeout in ms, bounded [60000, 86400000] (default: 1800000)
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
        use_ai_agent_executor: process.env.REACTIVE_USE_AI_AGENT_EXECUTOR === 'true',
        enable_multilayer_cache: process.env.REACTIVE_ENABLE_MULTILAYER_CACHE === 'true',
        enable_batching: process.env.REACTIVE_ENABLE_BATCHING === 'true',
        batch_size: envInt('REACTIVE_BATCH_SIZE', DEFAULT_CONFIG.batch_size, REACTIVE_CONFIG_BOUNDS.batch_size),
        optimize_workers: process.env.REACTIVE_OPTIMIZE_WORKERS === 'true',

        // Tuning parameters with defaults
        // Note: max_workers is dynamically adjusted based on optimize_workers flag
        max_workers: (() => {
            const baseWorkers = envInt('REACTIVE_MAX_WORKERS', DEFAULT_CONFIG.max_workers, REACTIVE_CONFIG_BOUNDS.max_workers);
            const optimizeWorkers = process.env.REACTIVE_OPTIMIZE_WORKERS === 'true';

            if (optimizeWorkers) {
                // Use CPU-aware optimization, bounded by the same max_workers range as the manual override
                const cpuCores = os.cpus().length;
                const rawOptimal = Math.min(cpuCores + 1, cpuCores * 2);
                const optimal = Math.max(
                    REACTIVE_CONFIG_BOUNDS.max_workers.min,
                    Math.min(REACTIVE_CONFIG_BOUNDS.max_workers.max, rawOptimal)
                );
                console.error(`[ReactiveConfig] Worker optimization enabled: ${cpuCores} CPU cores detected, using ${optimal} workers`);
                return optimal;
            }

            return baseWorkers;
        })(),
        token_budget: envInt('REACTIVE_TOKEN_BUDGET', DEFAULT_CONFIG.token_budget, REACTIVE_CONFIG_BOUNDS.token_budget),
        cache_ttl_ms: envInt('REACTIVE_CACHE_TTL', DEFAULT_CONFIG.cache_ttl_ms, REACTIVE_CONFIG_BOUNDS.cache_ttl_ms),
        step_timeout_ms: envInt('REACTIVE_STEP_TIMEOUT', DEFAULT_CONFIG.step_timeout_ms, REACTIVE_CONFIG_BOUNDS.step_timeout_ms),
        max_retries: envInt('REACTIVE_MAX_RETRIES', DEFAULT_CONFIG.max_retries, REACTIVE_CONFIG_BOUNDS.max_retries),
        session_ttl_ms: envInt('REACTIVE_SESSION_TTL', DEFAULT_CONFIG.session_ttl_ms, REACTIVE_CONFIG_BOUNDS.session_ttl_ms),
        max_sessions: envInt('REACTIVE_MAX_SESSIONS', DEFAULT_CONFIG.max_sessions, REACTIVE_CONFIG_BOUNDS.max_sessions),
        session_execution_timeout_ms: envInt('REACTIVE_EXECUTION_TIMEOUT', DEFAULT_CONFIG.session_execution_timeout_ms, REACTIVE_CONFIG_BOUNDS.session_execution_timeout_ms),

        // Optional paths
        sqlite_path: process.env.REACTIVE_SQLITE_PATH,
    };
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
        `batches=${parallelBatches}, baseTime=${Math.round(baseTime / 1000)}s, ` +
        `calculated=${Math.round(clampedTime / 1000)}s`);

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
    /** Number of consecutive failures before opening circuit. Bounded to [1, 100]. @default 3 */
    failureThreshold: number;
    /** Time in ms before attempting to close circuit. Bounded to [100, 3600000] (100ms to 1 hour). @default 60000 (1 minute) */
    resetTimeout: number;
    /** Number of successful operations needed to close circuit. Bounded to [1, 100]. @default 2 */
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
 * Explicit [min, max] ranges for circuit breaker numeric fields.
 * Same clamp/default behavior contract as REACTIVE_CONFIG_BOUNDS.
 */
const CIRCUIT_BREAKER_BOUNDS = {
    failureThreshold: { min: 1, max: 100 },
    resetTimeout: { min: 100, max: 3_600_000 },
    successThreshold: { min: 1, max: 100 },
} as const;

/**
 * Get circuit breaker configuration from environment
 */
export function getCircuitBreakerConfig(): CircuitBreakerConfig {
    return {
        failureThreshold: envInt('REACTIVE_CB_FAILURE_THRESHOLD', DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold, CIRCUIT_BREAKER_BOUNDS.failureThreshold),
        resetTimeout: envInt('REACTIVE_CB_RESET_TIMEOUT', DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeout, CIRCUIT_BREAKER_BOUNDS.resetTimeout),
        successThreshold: envInt('REACTIVE_CB_SUCCESS_THRESHOLD', DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold, CIRCUIT_BREAKER_BOUNDS.successThreshold),
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
    /** File count threshold to trigger chunking. Bounded to [1, 10000]. @default 15 */
    chunkThreshold: number;
    /** Maximum files per chunk. Bounded to [1, 1000]. @default 10 */
    chunkSize: number;
    /** Delay between chunks in ms. Bounded to [0, 300000] (0 to 5 minutes). @default 5000 (5 seconds) */
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
 * Explicit [min, max] ranges for chunked processing numeric fields.
 * Same clamp/default behavior contract as REACTIVE_CONFIG_BOUNDS.
 */
const CHUNKED_PROCESSING_BOUNDS = {
    chunkThreshold: { min: 1, max: 10_000 },
    chunkSize: { min: 1, max: 1_000 },
    interChunkDelay: { min: 0, max: 300_000 },
} as const;

/**
 * Get chunked processing configuration from environment
 */
export function getChunkedProcessingConfig(): ChunkedProcessingConfig {
    return {
        enabled: process.env.REACTIVE_CHUNKED_PROCESSING !== 'false',
        chunkThreshold: envInt('REACTIVE_CHUNK_THRESHOLD', DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkThreshold, CHUNKED_PROCESSING_BOUNDS.chunkThreshold),
        chunkSize: envInt('REACTIVE_CHUNK_SIZE', DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkSize, CHUNKED_PROCESSING_BOUNDS.chunkSize),
        interChunkDelay: envInt('REACTIVE_INTER_CHUNK_DELAY', DEFAULT_CHUNKED_PROCESSING_CONFIG.interChunkDelay, CHUNKED_PROCESSING_BOUNDS.interChunkDelay),
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
