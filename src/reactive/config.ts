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
     * Path to SQLite database (if enabled)
     * @default ~/.context-engine/reactive.db
     */
    sqlite_path?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: ReactiveConfig = {
    // Master switch - enabled by default, but features are opt-in
    enabled: true,

    // Phase flags - all opt-in (false by default)
    commit_cache: false,
    parallel_exec: false,
    sqlite_backend: false,
    guardrails: false,

    // Tuning parameters
    max_workers: 3,
    token_budget: 10000,
    cache_ttl_ms: 300000, // 5 minutes
    step_timeout_ms: 60000, // 1 minute
    max_retries: 2,
    session_ttl_ms: 3600000, // 1 hour
    max_sessions: 100,
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
