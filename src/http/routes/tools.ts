/**
 * Tools Endpoints
 * 
 * HTTP routes for MCP tool operations.
 * Delegates to existing ContextServiceClient methods.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { Router as createRouter } from 'express';
import type { ContextServiceClient, ContextOptions } from '../../mcp/serviceClient.js';
import { buildActivePlanHandoff } from '../../mcp/handoff/activePlan.js';
import { handleCreatePlan, type CreatePlanArgs } from '../../mcp/tools/plan.js';
import { handleEnhancePrompt } from '../../mcp/tools/enhance.js';
import { handleCodebaseRetrieval, type CodebaseRetrievalArgs } from '../../mcp/tools/codebaseRetrieval.js';
import { handleFindCallers, type FindCallersArgs } from '../../mcp/tools/findCallers.js';
import { handleFindCallees, type FindCalleesArgs } from '../../mcp/tools/findCallees.js';
import { handleTraceSymbol, type TraceSymbolArgs } from '../../mcp/tools/traceSymbol.js';
import { handleImpactAnalysis, type ImpactAnalysisArgs } from '../../mcp/tools/impactAnalysis.js';
import { handleWhyThisContext, type WhyThisContextArgs } from '../../mcp/tools/whyThisContext.js';
import { handleReviewChanges, type ReviewChangesArgs } from '../../mcp/tools/codeReview.js';
import { handleReviewGitDiff, type ReviewGitDiffArgs } from '../../mcp/tools/gitReview.js';
import { handleReviewAuto, type ReviewAutoArgs } from '../../mcp/tools/reviewAuto.js';
import { getToolManifest } from '../../mcp/tools/manifest.js';
import type { CodebaseRetrievalOutput } from '../../mcp/tools/codebaseRetrieval.js';
import { badRequest, HttpError } from '../middleware/errorHandler.js';
import { envMs } from '../../config/env.js';
import { validateExternalSources, validatePathScopeGlobs } from '../../mcp/tooling/validation.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30000;
const CONTEXT_TIMEOUT_MS = 60000;
const AI_TOOL_TIMEOUT_MS = 300000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_PLAN_TIMEOUT_MS = 30_000;
const MAX_PLAN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HTTP_PLAN_TIMEOUT_MS = 6 * 60 * 1000;
const PLAN_TOOL_TIMEOUT_MS = envMs('CE_HTTP_PLAN_TIMEOUT_MS', DEFAULT_HTTP_PLAN_TIMEOUT_MS, {
    min: MIN_PLAN_TIMEOUT_MS,
    max: MAX_PLAN_TIMEOUT_MS,
});

function parseExternalSourcesOrBadRequest(value: unknown) {
    try {
        return validateExternalSources(value, 'external_sources');
    } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid external_sources parameter');
    }
}

type HttpContextHandoffMode = 'none' | 'active_plan';

function parseContextHandoffModeOrBadRequest(value: unknown): HttpContextHandoffMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value === 'none' || value === 'active_plan') {
        return value;
    }
    throw badRequest('options.handoff_mode must be one of none, active_plan');
}

function parseContextPlanIdOrBadRequest(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !value.trim()) {
        throw badRequest('options.plan_id must be a non-empty string when provided');
    }
    return value.trim();
}

function parseJsonToolResult<T>(payload: string, operation: string): T {
    try {
        return JSON.parse(payload) as T;
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown parse error';
        throw new HttpError(500, `${operation} returned non-JSON output: ${reason}`);
    }
}

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

function createRequestAbortError(operation: string, reason?: unknown): Error {
    const message =
        typeof reason === 'string' && reason.trim()
            ? reason.trim()
            : `${operation} aborted by client`;
    const error = new HttpError(499, message);
    error.name = 'AbortError';
    return error;
}

function attachRequestAbortSignal(req: Request, controller: AbortController, operation: string): () => void {
    const abort = (reason?: unknown): void => {
        if (!controller.signal.aborted) {
            controller.abort(createRequestAbortError(operation, reason));
        }
    };

    const onAborted = () => abort('request aborted');
    const onClose = () => abort('request closed');

    req.on('aborted', onAborted);
    req.on('close', onClose);

    return () => {
        req.off('aborted', onAborted);
        req.off('close', onClose);
    };
}

export async function runAbortableTool<T>(
    req: Request,
    timeoutMs: number,
    operation: string,
    executor: (signal: AbortSignal) => Promise<T>,
    res?: Pick<Response, 'setTimeout' | 'socket'>
): Promise<T> {
    const previousRequestTimeoutMs =
        typeof req.socket?.timeout === 'number' && Number.isFinite(req.socket.timeout)
            ? req.socket.timeout
            : undefined;
    const previousResponseTimeoutMs =
        typeof res?.socket?.timeout === 'number' && Number.isFinite(res.socket.timeout)
            ? res.socket.timeout
            : undefined;

    if (typeof req.setTimeout === 'function') {
        req.setTimeout(timeoutMs);
    }
    if (res && typeof res.setTimeout === 'function') {
        res.setTimeout(timeoutMs);
    }

    const controller = new AbortController();
    const detach = attachRequestAbortSignal(req, controller, operation);
    const timeoutError = new HttpError(
        504,
        `${operation} timed out after ${timeoutMs}ms. Check server logs and authentication.`
    );

    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        let timeoutId: NodeJS.Timeout | undefined;

        const finalize = (): void => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
            if (previousRequestTimeoutMs !== undefined) {
                if (typeof req.setTimeout === 'function') {
                    req.setTimeout(previousRequestTimeoutMs);
                }
            }
            if (previousResponseTimeoutMs !== undefined && res && typeof res.setTimeout === 'function') {
                res.setTimeout(previousResponseTimeoutMs);
            }
            detach();
            controller.signal.removeEventListener('abort', onAbort);
        };

        const settleResolve = (value: T): void => {
            if (settled) return;
            settled = true;
            finalize();
            resolve(value);
        };

        const settleReject = (error: unknown): void => {
            if (settled) return;
            settled = true;
            finalize();
            reject(error);
        };

        const onAbort = (): void => {
            const reason = controller.signal.reason;
            settleReject(reason instanceof Error ? reason : createRequestAbortError(operation, reason));
        };

        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeoutId = setTimeout(() => {
            controller.abort(timeoutError);
        }, timeoutMs);

        Promise.resolve(executor(controller.signal))
            .then(settleResolve)
            .catch(settleReject);
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
 * - POST /api/v1/symbol-search - Deterministic symbol-first search
 * - POST /api/v1/find-callers - Deterministic direct callers lookup
 * - POST /api/v1/find-callees - Deterministic direct callees lookup
 * - POST /api/v1/symbol-definition - Deterministic single-result symbol definition lookup
 * - POST /api/v1/call-relationships - Deterministic callers and callees for a known symbol
 * - POST /api/v1/trace-symbol - Deterministic combined symbol trace
 * - POST /api/v1/impact-analysis - Deterministic direct impact analysis
 * - POST /api/v1/codebase-retrieval - Codebase retrieval (uses searchAndAsk)
 * - POST /api/v1/enhance-prompt - Enhance prompt (uses searchAndAsk)
 * - POST /api/v1/plan - Create implementation plan
 * - POST /api/v1/context - Get context for prompt
 * - POST /api/v1/why-this-context - Explain context selection receipts
 * - POST /api/v1/file - Get file contents
 * - POST /api/v1/tool-manifest - Tool manifest and discoverability metadata
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
                serviceClient.indexWorkspaceInBackground().catch((err) => {
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
     * POST /symbol-search
     * Deterministic local symbol search
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[] }
     */
    router.post(
        '/symbol-search',
        asyncHandler(async (req, res) => {
            const {
                symbol,
                top_k = 10,
                bypass_cache = false,
                include_paths,
                exclude_paths,
            } = req.body || {};

            if (!symbol || typeof symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            const results = await withTimeout(
                serviceClient.symbolSearch(symbol, top_k, {
                    bypassCache: bypass_cache === true,
                    includePaths: validatePathScopeGlobs(include_paths, 'include_paths'),
                    excludePaths: validatePathScopeGlobs(exclude_paths, 'exclude_paths'),
                }),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Symbol search'
            );
            res.json({
                results,
                metadata: {
                    symbol,
                    top_k,
                    resultCount: results.length,
                },
            });
        })
    );

    /**
     * POST /symbol-references
     * Deterministic local non-declaration symbol references
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[] }
     */
    router.post(
        '/symbol-references',
        asyncHandler(async (req, res) => {
            const {
                symbol,
                top_k = 10,
                bypass_cache = false,
                include_paths,
                exclude_paths,
            } = req.body || {};

            if (!symbol || typeof symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            const results = await withTimeout(
                serviceClient.symbolReferencesSearch(symbol, top_k, {
                    bypassCache: bypass_cache === true,
                    includePaths: validatePathScopeGlobs(include_paths, 'include_paths'),
                    excludePaths: validatePathScopeGlobs(exclude_paths, 'exclude_paths'),
                }),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Symbol references'
            );
            res.json({
                results,
                metadata: {
                    symbol,
                    top_k,
                    resultCount: results.length,
                },
            });
        })
    );

    /**
     * POST /find-callers
     * Deterministic direct caller lookup for a known function or method symbol
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[], language_hint?: string }
     */
    router.post(
        '/find-callers',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as FindCallersArgs;

            if (!args.symbol || typeof args.symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            res.json(
                parseJsonToolResult<Record<string, unknown>>(
                    await withTimeout(
                        handleFindCallers(args, serviceClient),
                        DEFAULT_TOOL_TIMEOUT_MS,
                        'Find callers'
                    ),
                    'Find callers'
                )
            );
        })
    );

    /**
     * POST /find-callees
     * Deterministic direct callee lookup for a known function or method symbol
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[], language_hint?: string }
     */
    router.post(
        '/find-callees',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as FindCalleesArgs;

            if (!args.symbol || typeof args.symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            res.json(
                parseJsonToolResult<Record<string, unknown>>(
                    await withTimeout(
                        handleFindCallees(args, serviceClient),
                        DEFAULT_TOOL_TIMEOUT_MS,
                        'Find callees'
                    ),
                    'Find callees'
                )
            );
        })
    );

    /**
     * POST /symbol-definition
     * Deterministic single-result symbol definition lookup
     * Body: { symbol: string, workspacePath?: string, language_hint?: string, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[] }
     */
    router.post(
        '/symbol-definition',
        asyncHandler(async (req, res) => {
            const {
                symbol,
                language_hint,
                bypass_cache = false,
                include_paths,
                exclude_paths,
            } = req.body || {};

            if (!symbol || typeof symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            const result = await withTimeout(
                serviceClient.symbolDefinition(symbol, {
                    bypassCache: bypass_cache === true,
                    includePaths: validatePathScopeGlobs(include_paths, 'include_paths'),
                    excludePaths: validatePathScopeGlobs(exclude_paths, 'exclude_paths'),
                    languageHint: typeof language_hint === 'string' ? language_hint : undefined,
                }),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Symbol definition'
            );
            res.json({
                result,
                metadata: {
                    symbol,
                    found: result.found,
                },
            });
        })
    );

    /**
     * POST /call-relationships
     * Deterministic callers/callees lookup for a known function or method symbol
     * Body: { symbol: string, direction?: 'callers'|'callees'|'both', top_k?: number, workspacePath?: string, language_hint?: string, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[] }
     */
    router.post(
        '/call-relationships',
        asyncHandler(async (req, res) => {
            const {
                symbol,
                direction = 'both',
                top_k = 20,
                language_hint,
                bypass_cache = false,
                include_paths,
                exclude_paths,
            } = req.body || {};

            if (!symbol || typeof symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }
            if (direction !== 'callers' && direction !== 'callees' && direction !== 'both') {
                throw badRequest('direction must be one of callers, callees, both');
            }
            if (typeof top_k !== 'number' || !Number.isFinite(top_k) || top_k < 1 || top_k > 100) {
                throw badRequest('top_k must be a number between 1 and 100');
            }

            const result = await withTimeout(
                serviceClient.callRelationships(symbol, {
                    direction,
                    topK: top_k,
                    bypassCache: bypass_cache === true,
                    includePaths: validatePathScopeGlobs(include_paths, 'include_paths'),
                    excludePaths: validatePathScopeGlobs(exclude_paths, 'exclude_paths'),
                    languageHint: typeof language_hint === 'string' ? language_hint : undefined,
                }),
                DEFAULT_TOOL_TIMEOUT_MS,
                'Call relationships'
            );
            res.json({
                result,
                metadata: {
                    symbol,
                    direction,
                    totalCallers: result.metadata.totalCallers,
                    totalCallees: result.metadata.totalCallees,
                },
            });
        })
    );

    /**
     * POST /trace-symbol
     * Deterministic symbol trace across definition, references, callers, and callees
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[], language_hint?: string }
     */
    router.post(
        '/trace-symbol',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as TraceSymbolArgs;

            if (!args.symbol || typeof args.symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            res.json(
                parseJsonToolResult<Record<string, unknown>>(
                    await withTimeout(
                        handleTraceSymbol(args, serviceClient),
                        DEFAULT_TOOL_TIMEOUT_MS,
                        'Trace symbol'
                    ),
                    'Trace symbol'
                )
            );
        })
    );

    /**
     * POST /impact-analysis
     * Deterministic direct impact analysis for a known symbol
     * Body: { symbol: string, top_k?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[], language_hint?: string }
     */
    router.post(
        '/impact-analysis',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as ImpactAnalysisArgs;

            if (!args.symbol || typeof args.symbol !== 'string') {
                throw badRequest('symbol is required and must be a string');
            }

            res.json(
                parseJsonToolResult<Record<string, unknown>>(
                    await withTimeout(
                        handleImpactAnalysis(args, serviceClient),
                        DEFAULT_TOOL_TIMEOUT_MS,
                        'Impact analysis'
                    ),
                    'Impact analysis'
                )
            );
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
            const args = (req.body || {}) as CodebaseRetrievalArgs;
            const { query, top_k = 10 } = args;

            if (!query || typeof query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            const toolResult = parseJsonToolResult<CodebaseRetrievalOutput>(
                await withTimeout(
                    handleCodebaseRetrieval(args, serviceClient),
                    DEFAULT_TOOL_TIMEOUT_MS,
                    'Codebase retrieval'
                ),
                'Codebase retrieval'
            );

            res.json({
                results: toolResult.results.map((result) => ({
                    ...result,
                    path: result.file,
                })),
                metadata: {
                    query,
                    top_k,
                    resultCount: toolResult.results.length,
                    ...toolResult.metadata,
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
            const { prompt, external_sources } = req.body || {};

            if (!prompt || typeof prompt !== 'string') {
                throw badRequest('prompt is required and must be a string');
            }

            const enhanced = await runAbortableTool(
                req,
                AI_TOOL_TIMEOUT_MS,
                'Prompt enhancement',
                (signal) => handleEnhancePrompt(
                    {
                        prompt,
                        external_sources: parseExternalSourcesOrBadRequest(external_sources),
                    },
                    serviceClient,
                    signal
                ),
                res
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

            const plan = await runAbortableTool(
                req,
                PLAN_TOOL_TIMEOUT_MS,
                'Plan generation',
                (signal) => (handleCreatePlan as unknown as (
                    args: CreatePlanArgs,
                    serviceClient: ContextServiceClient,
                    signal?: AbortSignal
                ) => Promise<string>)(args, serviceClient, signal),
                res
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
            const { query, options } = req.body || {};

            if (!query || typeof query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
                throw badRequest('options must be an object when provided');
            }

            const optionsRecord = (options ?? {}) as Record<string, unknown>;
            const {
                external_sources,
                handoff_mode: _handoffMode,
                plan_id: _planId,
                ...remainingOptions
            } = optionsRecord;
            const normalizedHandoffMode = parseContextHandoffModeOrBadRequest(
                optionsRecord.handoff_mode ?? optionsRecord.handoffMode
            );
            const normalizedPlanId = parseContextPlanIdOrBadRequest(
                optionsRecord.plan_id ?? optionsRecord.planId
            );
            if (normalizedHandoffMode === 'active_plan' && !normalizedPlanId) {
                throw badRequest('options.plan_id is required when options.handoff_mode is active_plan');
            }
            const normalizedOptions = {
                ...(remainingOptions as ContextOptions),
                externalSources: parseExternalSourcesOrBadRequest(external_sources),
                ...(normalizedHandoffMode === 'active_plan'
                    ? {
                        includeMemories: false,
                        includeDraftMemories: false,
                    }
                    : {}),
            } as ContextOptions;

            const context = await withTimeout(
                serviceClient.getContextForPrompt(query, normalizedOptions),
                CONTEXT_TIMEOUT_MS,
                'Context retrieval'
            );
            if (normalizedHandoffMode === 'active_plan' && normalizedPlanId) {
                const handoff = await withTimeout(
                    buildActivePlanHandoff(serviceClient, normalizedPlanId),
                    CONTEXT_TIMEOUT_MS,
                    'Context handoff'
                );
                res.json({
                    ...context,
                    handoff,
                });
                return;
            }
            res.json(context);
        })
    );

    /**
     * POST /why-this-context
     * Explain why files were selected into a context bundle
     * Body: { query: string, max_files?: number, token_budget?: number, include_related?: boolean, min_relevance?: number, bypass_cache?: boolean, include_paths?: string[], exclude_paths?: string[] }
     */
    router.post(
        '/why-this-context',
        asyncHandler(async (req, res) => {
            const args = (req.body || {}) as WhyThisContextArgs;

            if (!args.query || typeof args.query !== 'string') {
                throw badRequest('query is required and must be a string');
            }

            res.json(
                parseJsonToolResult<Record<string, unknown>>(
                    await withTimeout(
                        handleWhyThisContext(args, serviceClient),
                        CONTEXT_TIMEOUT_MS,
                        'Why this context'
                    ),
                    'Why this context'
                )
            );
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
     * POST /tool-manifest
     * Return the MCP tool manifest and discoverability metadata over REST
     */
    router.post(
        '/tool-manifest',
        asyncHandler(async (_req, res) => {
            res.json(getToolManifest());
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

            const resultJson = await runAbortableTool(
                req,
                AI_TOOL_TIMEOUT_MS,
                'Code review',
                (signal) =>
                    (handleReviewChanges as unknown as (
                        args: ReviewChangesArgs,
                        serviceClient: ContextServiceClient,
                        signal?: AbortSignal
                    ) => Promise<string>)(
                        { diff, file_contexts, options } as ReviewChangesArgs,
                        serviceClient,
                        signal
                    ),
                res
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

            const resultJson = await runAbortableTool(
                req,
                AI_TOOL_TIMEOUT_MS,
                'Git code review',
                (signal) =>
                    (handleReviewGitDiff as unknown as (
                        args: ReviewGitDiffArgs,
                        serviceClient: ContextServiceClient,
                        signal?: AbortSignal
                    ) => Promise<string>)(
                        { target, base, include_patterns, options } as ReviewGitDiffArgs,
                        serviceClient,
                        signal
                    ),
                res
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

            const resultJson = await runAbortableTool(
                req,
                AI_TOOL_TIMEOUT_MS,
                'Auto code review',
                (signal) =>
                    (handleReviewAuto as unknown as (
                        args: ReviewAutoArgs,
                        serviceClient: ContextServiceClient,
                        signal?: AbortSignal
                    ) => Promise<string>)(args, serviceClient, signal),
                res
            );
            const result = JSON.parse(resultJson);
            res.json(result);
        })
    );

    return router;
}
