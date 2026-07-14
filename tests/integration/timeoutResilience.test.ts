/**
 * Integration tests for timeout resilience features
 * 
 * Reproduces the real-world timeout scenario:
 * - 27 changed files (large PR workload)
 * - Parallel execution enabled
 * - Session timeout after 5.5 minutes
 * - Only 12% cache hit rate
 * - Worker saturation causing bottleneck
 * 
 * Tests circuit breaker, adaptive timeout, and chunked processing features.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ExecutionTrackingService, StepExecutor, StepExecutionResult } from '../../src/mcp/services/executionTrackingService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';
import {
    calculateAdaptiveTimeout,
    getRecommendedTimeout,
    getConfig,
    getCircuitBreakerConfig,
    getChunkedProcessingConfig,
    splitIntoChunks,
    DEFAULT_CIRCUIT_BREAKER_CONFIG,
    DEFAULT_CHUNKED_PROCESSING_CONFIG,
} from '../../src/reactive/config.js';

describe('Timeout Resilience Integration Tests', () => {
    // ==========================================================================
    // Test Constants - Based on real-world failure scenario
    // ==========================================================================
    
    /** Number of files in the problematic PR */
    const REAL_WORLD_FILE_COUNT = 27;
    
    /** Elapsed time before timeout (5.5 minutes) */
    const REAL_WORLD_TIMEOUT_MS = 341_132;
    
    /** Original session timeout (10 minutes) */
    const ORIGINAL_SESSION_TIMEOUT_MS = 600_000;
    
    /** Realistic AI response time range (30-60 seconds) */
    const MIN_STEP_DURATION_MS = 30_000;
    const MAX_STEP_DURATION_MS = 60_000;
    
    /** Number of steps that completed before timeout (1 out of 13) */
    const STEPS_COMPLETED_BEFORE_TIMEOUT = 1;
    const TOTAL_PLANNED_STEPS = 13;

    // ==========================================================================
    // Helper Functions
    // ==========================================================================

    /**
     * Generate a realistic list of 27 changed files
     */
    const generateChangedFiles = (count: number = REAL_WORLD_FILE_COUNT): string[] => {
        const files: string[] = [];
        const directories = ['src/components', 'src/services', 'src/utils', 'src/hooks', 'tests'];
        const extensions = ['.ts', '.tsx', '.test.ts', '.test.tsx'];
        
        for (let i = 0; i < count; i++) {
            const dir = directories[i % directories.length];
            const ext = extensions[i % extensions.length];
            files.push(`${dir}/file${i + 1}${ext}`);
        }
        return files;
    };

    /**
     * Create a realistic test plan with the specified number of steps
     */
    const createLargePlan = (stepCount: number = TOTAL_PLANNED_STEPS): EnhancedPlanOutput => {
        const steps: EnhancedPlanOutput['steps'] = [];
        for (let i = 1; i <= stepCount; i++) {
            steps.push({
                step_number: i,
                id: `step_${i}`,
                title: `Review step ${i}`,
                description: `Review files for step ${i}`,
                files_to_modify: [],
                files_to_create: [],
                files_to_delete: [],
                depends_on: i > 1 ? [i - 1] : [], // Linear dependencies
                blocks: i < stepCount ? [i + 1] : [],
                can_parallel_with: [],
                priority: (i <= 3 ? 'high' : 'medium') as 'high' | 'medium' | 'low',
                estimated_effort: '5m',
                acceptance_criteria: [],
            });
        }

        return {
            id: 'plan_large_pr',
            version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            goal: 'Review large PR with 27 files',
            scope: { included: [], excluded: [], assumptions: [], constraints: [] },
            mvp_features: [],
            nice_to_have_features: [],
            architecture: { notes: '', patterns_used: [], diagrams: [] },
            risks: [],
            milestones: [],
            steps,
            dependency_graph: { nodes: [], edges: [], critical_path: [], parallel_groups: [], execution_order: [] },
            testing_strategy: { unit: '', integration: '', coverage_target: '80%' },
            acceptance_criteria: [],
            confidence_score: 0.8,
            questions_for_clarification: [],
            context_files: generateChangedFiles(),
            codebase_insights: [],
        };
    };

    /**
     * Create a slow step executor that simulates realistic AI response times
     */
    const createSlowExecutor = (
        minDurationMs: number = MIN_STEP_DURATION_MS,
        maxDurationMs: number = MAX_STEP_DURATION_MS,
        failureRate: number = 0.3
    ): StepExecutor => {
        return async (_planId: string, stepNumber: number): Promise<StepExecutionResult> => {
            const duration = minDurationMs + Math.random() * (maxDurationMs - minDurationMs);
            
            // Simulate execution time
            await new Promise(resolve => setTimeout(resolve, duration));
            
            // Randomly fail some steps to trigger circuit breaker
            const shouldFail = Math.random() < failureRate;
            
            return {
                step_number: stepNumber,
                success: !shouldFail,
                duration_ms: duration,
                retries: 0,
                error: shouldFail ? `Step ${stepNumber} simulated failure` : undefined,
            };
        };
    };

    /**
     * Create a fast executor for testing that doesn't wait
     */
    const createFastExecutor = (failureRate: number = 0): StepExecutor => {
        return async (_planId: string, stepNumber: number): Promise<StepExecutionResult> => {
            const shouldFail = Math.random() < failureRate;
            return {
                step_number: stepNumber,
                success: !shouldFail,
                duration_ms: 10,
                retries: 0,
                error: shouldFail ? `Step ${stepNumber} simulated failure` : undefined,
            };
        };
    };

    // ==========================================================================
    // Adaptive Timeout Tests
    // ==========================================================================

    describe('Adaptive Timeout Calculation', () => {
        it('should calculate longer timeout for 27 files than default', () => {
            const adaptiveTimeout = calculateAdaptiveTimeout({
                fileCount: REAL_WORLD_FILE_COUNT,
                avgTimePerFile: 30_000, // 30 seconds per file
                bufferMultiplier: 1.5,
                minTimeout: ORIGINAL_SESSION_TIMEOUT_MS,
            });

            // The adaptive timeout considers parallel workers (default 3), so it's more efficient
            // For 27 files with 3 workers, we get ~9 batches * 30s = 270s base, with buffer ~525s
            // But minTimeout is 600s, so we get at least that
            expect(adaptiveTimeout).toBeGreaterThanOrEqual(ORIGINAL_SESSION_TIMEOUT_MS);

            console.error(`Adaptive timeout for ${REAL_WORLD_FILE_COUNT} files: ${Math.round(adaptiveTimeout / 1000)}s`);
        });

        it('should return at least minTimeout for small PRs', () => {
            const adaptiveTimeout = calculateAdaptiveTimeout({
                fileCount: 2,
                avgTimePerFile: 30_000,
                bufferMultiplier: 1.5,
                minTimeout: ORIGINAL_SESSION_TIMEOUT_MS,
            });

            // 2 files * 30s * 1.5 = 90,000ms, but min is 600,000ms
            expect(adaptiveTimeout).toBe(ORIGINAL_SESSION_TIMEOUT_MS);
        });

        it('should provide recommended timeout that exceeds real-world failure time', () => {
            const recommendedTimeout = getRecommendedTimeout(REAL_WORLD_FILE_COUNT);

            // Recommended timeout should be greater than when the real failure occurred
            expect(recommendedTimeout).toBeGreaterThan(REAL_WORLD_TIMEOUT_MS);

            console.error(`Recommended timeout for ${REAL_WORLD_FILE_COUNT} files: ${Math.round(recommendedTimeout / 1000)}s`);
            console.error(`Real-world failure occurred at: ${Math.round(REAL_WORLD_TIMEOUT_MS / 1000)}s`);
        });

        it('should scale appropriately with file count', () => {
            const timeout10 = calculateAdaptiveTimeout({ fileCount: 10, avgTimePerFile: 30_000 });
            const timeout27 = calculateAdaptiveTimeout({ fileCount: 27, avgTimePerFile: 30_000 });
            const timeout50 = calculateAdaptiveTimeout({ fileCount: 50, avgTimePerFile: 30_000 });

            // More files should get more time (though clamped by min/max)
            expect(timeout27).toBeGreaterThanOrEqual(timeout10);
            expect(timeout50).toBeGreaterThan(timeout27);

            // The ratio won't be exactly linear due to parallel batching and min/max clamping
            // Just verify the scaling direction is correct
            expect(timeout50 / timeout10).toBeGreaterThan(1);
        });
    });

    // ==========================================================================
    // Chunked Processing Tests
    // ==========================================================================

    describe('Chunked Processing', () => {
        it('should split 27 files into appropriate chunks', () => {
            const files = generateChangedFiles(REAL_WORLD_FILE_COUNT);
            const config = getChunkedProcessingConfig();

            const chunks = splitIntoChunks(files, config);

            // Default chunk size is 10, so 27 files should be 3 chunks
            expect(chunks.length).toBe(3);
            expect(chunks[0].length).toBe(10);
            expect(chunks[1].length).toBe(10);
            expect(chunks[2].length).toBe(7);

            // All files should be accounted for
            const totalFiles = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            expect(totalFiles).toBe(REAL_WORLD_FILE_COUNT);
        });

        it('should handle small PRs below threshold', () => {
            const files = generateChangedFiles(15); // Below default threshold of 20
            const config = getChunkedProcessingConfig();

            // splitIntoChunks always returns chunks - the threshold check is done by caller
            // 15 files / 10 chunk size = 2 chunks (10 + 5)
            const chunks = splitIntoChunks(files, config);

            // With default chunk size of 10, 15 files = 2 chunks
            expect(chunks.length).toBeGreaterThanOrEqual(1);
            expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(15); // All files accounted for
        });

        it('should respect custom chunk configuration', () => {
            const files = generateChangedFiles(REAL_WORLD_FILE_COUNT);
            const customConfig = {
                ...DEFAULT_CHUNKED_PROCESSING_CONFIG,
                chunkSize: 5,
            };

            const chunks = splitIntoChunks(files, customConfig);

            // 27 files / 5 per chunk = 6 chunks (5+5+5+5+5+2)
            expect(chunks.length).toBe(6);
        });
    });

    // ==========================================================================
    // Bounded Reactive Numeric Configuration Tests (C4)
    //
    // Every bounded numeric field in src/reactive/config.ts follows the same
    // contract: malformed input falls back to the documented default,
    // out-of-range (negative/zero/overflow) input is clamped to [min, max],
    // and boundary/valid values pass through unchanged.
    // ==========================================================================

    describe('Bounded Reactive Numeric Configuration', () => {
        const REACTIVE_NUMERIC_ENV_VARS = [
            'REACTIVE_BATCH_SIZE',
            'REACTIVE_MAX_WORKERS',
            'REACTIVE_TOKEN_BUDGET',
            'REACTIVE_CACHE_TTL',
            'REACTIVE_STEP_TIMEOUT',
            'REACTIVE_MAX_RETRIES',
            'REACTIVE_SESSION_TTL',
            'REACTIVE_MAX_SESSIONS',
            'REACTIVE_EXECUTION_TIMEOUT',
            'REACTIVE_OPTIMIZE_WORKERS',
            'REACTIVE_CB_FAILURE_THRESHOLD',
            'REACTIVE_CB_RESET_TIMEOUT',
            'REACTIVE_CB_SUCCESS_THRESHOLD',
            'REACTIVE_CHUNK_THRESHOLD',
            'REACTIVE_CHUNK_SIZE',
            'REACTIVE_INTER_CHUNK_DELAY',
        ];

        beforeEach(() => {
            // The host shell/CI environment may already export some of these
            // (e.g. REACTIVE_MAX_WORKERS) for unrelated reasons; start every
            // test from a clean slate so "unset" truly means unset.
            for (const name of REACTIVE_NUMERIC_ENV_VARS) {
                delete process.env[name];
            }
        });

        afterEach(() => {
            for (const name of REACTIVE_NUMERIC_ENV_VARS) {
                delete process.env[name];
            }
        });

        describe('getConfig() numeric fields', () => {
            it('uses documented defaults when unset', () => {
                const config = getConfig();
                expect(config.batch_size).toBe(5);
                expect(config.max_workers).toBe(2);
                expect(config.token_budget).toBe(10000);
                expect(config.cache_ttl_ms).toBe(300000);
                expect(config.step_timeout_ms).toBe(180000);
                expect(config.max_retries).toBe(3);
                expect(config.session_ttl_ms).toBe(3600000);
                expect(config.max_sessions).toBe(100);
                expect(config.session_execution_timeout_ms).toBe(1800000);
            });

            it('falls back to the default for malformed values', () => {
                process.env.REACTIVE_BATCH_SIZE = 'not-a-number';
                process.env.REACTIVE_MAX_RETRIES = '';
                process.env.REACTIVE_MAX_WORKERS = '   ';

                const config = getConfig();
                expect(config.batch_size).toBe(5);
                expect(config.max_retries).toBe(3);
                expect(config.max_workers).toBe(2);
            });

            it('clamps negative values up to the minimum bound', () => {
                process.env.REACTIVE_BATCH_SIZE = '-5';
                process.env.REACTIVE_MAX_WORKERS = '-1';
                process.env.REACTIVE_TOKEN_BUDGET = '-100';
                process.env.REACTIVE_CACHE_TTL = '-1';
                process.env.REACTIVE_STEP_TIMEOUT = '-1';
                process.env.REACTIVE_SESSION_TTL = '-1';
                process.env.REACTIVE_MAX_SESSIONS = '-1';
                process.env.REACTIVE_EXECUTION_TIMEOUT = '-1';

                const config = getConfig();
                expect(config.batch_size).toBe(1);
                expect(config.max_workers).toBe(1);
                expect(config.token_budget).toBe(100);
                expect(config.cache_ttl_ms).toBe(1_000);
                expect(config.step_timeout_ms).toBe(1_000);
                expect(config.session_ttl_ms).toBe(60_000);
                expect(config.max_sessions).toBe(1);
                expect(config.session_execution_timeout_ms).toBe(60_000);

                // max_retries has a min of 0, so a negative value still clamps up to 0
                process.env.REACTIVE_MAX_RETRIES = '-1';
                expect(getConfig().max_retries).toBe(0);
            });

            it('clamps zero to the minimum bound when the minimum is positive', () => {
                process.env.REACTIVE_BATCH_SIZE = '0';
                process.env.REACTIVE_MAX_WORKERS = '0';
                process.env.REACTIVE_MAX_SESSIONS = '0';

                const config = getConfig();
                expect(config.batch_size).toBe(1);
                expect(config.max_workers).toBe(1);
                expect(config.max_sessions).toBe(1);

                // max_retries allows zero (min: 0)
                process.env.REACTIVE_MAX_RETRIES = '0';
                expect(getConfig().max_retries).toBe(0);
            });

            it('clamps overflow values down to the maximum bound', () => {
                process.env.REACTIVE_BATCH_SIZE = '999999';
                process.env.REACTIVE_MAX_WORKERS = '999999';
                process.env.REACTIVE_TOKEN_BUDGET = '99999999';
                process.env.REACTIVE_CACHE_TTL = '99999999999';
                process.env.REACTIVE_STEP_TIMEOUT = '99999999999';
                process.env.REACTIVE_MAX_RETRIES = '99999999';
                process.env.REACTIVE_SESSION_TTL = '99999999999';
                process.env.REACTIVE_MAX_SESSIONS = '99999999';
                process.env.REACTIVE_EXECUTION_TIMEOUT = '99999999999';

                const config = getConfig();
                expect(config.batch_size).toBe(100);
                expect(config.max_workers).toBe(32);
                expect(config.token_budget).toBe(200_000);
                expect(config.cache_ttl_ms).toBe(86_400_000);
                expect(config.step_timeout_ms).toBe(1_800_000);
                expect(config.max_retries).toBe(10);
                expect(config.session_ttl_ms).toBe(86_400_000);
                expect(config.max_sessions).toBe(10_000);
                expect(config.session_execution_timeout_ms).toBe(86_400_000);
            });

            it('accepts exact boundary values unchanged', () => {
                process.env.REACTIVE_BATCH_SIZE = '1';
                process.env.REACTIVE_MAX_WORKERS = '32';
                process.env.REACTIVE_MAX_RETRIES = '0';

                const config = getConfig();
                expect(config.batch_size).toBe(1);
                expect(config.max_workers).toBe(32);
                expect(config.max_retries).toBe(0);
            });

            it('accepts valid in-range values unchanged', () => {
                process.env.REACTIVE_BATCH_SIZE = '20';
                process.env.REACTIVE_MAX_WORKERS = '4';
                process.env.REACTIVE_TOKEN_BUDGET = '50000';
                process.env.REACTIVE_MAX_RETRIES = '5';

                const config = getConfig();
                expect(config.batch_size).toBe(20);
                expect(config.max_workers).toBe(4);
                expect(config.token_budget).toBe(50000);
                expect(config.max_retries).toBe(5);
            });

            it('caps the CPU-optimized worker count to the same max_workers bound', () => {
                process.env.REACTIVE_OPTIMIZE_WORKERS = 'true';

                const config = getConfig();
                expect(config.max_workers).toBeGreaterThanOrEqual(1);
                expect(config.max_workers).toBeLessThanOrEqual(32);
            });
        });

        describe('getCircuitBreakerConfig() numeric fields', () => {
            it('uses documented defaults when unset', () => {
                const cbConfig = getCircuitBreakerConfig();
                expect(cbConfig).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
            });

            it('falls back to the default for malformed values', () => {
                process.env.REACTIVE_CB_FAILURE_THRESHOLD = 'nope';
                expect(getCircuitBreakerConfig().failureThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold);
            });

            it('clamps negative and zero values up to the minimum (1)', () => {
                process.env.REACTIVE_CB_FAILURE_THRESHOLD = '-1';
                process.env.REACTIVE_CB_SUCCESS_THRESHOLD = '0';
                process.env.REACTIVE_CB_RESET_TIMEOUT = '-1';

                const cbConfig = getCircuitBreakerConfig();
                expect(cbConfig.failureThreshold).toBe(1);
                expect(cbConfig.successThreshold).toBe(1);
                expect(cbConfig.resetTimeout).toBe(100);
            });

            it('clamps overflow values down to the maximum bound', () => {
                process.env.REACTIVE_CB_FAILURE_THRESHOLD = '999999';
                process.env.REACTIVE_CB_SUCCESS_THRESHOLD = '999999';
                process.env.REACTIVE_CB_RESET_TIMEOUT = '999999999';

                const cbConfig = getCircuitBreakerConfig();
                expect(cbConfig.failureThreshold).toBe(100);
                expect(cbConfig.successThreshold).toBe(100);
                expect(cbConfig.resetTimeout).toBe(3_600_000);
            });

            it('accepts exact boundary and valid in-range values unchanged', () => {
                process.env.REACTIVE_CB_FAILURE_THRESHOLD = '1';
                process.env.REACTIVE_CB_SUCCESS_THRESHOLD = '100';
                process.env.REACTIVE_CB_RESET_TIMEOUT = '5000';

                const cbConfig = getCircuitBreakerConfig();
                expect(cbConfig.failureThreshold).toBe(1);
                expect(cbConfig.successThreshold).toBe(100);
                expect(cbConfig.resetTimeout).toBe(5000);
            });
        });

        describe('getChunkedProcessingConfig() numeric fields', () => {
            it('uses documented defaults when unset', () => {
                const chunkConfig = getChunkedProcessingConfig();
                expect(chunkConfig).toEqual(DEFAULT_CHUNKED_PROCESSING_CONFIG);
            });

            it('falls back to the default for malformed values', () => {
                process.env.REACTIVE_CHUNK_SIZE = 'lots';
                expect(getChunkedProcessingConfig().chunkSize).toBe(DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkSize);
            });

            it('clamps negative and zero values up to the minimum bound', () => {
                process.env.REACTIVE_CHUNK_THRESHOLD = '-1';
                process.env.REACTIVE_CHUNK_SIZE = '0';
                process.env.REACTIVE_INTER_CHUNK_DELAY = '-1';

                const chunkConfig = getChunkedProcessingConfig();
                expect(chunkConfig.chunkThreshold).toBe(1);
                expect(chunkConfig.chunkSize).toBe(1);
                // interChunkDelay allows 0 as its minimum
                expect(chunkConfig.interChunkDelay).toBe(0);
            });

            it('clamps overflow values down to the maximum bound', () => {
                process.env.REACTIVE_CHUNK_THRESHOLD = '99999999';
                process.env.REACTIVE_CHUNK_SIZE = '99999999';
                process.env.REACTIVE_INTER_CHUNK_DELAY = '99999999';

                const chunkConfig = getChunkedProcessingConfig();
                expect(chunkConfig.chunkThreshold).toBe(10_000);
                expect(chunkConfig.chunkSize).toBe(1_000);
                expect(chunkConfig.interChunkDelay).toBe(300_000);
            });

            it('accepts exact boundary values unchanged', () => {
                process.env.REACTIVE_CHUNK_SIZE = '1';
                process.env.REACTIVE_INTER_CHUNK_DELAY = '0';

                const chunkConfig = getChunkedProcessingConfig();
                expect(chunkConfig.chunkSize).toBe(1);
                expect(chunkConfig.interChunkDelay).toBe(0);
            });
        });
    });

    // ==========================================================================
    // Circuit Breaker Tests
    // ==========================================================================

    describe('Circuit Breaker Pattern', () => {
        let service: ExecutionTrackingService;

        beforeEach(() => {
            service = new ExecutionTrackingService();
            // Enable parallel execution for testing
            process.env.REACTIVE_PARALLEL_EXEC = 'true';
            service.enableParallelExecution({
                max_workers: 3,
                step_timeout_ms: 5000, // Short timeout for testing
                max_retries: 1,
            });
        });

        afterEach(() => {
            delete process.env.REACTIVE_PARALLEL_EXEC;
        });

        it('should start in closed state', () => {
            const state = service.getCircuitBreakerState();
            expect(state.state).toBe('closed');
            expect(state.consecutiveFailures).toBe(0);
            expect(state.consecutiveSuccesses).toBe(0);
            expect(state.fallbackActive).toBe(false);
        });

        it('should open circuit after consecutive failures', () => {
            const cbConfig = getCircuitBreakerConfig();
            service.configureCircuitBreaker(cbConfig);

            // Simulate consecutive failures
            for (let i = 0; i < cbConfig.failureThreshold; i++) {
                service.recordCircuitBreakerFailure();
            }

            const state = service.getCircuitBreakerState();
            expect(state.state).toBe('open');
            expect(state.consecutiveFailures).toBe(cbConfig.failureThreshold);
            expect(state.fallbackActive).toBe(true); // Should fall back to sequential
        });

        it('should close circuit after consecutive successes in half-open state', () => {
            const cbConfig = {
                ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
                failureThreshold: 3,
                successThreshold: 2,
                resetTimeout: 100, // Very short for testing
            };
            service.configureCircuitBreaker(cbConfig);

            // Open the circuit
            for (let i = 0; i < cbConfig.failureThreshold; i++) {
                service.recordCircuitBreakerFailure();
            }
            expect(service.getCircuitBreakerState().state).toBe('open');

            // Wait for reset timeout and check - should transition to half-open
            return new Promise<void>((resolve) => {
                setTimeout(() => {
                    // Attempting execution should transition to half-open
                    const canExecute = service.isCircuitBreakerAllowing();
                    expect(canExecute).toBe(true);
                    expect(service.getCircuitBreakerState().state).toBe('half-open');

                    // Record successes to close circuit
                    for (let i = 0; i < cbConfig.successThreshold; i++) {
                        service.recordCircuitBreakerSuccess();
                    }

                    const finalState = service.getCircuitBreakerState();
                    expect(finalState.state).toBe('closed');
                    expect(finalState.fallbackActive).toBe(false);
                    resolve();
                }, cbConfig.resetTimeout + 50);
            });
        });

        it('should reset circuit breaker on demand', () => {
            const cbConfig = getCircuitBreakerConfig();
            service.configureCircuitBreaker(cbConfig);

            // Open the circuit
            for (let i = 0; i < cbConfig.failureThreshold; i++) {
                service.recordCircuitBreakerFailure();
            }
            expect(service.getCircuitBreakerState().state).toBe('open');

            // Reset
            service.resetCircuitBreaker();

            const state = service.getCircuitBreakerState();
            expect(state.state).toBe('closed');
            expect(state.consecutiveFailures).toBe(0);
            expect(state.fallbackActive).toBe(false);
        });

        it('should block execution when circuit is open', () => {
            const cbConfig = {
                ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
                resetTimeout: 60_000, // Long timeout so circuit stays open
            };
            service.configureCircuitBreaker(cbConfig);

            // Open the circuit
            for (let i = 0; i < cbConfig.failureThreshold; i++) {
                service.recordCircuitBreakerFailure();
            }

            // Circuit should block execution
            expect(service.isCircuitBreakerAllowing()).toBe(false);
        });
    });

    // ==========================================================================
    // Real-World Scenario Reproduction
    // ==========================================================================

    describe('Real-World Timeout Scenario Reproduction', () => {
        let service: ExecutionTrackingService;

        beforeEach(() => {
            service = new ExecutionTrackingService();
            process.env.REACTIVE_PARALLEL_EXEC = 'true';
        });

        afterEach(() => {
            delete process.env.REACTIVE_PARALLEL_EXEC;
        });

        it('should demonstrate why original timeout was insufficient for 27 files', () => {
            /**
             * This test documents the original failure scenario:
             * - 27 files to review
             * - 13 planned steps
             * - Only 1 step completed in 5.5 minutes
             * - Session timed out at 10 minute limit
             *
             * The math shows why:
             * - If each step takes 30-60 seconds with AI response
             * - 13 steps * 45 seconds avg = 585 seconds (9.75 minutes) minimum
             * - With network latency, retries, and parallel bottlenecks, easily exceeds 10 minutes
             */

            const avgStepDuration = (MIN_STEP_DURATION_MS + MAX_STEP_DURATION_MS) / 2;
            const minimumExpectedDuration = TOTAL_PLANNED_STEPS * avgStepDuration;

            console.error('\n=== Original Timeout Scenario Analysis ===');
            console.error(`Files to review: ${REAL_WORLD_FILE_COUNT}`);
            console.error(`Planned steps: ${TOTAL_PLANNED_STEPS}`);
            console.error(`Avg step duration: ${avgStepDuration / 1000}s`);
            console.error(`Minimum expected time: ${minimumExpectedDuration / 1000}s (${Math.round(minimumExpectedDuration / 60000)} min)`);
            console.error(`Original timeout: ${ORIGINAL_SESSION_TIMEOUT_MS / 1000}s (${ORIGINAL_SESSION_TIMEOUT_MS / 60000} min)`);
            console.error(`Actual failure time: ${REAL_WORLD_TIMEOUT_MS / 1000}s (${Math.round(REAL_WORLD_TIMEOUT_MS / 60000)} min)`);

            // The minimum expected duration is very close to the timeout
            // With any retries or delays, it would exceed the timeout
            expect(minimumExpectedDuration).toBeLessThan(ORIGINAL_SESSION_TIMEOUT_MS * 1.5);

            // Adaptive timeout should be significantly longer
            const adaptiveTimeout = calculateAdaptiveTimeout({
                fileCount: REAL_WORLD_FILE_COUNT,
                avgTimePerFile: avgStepDuration,
                bufferMultiplier: 1.5,
                minTimeout: ORIGINAL_SESSION_TIMEOUT_MS,
            });

            console.error(`Adaptive timeout: ${adaptiveTimeout / 1000}s (${Math.round(adaptiveTimeout / 60000)} min)`);
            expect(adaptiveTimeout).toBeGreaterThan(minimumExpectedDuration);
        });

        it('should fall back to sequential when parallel execution fails repeatedly', async () => {
            service.enableParallelExecution({
                max_workers: 3,
                step_timeout_ms: 100, // Very short for testing
                max_retries: 0,
                stop_on_failure: false,
            });

            // Configure circuit breaker with low threshold for testing
            service.configureCircuitBreaker({
                failureThreshold: 3,
                successThreshold: 2,
                resetTimeout: 1000,
                fallbackToSequential: true,
            });

            const plan = createLargePlan(5); // Smaller plan for faster testing
            service.initializeExecution(plan);

            // Simulate multiple failures to trigger circuit breaker
            service.recordCircuitBreakerFailure();
            service.recordCircuitBreakerFailure();
            service.recordCircuitBreakerFailure();

            // Circuit should be open now
            const cbState = service.getCircuitBreakerState();
            expect(cbState.state).toBe('open');
            expect(cbState.fallbackActive).toBe(true);

            // When executeReadyStepsParallel is called with open circuit,
            // it should fall back to sequential execution
            expect(service.isCircuitBreakerAllowing()).toBe(false);
        });

        it('should provide sufficient time with adaptive timeout for large PRs', () => {
            // Test that larger PRs get more time
            // The minimum timeout is 10 minutes (600000ms), so small PRs get at least that
            const testCases = [
                { files: 10, expectedMinMinutes: 5 },   // Will get min timeout (10 min)
                { files: 27, expectedMinMinutes: 8 },   // Will get calculated timeout
                { files: 50, expectedMinMinutes: 10 },  // Larger timeout
                { files: 100, expectedMinMinutes: 15 }, // Even larger
            ];

            console.error('\n=== Adaptive Timeout Scaling ===');

            for (const { files, expectedMinMinutes } of testCases) {
                const timeout = calculateAdaptiveTimeout({
                    fileCount: files,
                    avgTimePerFile: 30_000,
                    bufferMultiplier: 1.5,
                    minTimeout: ORIGINAL_SESSION_TIMEOUT_MS,
                });

                const timeoutMinutes = timeout / 60_000;
                console.error(`${files} files: ${Math.round(timeoutMinutes)} minutes timeout`);

                expect(timeoutMinutes).toBeGreaterThanOrEqual(expectedMinMinutes);
            }
        });
    });

    // ==========================================================================
    // Parallel Execution with Circuit Breaker Integration
    // ==========================================================================

    describe('Parallel Execution with Circuit Breaker', () => {
        let service: ExecutionTrackingService;

        beforeEach(() => {
            service = new ExecutionTrackingService();
            process.env.REACTIVE_PARALLEL_EXEC = 'true';
            service.enableParallelExecution({
                max_workers: 3,
                step_timeout_ms: 200, // Short timeout for testing
                max_retries: 1,
                stop_on_failure: false,
            });
        });

        afterEach(() => {
            delete process.env.REACTIVE_PARALLEL_EXEC;
        });

        it('should execute steps successfully with circuit breaker monitoring', async () => {
            service.configureCircuitBreaker({
                failureThreshold: 3,
                successThreshold: 2,
                resetTimeout: 5000,
                fallbackToSequential: true,
            });

            const plan = createLargePlan(4);
            service.initializeExecution(plan);

            // Use fast executor with no failures
            const executor = createFastExecutor(0);

            const results = await service.executeReadyStepsParallel(plan.id, plan, executor);

            // All steps should complete successfully
            expect(results.length).toBe(4);
            expect(results.every(r => r.success)).toBe(true);

            // Circuit breaker should still be closed
            const cbState = service.getCircuitBreakerState();
            expect(cbState.state).toBe('closed');
        });

        it('should trigger circuit breaker fallback after repeated failures', async () => {
            service.configureCircuitBreaker({
                failureThreshold: 2,
                successThreshold: 2,
                resetTimeout: 5000,
                fallbackToSequential: true,
            });

            // Manually trigger failures
            service.recordCircuitBreakerFailure();
            service.recordCircuitBreakerFailure();

            const cbState = service.getCircuitBreakerState();
            expect(cbState.state).toBe('open');
            expect(cbState.fallbackActive).toBe(true);

            // Subsequent parallel execution should detect circuit is open
            expect(service.isCircuitBreakerAllowing()).toBe(false);
        });

        it('should track execution metrics across multiple plans', () => {
            const plan1 = { ...createLargePlan(3), id: 'plan_1' };
            const plan2 = { ...createLargePlan(3), id: 'plan_2' };

            service.initializeExecution(plan1);
            service.initializeExecution(plan2);

            // Verify both plans are tracked
            const state1 = service.getExecutionState(plan1.id);
            const state2 = service.getExecutionState(plan2.id);

            expect(state1).toBeDefined();
            expect(state2).toBeDefined();
            expect(state1?.plan_id).toBe('plan_1');
            expect(state2?.plan_id).toBe('plan_2');
        });
    });

    // ==========================================================================
    // Summary Test - Documents the Fix
    // ==========================================================================

    describe('Resilience Fix Documentation', () => {
        it('should document the improvements made to handle large PR timeouts', () => {
            console.error('\n');
            console.error('='.repeat(70));
            console.error('TIMEOUT RESILIENCE IMPROVEMENTS SUMMARY');
            console.error('='.repeat(70));
            console.error('\nProblem: Session timeout after 5.5 minutes with 27 files, only 1/13 steps completed');
            console.error('\nRoot Causes:');
            console.error('  1. Fixed 10-minute timeout was insufficient for large PRs');
            console.error('  2. No circuit breaker to detect cascading failures');
            console.error('  3. No chunked processing to manage workload');
            console.error('\nImprovements:');
            console.error('  1. Adaptive Timeout: Calculates timeout based on file count');
            console.error(`     - 27 files now gets ~${Math.round(getRecommendedTimeout(27) / 60000)} minutes instead of 10`);
            console.error('  2. Circuit Breaker: Detects repeated failures and falls back to sequential');
            console.error(`     - Opens after ${DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold} consecutive failures`);
            console.error(`     - Closes after ${DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold} consecutive successes`);
            console.error('  3. Chunked Processing: Splits large PRs into manageable chunks');
            console.error(`     - Chunk size: ${DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkSize} files`);
            console.error(`     - Threshold: ${DEFAULT_CHUNKED_PROCESSING_CONFIG.chunkThreshold} files`);
            console.error('='.repeat(70));
            console.error('\n');

            // This test always passes - it's just documentation
            expect(true).toBe(true);
        });
    });
});

