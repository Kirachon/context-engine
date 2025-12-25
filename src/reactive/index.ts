/**
 * Reactive AI Code Review Engine - Public API
 *
 * This module exports all public types and functions for the reactive engine.
 * Import from this file rather than individual modules.
 *
 * @example
 * ```typescript
 * import { getConfig, isReactiveEnabled, type ReactivePlan } from './reactive/index.js';
 * ```
 */

// ============================================================================
// Configuration
// ============================================================================

export {
    type ReactiveConfig,
    getConfig,
    isReactiveEnabled,
    isPhaseEnabled,
    getConfigSummary,
    logConfig,
    // Adaptive timeout calculation
    type AdaptiveTimeoutOptions,
    calculateAdaptiveTimeout,
    getRecommendedTimeout,
    // Circuit breaker configuration
    type CircuitBreakerState,
    type CircuitBreakerConfig,
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
    getCircuitBreakerConfig,
    // Chunked processing configuration
    type ChunkedProcessingConfig,
    DEFAULT_CHUNKED_PROCESSING_CONFIG,
    getChunkedProcessingConfig,
    splitIntoChunks,
} from './config.js';

// ============================================================================
// Types
// ============================================================================

export {
    // Cache types
    type CommitCacheOptions,
    type CacheStats,

    // Parallel execution types
    type ParallelExecutionOptions,
    type ReactiveStepExtension,

    // Plan types
    type PRMetadata,
    type ReactivePlan,

    // Session types
    type ReviewSessionStatus,
    type ReviewSession,
    type ReviewStatus,

    // Validation types (Phase 4 preview)
    type ValidationTier,
    type ValidationSeverity,
    type ValidationFinding,

    // Telemetry types
    type ReactiveEventType,
    type ReactiveEvent,
} from './types.js';

// ============================================================================
// Services (Phase 2)
// ============================================================================

export {
    ReactiveReviewService,
    type StartReviewOptions,
    type ReviewFindings,
} from './ReactiveReviewService.js';

// ============================================================================
// Deduplication Service (Phase 3)
// ============================================================================

export {
    DeduplicationService,
    type DeduplicatableFinding,
    type DeduplicationOptions,
} from './deduplication.js';

// ============================================================================
// Guardrails (Phase 4)
// ============================================================================

export {
    SecretScrubber,
    createSecretScrubber,
    scrubSecrets,
    type DetectedSecret,
    type SecretType,
    type ScrubResult,
    type SecretScrubberOptions,
    type SecretPattern,
} from './guardrails/index.js';

// ============================================================================
// Validation Pipeline (Phase 4)
// ============================================================================

export {
    ValidationPipeline,
    createValidationPipeline,
    validateContent,
    type ValidationResult,
    type ValidationInput,
    type ValidationPipelineOptions,
    type ValidationRule,
} from './validation/index.js';
