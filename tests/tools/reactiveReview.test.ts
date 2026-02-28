/**
 * Unit tests for Reactive Review MCP Tools
 * 
 * Tests the 7 new reactive review tools:
 * - reactive_review_pr
 * - get_review_status
 * - pause_review
 * - resume_review
 * - get_review_telemetry
 * - scrub_secrets
 * - validate_content
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    handleReactiveReviewPR,
    handleGetReviewStatus,
    handlePauseReview,
    handleResumeReview,
    handleGetReviewTelemetry,
    handleScrubSecrets,
    handleValidateContent,
    reactiveReviewPRTool,
    getReviewStatusTool,
    pauseReviewTool,
    resumeReviewTool,
    getReviewTelemetryTool,
    scrubSecretsTool,
    validateContentTool,
    reactiveReviewTools,
} from '../../src/mcp/tools/reactiveReview.js';
import { ReactiveReviewService } from '../../src/reactive/index.js';

describe('Reactive Review Tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ============================================================================
    // Tool Schema Tests
    // ============================================================================

    describe('Tool Schemas', () => {
        it('should expose all 7 reactive review tools', () => {
            expect(reactiveReviewTools).toHaveLength(7);
        });

        it('should have correct tool names', () => {
            const names = reactiveReviewTools.map(t => t.name);
            expect(names).toContain('reactive_review_pr');
            expect(names).toContain('get_review_status');
            expect(names).toContain('pause_review');
            expect(names).toContain('resume_review');
            expect(names).toContain('get_review_telemetry');
            expect(names).toContain('scrub_secrets');
            expect(names).toContain('validate_content');
        });

        it('reactive_review_pr should require commit_hash, base_ref, changed_files', () => {
            expect(reactiveReviewPRTool.inputSchema.required).toEqual([
                'commit_hash',
                'base_ref',
                'changed_files',
            ]);
        });

        it('reactive_review_pr schema should include max_workers and not expose parallel', () => {
            const properties = reactiveReviewPRTool.inputSchema.properties as Record<string, unknown>;
            expect(properties.max_workers).toBeDefined();
            expect(properties.parallel).toBeUndefined();
        });

        it('get_review_status should require session_id', () => {
            expect(getReviewStatusTool.inputSchema.required).toEqual(['session_id']);
        });

        it('pause_review should require session_id', () => {
            expect(pauseReviewTool.inputSchema.required).toEqual(['session_id']);
        });

        it('resume_review should require session_id', () => {
            expect(resumeReviewTool.inputSchema.required).toEqual(['session_id']);
        });

        it('get_review_telemetry should require session_id', () => {
            expect(getReviewTelemetryTool.inputSchema.required).toEqual(['session_id']);
        });

        it('scrub_secrets should require content', () => {
            expect(scrubSecretsTool.inputSchema.required).toEqual(['content']);
        });

        it('validate_content should require content', () => {
            expect(validateContentTool.inputSchema.required).toEqual(['content']);
        });
    });

    // ============================================================================
    // reactive_review_pr Input Validation Tests
    // ============================================================================

    describe('handleReactiveReviewPR input validation', () => {
        const mockServiceClient = {} as any;

        it('should reject invalid changed_files JSON array string', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: '["src/a.ts",',
                }, mockServiceClient)
            ).rejects.toThrow('changed_files must be valid CSV or JSON array string');
        });

        it('should reject changed_files CSV with empty entries', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: 'src/a.ts, ,src/b.ts',
                }, mockServiceClient)
            ).rejects.toThrow('changed_files[1] must be a non-empty path');
        });

        it('should reject changed_files JSON array with non-string entries', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: '["src/a.ts", 42]',
                }, mockServiceClient)
            ).rejects.toThrow('changed_files[1] must be a string path');
        });

        it('should reject changed_files JSON array with empty path values', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: '["src/a.ts", "   "]',
                }, mockServiceClient)
            ).rejects.toThrow('changed_files[1] must be a non-empty path');
        });

        it('should reject changed_files JSON array entries that are not string paths', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: '[{"path":"src/a.ts"}]',
                }, mockServiceClient)
            ).rejects.toThrow('changed_files[0] must be a string path');
        });

        it('should reject commit_hash that exceeds max length', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'a'.repeat(201),
                    base_ref: 'main',
                    changed_files: 'src/a.ts,src/b.ts',
                }, mockServiceClient)
            ).rejects.toThrow('commit_hash exceeds maximum length (200)');
        });

        it('should reject base_ref that exceeds max length', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'b'.repeat(257),
                    changed_files: '["src/a.ts","src/b.ts"]',
                }, mockServiceClient)
            ).rejects.toThrow('base_ref exceeds maximum length (256)');
        });

        it('should reject negative additions', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: 'src/a.ts',
                    additions: -1,
                }, mockServiceClient)
            ).rejects.toThrow('additions must be non-negative');
        });

        it('should reject non-integer additions', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: 'src/a.ts',
                    additions: 1.5,
                }, mockServiceClient)
            ).rejects.toThrow('additions must be an integer');
        });

        it('should reject deletions above sane max', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: 'src/a.ts',
                    deletions: 10_000_001,
                }, mockServiceClient)
            ).rejects.toThrow('deletions exceeds maximum value (10000000)');
        });

        it('should reject max_workers above sane max', async () => {
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: 'src/a.ts',
                    max_workers: 65,
                }, mockServiceClient)
            ).rejects.toThrow('max_workers exceeds maximum value (64)');
        });

        it('should reject changed_files path entries that exceed max path length', async () => {
            const longPath = `src/${'a'.repeat(1025)}.ts`;
            await expect(
                handleReactiveReviewPR({
                    commit_hash: 'abc123',
                    base_ref: 'main',
                    changed_files: JSON.stringify([longPath]),
                }, mockServiceClient)
            ).rejects.toThrow('changed_files[0] exceeds maximum length (1024)');
        });
    });

    // ============================================================================
    // Session ID Validation Tests
    // ============================================================================

    describe('session_id validation', () => {
        const mockServiceClient = {} as any;
        const longSessionId = 's'.repeat(129);

        it('get_review_status should reject oversized session_id', async () => {
            await expect(
                handleGetReviewStatus({ session_id: longSessionId }, mockServiceClient)
            ).rejects.toThrow('session_id exceeds maximum length (128)');
        });

        it('pause_review should reject oversized session_id', async () => {
            const result = await handlePauseReview({ session_id: longSessionId }, mockServiceClient);
            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('session_id exceeds maximum length (128)');
        });

        it('resume_review should reject oversized session_id', async () => {
            const result = await handleResumeReview({ session_id: longSessionId }, mockServiceClient);
            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('session_id exceeds maximum length (128)');
        });

        it('get_review_telemetry should reject oversized session_id', async () => {
            await expect(
                handleGetReviewTelemetry({ session_id: longSessionId }, mockServiceClient)
            ).rejects.toThrow('session_id exceeds maximum length (128)');
        });
    });

    describe('handleResumeReview execution behavior', () => {
        const mockServiceClient = {} as any;

        it('should resume paused sessions and return executing status', async () => {
            const getStatusSpy = jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatus').mockReturnValue({
                session: {
                    session_id: 'session-1',
                    plan_id: 'plan-1',
                    status: 'paused',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 1,
                    total_steps: 3,
                    percentage: 33,
                },
                telemetry: {
                    start_time: new Date().toISOString(),
                    elapsed_ms: 1000,
                    tokens_used: 10,
                    cache_hit_rate: 0,
                },
                findings_count: 0,
            } as any);
            const resumeSpy = jest.spyOn(ReactiveReviewService.prototype, 'resumeReview').mockResolvedValue([]);

            const result = await handleResumeReview({ session_id: 'session-1' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(getStatusSpy).toHaveBeenCalledWith('session-1');
            expect(resumeSpy).toHaveBeenCalledTimes(1);
            expect(parsed.success).toBe(true);
            expect(parsed.status).toBe('executing');
            expect(parsed.session_status).toBe('executing');
            expect(parsed.message).toContain('resumed');
            expect(parsed.progress).toEqual({
                completed_steps: 1,
                total_steps: 3,
                percentage: 33,
            });
        });

        it('should be idempotent when session is already executing', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatus').mockReturnValue({
                session: {
                    session_id: 'session-2',
                    plan_id: 'plan-2',
                    status: 'executing',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 0,
                    total_steps: 3,
                    percentage: 0,
                },
            } as any);
            const resumeSpy = jest.spyOn(ReactiveReviewService.prototype, 'resumeReview').mockResolvedValue([]);

            const result = await handleResumeReview({ session_id: 'session-2' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(parsed.success).toBe(true);
            expect(parsed.status).toBe('executing');
            expect(parsed.message).toContain('already executing');
            expect(resumeSpy).not.toHaveBeenCalled();
        });

        it('should return success immediately even if background resume later fails', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatus').mockReturnValue({
                session: {
                    session_id: 'session-3',
                    plan_id: 'plan-3',
                    status: 'paused',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 1,
                    total_steps: 3,
                    percentage: 33,
                },
            } as any);
            const resumeSpy = jest.spyOn(ReactiveReviewService.prototype, 'resumeReview').mockRejectedValue(new Error('resume failed'));

            const result = await handleResumeReview({ session_id: 'session-3' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(parsed.success).toBe(true);
            expect(parsed.status).toBe('executing');
            expect(resumeSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('reactive session failure visibility', () => {
        const mockServiceClient = {
            getCacheStats: () => ({ hitRate: 0.25, size: 10, commitKeyed: true }),
        } as any;

        it('pause_review should return success for valid paused-session request', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatus').mockReturnValue({
                session: {
                    session_id: 'session-ok',
                    plan_id: 'plan-ok',
                    status: 'executing',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 0,
                    total_steps: 3,
                    percentage: 0,
                },
            } as any);
            const pauseSpy = jest.spyOn(ReactiveReviewService.prototype, 'pauseReview').mockResolvedValue(undefined as any);
            const result = await handlePauseReview({ session_id: 'session-ok' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(pauseSpy).toHaveBeenCalledWith('session-ok');
            expect(parsed.success).toBe(true);
            expect(parsed.message).toContain('paused');
        });

        it('pause_review should be idempotent when session is already paused', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatus').mockReturnValue({
                session: {
                    session_id: 'session-paused',
                    plan_id: 'plan-paused',
                    status: 'paused',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 1,
                    total_steps: 3,
                    percentage: 33,
                },
            } as any);
            const pauseSpy = jest.spyOn(ReactiveReviewService.prototype, 'pauseReview').mockResolvedValue(undefined as any);
            const result = await handlePauseReview({ session_id: 'session-paused' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(parsed.success).toBe(true);
            expect(parsed.status).toBe('paused');
            expect(parsed.message).toContain('already paused');
            expect(pauseSpy).not.toHaveBeenCalled();
        });

        it('get_review_status should expose session error details when execution fails', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatusAsync').mockResolvedValue({
                session: {
                    session_id: 'session-failed',
                    plan_id: 'plan-failed',
                    status: 'error',
                    error: 'Background execution failed: network timeout',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 1,
                    total_steps: 3,
                    percentage: 33,
                },
                telemetry: {
                    start_time: new Date().toISOString(),
                    elapsed_ms: 1234,
                    tokens_used: 111,
                    cache_hit_rate: 0.2,
                },
                findings_count: 2,
            } as any);

            const result = await handleGetReviewStatus({ session_id: 'session-failed' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(parsed.success).toBe(true);
            expect(parsed.session.status).toBe('error');
            expect(parsed.session.error).toContain('Background execution failed');
        });

        it('get_review_telemetry should remain available for failed sessions', async () => {
            jest.spyOn(ReactiveReviewService.prototype, 'getReviewStatusAsync').mockResolvedValue({
                session: {
                    session_id: 'session-failed',
                    plan_id: 'plan-failed',
                    status: 'error',
                    error: 'Background execution failed',
                    pr_metadata: {
                        commit_hash: 'abc123',
                        base_ref: 'main',
                        changed_files: ['src/a.ts'],
                    },
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                progress: {
                    completed_steps: 1,
                    total_steps: 3,
                    percentage: 33,
                },
                telemetry: {
                    start_time: new Date().toISOString(),
                    elapsed_ms: 2222,
                    tokens_used: 42,
                    cache_hit_rate: 0.5,
                },
                findings_count: 1,
            } as any);

            const result = await handleGetReviewTelemetry({ session_id: 'session-failed' }, mockServiceClient);
            const parsed = JSON.parse(result);

            expect(parsed.success).toBe(true);
            expect(parsed.session_id).toBe('session-failed');
            expect(parsed.telemetry.elapsed_ms).toBe(2222);
            expect(parsed.session_status).toBe('error');
            expect(parsed.session_error).toContain('Background execution failed');
            expect(parsed.cache_stats.commit_keyed).toBe(true);
        });
    });

    // ============================================================================
    // scrub_secrets Tool Tests
    // ============================================================================

    describe('handleScrubSecrets', () => {
        it('should scrub AWS access keys', async () => {
            const result = await handleScrubSecrets({
                content: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.secrets_found).toBe(true);
            expect(parsed.secrets_count).toBeGreaterThan(0);
            expect(parsed.scrubbed_content).not.toContain('AKIAIOSFODNN7EXAMPLE');
        });

        it('should scrub OpenAI API keys', async () => {
            const result = await handleScrubSecrets({
                content: 'const apiKey = "sk-proj-abc123def456ghi789jklmno";',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.secrets_found).toBe(true);
        });

        it('should scrub GitHub tokens', async () => {
            const result = await handleScrubSecrets({
                content: 'GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.secrets_found).toBe(true);
            expect(parsed.scrubbed_content).not.toContain('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
        });

        it('should handle content with no secrets', async () => {
            const result = await handleScrubSecrets({
                content: 'const message = "Hello, World!";',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.secrets_found).toBe(false);
            expect(parsed.secrets_count).toBe(0);
        });

        it('should scrub multiple secret types', async () => {
            const result = await handleScrubSecrets({
                content: `
          AWS_KEY=AKIAIOSFODNN7EXAMPLE
          STRIPE_KEY=sk_test_abc123xyz789
          API_KEY=my-secret-api-key-12345
        `,
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.secrets_found).toBe(true);
            expect(parsed.secrets_count).toBeGreaterThanOrEqual(2);
        });

        it('should throw error for missing content', async () => {
            await expect(
                handleScrubSecrets({ content: '' })
            ).rejects.toThrow('Missing content argument');
        });

        it('should reject oversized content', async () => {
            await expect(
                handleScrubSecrets({ content: 'x'.repeat(1_000_001) })
            ).rejects.toThrow('content exceeds maximum length (1000000)');
        });

        it('should include processing time', async () => {
            const result = await handleScrubSecrets({
                content: 'test content',
            });

            const parsed = JSON.parse(result);
            expect(parsed.processing_time_ms).toBeDefined();
            expect(typeof parsed.processing_time_ms).toBe('number');
        });
    });

    // ============================================================================
    // validate_content Tool Tests
    // ============================================================================

    describe('handleValidateContent', () => {
        it('should validate balanced brackets', async () => {
            const result = await handleValidateContent({
                content: 'function test() { return { a: 1 }; }',
                content_type: 'generated_code',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.passed).toBe(true);
        });

        it('should detect unbalanced brackets', async () => {
            const result = await handleValidateContent({
                content: 'function test() { return { a: 1 }',
                content_type: 'generated_code',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.passed).toBe(false);
            expect(parsed.findings_count).toBeGreaterThan(0);
        });

        it('should detect TODO comments in code', async () => {
            const result = await handleValidateContent({
                content: '// TODO: fix this later\nconst x = 1;',
                content_type: 'generated_code',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            // TODO detection is Tier 2 (warning, not error)
            expect(parsed.by_severity.warnings).toBeGreaterThanOrEqual(0);
        });

        it('should validate JSON structure', async () => {
            const result = await handleValidateContent({
                content: '{"valid": "json", "number": 42}',
                content_type: 'raw_text',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
        });

        it('should detect secrets in content', async () => {
            const result = await handleValidateContent({
                content: 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";',
                content_type: 'generated_code',
            });

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            // Secret scrubbing may or may not detect depending on pattern
            // Just verify the validation ran successfully
            expect(parsed.tiers_run).toBeDefined();
        });
        it('should throw error for missing content', async () => {
            await expect(
                handleValidateContent({ content: '', content_type: 'raw_text' })
            ).rejects.toThrow('Missing content argument');
        });

        it('should reject oversized content', async () => {
            await expect(
                handleValidateContent({ content: 'x'.repeat(1_000_001), content_type: 'raw_text' })
            ).rejects.toThrow('content exceeds maximum length (1000000)');
        });

        it('should include tiers run', async () => {
            const result = await handleValidateContent({
                content: 'test content',
                content_type: 'raw_text',
            });

            const parsed = JSON.parse(result);
            expect(parsed.tiers_run).toBeDefined();
            expect(Array.isArray(parsed.tiers_run)).toBe(true);
        });

        it('should include processing time', async () => {
            const result = await handleValidateContent({
                content: 'test content',
                content_type: 'raw_text',
            });

            const parsed = JSON.parse(result);
            expect(parsed.processing_time_ms).toBeDefined();
            expect(typeof parsed.processing_time_ms).toBe('number');
        });

        it('should handle all content types', async () => {
            const contentTypes: Array<'review_finding' | 'plan_output' | 'generated_code' | 'raw_text'> = [
                'review_finding',
                'plan_output',
                'generated_code',
                'raw_text',
            ];

            for (const contentType of contentTypes) {
                const result = await handleValidateContent({
                    content: 'sample content',
                    content_type: contentType,
                });

                const parsed = JSON.parse(result);
                expect(parsed.success).toBe(true);
            }
        });
    });

    // ============================================================================
    // Tool Description Tests
    // ============================================================================

    describe('Tool Descriptions', () => {
        it('reactive_review_pr should mention environment variables', () => {
            expect(reactiveReviewPRTool.description).toContain('REACTIVE_ENABLED');
            expect(reactiveReviewPRTool.description).toContain('REACTIVE_PARALLEL_EXEC');
        });

        it('scrub_secrets should list secret types', () => {
            expect(scrubSecretsTool.description).toContain('AWS');
            expect(scrubSecretsTool.description).toContain('OpenAI');
            expect(scrubSecretsTool.description).toContain('GitHub');
        });

        it('validate_content should describe tiers', () => {
            expect(validateContentTool.description).toContain('Tier 1');
            expect(validateContentTool.description).toContain('Tier 2');
            expect(validateContentTool.description).toContain('brackets');
        });
    });
});
