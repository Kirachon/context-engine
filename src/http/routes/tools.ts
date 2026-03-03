/**
 * Tools Endpoints
 * 
 * HTTP routes for MCP tool operations.
 * Delegates to existing ContextServiceClient methods.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { Router as createRouter } from 'express';
import type { ContextServiceClient, ContextOptions } from '../../mcp/serviceClient.js';
import { handleCreatePlan, type CreatePlanArgs } from '../../mcp/tools/plan.js';
import { handleEnhancePrompt } from '../../mcp/tools/enhance.js';
import { handleReviewChanges, type ReviewChangesArgs } from '../../mcp/tools/codeReview.js';
import { handleReviewGitDiff, type ReviewGitDiffArgs } from '../../mcp/tools/gitReview.js';
import { handleReviewAuto, type ReviewAutoArgs } from '../../mcp/tools/reviewAuto.js';
import { badRequest, HttpError } from '../middleware/errorHandler.js';
import { envMs } from '../../config/env.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30000;
const CONTEXT_TIMEOUT_MS = 60000;
const AI_TOOL_TIMEOUT_MS = 120000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_PLAN_TIMEOUT_MS = 30_000;
const MAX_PLAN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HTTP_PLAN_TIMEOUT_MS = 6 * 60 * 1000;
const PLAN_TOOL_TIMEOUT_MS = envMs('CE_HTTP_PLAN_TIMEOUT_MS', DEFAULT_HTTP_PLAN_TIMEOUT_MS, {
    min: MIN_PLAN_TIMEOUT_MS,
    max: MAX_PLAN_TIMEOUT_MS,
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new HttpError(504, `${operation} timed out after ${timeoutMs}ms. Check server logs and authentication.`));
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

/**
 * Async handler wrapper to catch promise rejections.
 */
function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Create tools router with all tool endpoints.
 *
 * Endpoints:
 * - POST /api/v1/index - Index workspace
 * - POST /api/v1/search - Semantic search
 * - POST /api/v1/codebase-retrieval - Codebase retrieval (uses searchAndAsk)
 * - POST /api/v1/enhance-prompt - Enhance prompt (uses searchAndAsk)
 * - POST /api/v1/plan - Create implementation plan
 * - POST /api/v1/context - Get context for prompt
 * - POST /api/v1/file - Get file contents
 * - POST /api/v1/review-changes - Review code changes from diff
 * - POST /api/v1/review-git-diff - Review code changes from git automatically
 * - POST /api/v1/review-auto - Auto-select review tool (diff vs git)
 */
export function createToolsRouter(serviceClient: ContextServiceClient): Router {
    const router = createRouter();

    /**
     * POST /index
     * Index the workspace
     * Body: { background?: boolean }
     */
    router.post(
        '/index',
        asyncHandler(async (req, res) => {
            const { background = false } = req.body || {};

            if (background) {
                // Start indexing in background and return immediately
                serviceClient.indexWorkspace().catch((err) => {
                    console.error('[HTTP] Background indexing failed:', err);
                });
                res.json({
                    success: true,
                    message: 'Indexing started in background',
                });
                return;
            }

            const result = await withTimeout(
                serviceClient.indexWorkspace(),
                INDEX_TIMEOUT_MS,
                'Indexing workspace'
            );
            res.json({
                success: true,
                ...result,
            });
        })
    );

    /**
     * POST /search
     * Semantic search
     * Body: { query: string, top_k?: number }
     */
    router.post(
        '/search',
        asyncHandler(async (req, res) => {
            const { query, top_k = 10 } = req.body || {};

            if (!query || typeof query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            const results = await withTimeout(
                serviceClient.semanticSearch(query, top_k),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Semantic search'
            );
            res.json({
                results,
                metadata: {
                    query,
                    top_k,
                    resultCount: results.length,
                },
            });
        })
    );

    /**
     * POST /codebase-retrieval
     * Codebase retrieval using searchAndAsk
     * Body: { query: string, top_k?: number }
     */
    router.post(
        '/codebase-retrieval',
        asyncHandler(async (req, res) => {
            const { query, top_k = 10 } = req.body || {};

            if (!query || typeof query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            // Use semantic search for codebase retrieval
            const searchResults = await withTimeout(
                serviceClient.semanticSearch(query, top_k),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Codebase retrieval'
            );
            const status = serviceClient.getIndexStatus();

            const results = searchResults.map((r) => ({
                path: r.path,
                content: r.content,
                score: r.relevanceScore || r.score || 0,
                lines: r.lines,
                reason: `Semantic match for: "${query}"`,
            }));

            res.json({
                results,
                metadata: {
                    workspace: status.workspace,
                    lastIndexed: status.lastIndexed,
                    query,
                    top_k,
                    resultCount: results.length,
                },
            });
        })
    );

    /**
     * POST /enhance-prompt
     * Enhance a prompt with codebase context using AI
     * Body: { prompt: string }
     */
    router.post(
        '/enhance-prompt',
        asyncHandler(async (req, res) => {
            const { prompt } = req.body || {};

            if (!prompt || typeof prompt !== 'string') {
                throw badRequest('prompt is required and must be a string');
            }

            const enhanced = await withTimeout(
                handleEnhancePrompt({ prompt }, serviceClient),
                AI_TOOL_TIMEOUT_MS,
                'Prompt enhancement'
            );

            res.json({
                enhanced,
                original: prompt,
            });
        })
    );

    /**
     * POST /plan
     * Create an implementation plan
     * Body: { task: string, max_context_files?: number, context_token_budget?: number, generate_diagrams?: boolean, mvp_only?: boolean }
     */
    router.post(
        '/plan',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as CreatePlanArgs;

            if (!args.task || typeof args.task !== 'string') {
                throw badRequest('task is required and must be a string');
            }

            const plan = await withTimeout(
                handleCreatePlan(args, serviceClient),
                PLAN_TOOL_TIMEOUT_MS,
                'Plan generation'
            );

            res.json({ plan });
        })
    );

    /**
     * POST /context
     * Get context for a prompt
     * Body: { query: string, options?: ContextOptions }
     */
    router.post(
        '/context',
        asyncHandler(async (req, res) => {
            const { query, options = {} } = req.body || {};

            if (!query || typeof query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            const context = await withTimeout(
                serviceClient.getContextForPrompt(query, options as ContextOptions),
                CONTEXT_TIMEOUT_MS,
                'Context retrieval'
            );
            res.json(context);
        })
    );

    /**
     * POST /file
     * Get file contents
     * Body: { path: string }
     */
    router.post(
        '/file',
        asyncHandler(async (req, res) => {
            const { path: filePath } = req.body || {};

            if (!filePath || typeof filePath !== 'string') {
                throw badRequest('path is required and must be a string');
            }

            const content = await withTimeout(
                serviceClient.getFile(filePath),
                DEFAULT_TOOL_TIMEOUT_MS,
                'File read'
            );
            res.json({
                path: filePath,
                content,
            });
        })
    );

    /**
     * POST /review-changes
     * Review code changes from a diff
     * Body: { diff: string, file_contexts?: FileContext[], options?: ReviewOptions }
     */
    router.post(
        '/review-changes',
        asyncHandler(async (req, res) => {
            const { diff, file_contexts, options } = req.body || {};

            if (!diff || typeof diff !== 'string') {
                throw badRequest('diff is required and must be a string');
            }

            const resultJson = await withTimeout(
                handleReviewChanges({ diff, file_contexts, options } as ReviewChangesArgs, serviceClient),
                AI_TOOL_TIMEOUT_MS,
                'Code review'
            );
            const result = JSON.parse(resultJson);
            res.json(result);
        })
    );

    /**
     * POST /review-git-diff
     * Review code changes from git automatically
     * Body: { target?: string, base?: string, include_patterns?: string[], options?: ReviewOptions }
     */
    router.post(
        '/review-git-diff',
        asyncHandler(async (req, res) => {
            const { target, base, include_patterns, options } = req.body || {};

            const resultJson = await withTimeout(
                handleReviewGitDiff({ target, base, include_patterns, options } as ReviewGitDiffArgs, serviceClient),
                AI_TOOL_TIMEOUT_MS,
                'Git code review'
            );
            const result = JSON.parse(resultJson);
            res.json(result);
        })
    );

    /**
     * POST /review-auto
     * Automatically chooses the best review tool.
     * Body: ReviewAutoArgs
     */
    router.post(
        '/review-auto',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as ReviewAutoArgs;

            const resultJson = await withTimeout(
                handleReviewAuto(args, serviceClient),
                AI_TOOL_TIMEOUT_MS,
                'Auto code review'
            );
            const result = JSON.parse(resultJson);
            res.json(result);
        })
    );

    return router;
}
