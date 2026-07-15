/**
 * HTTP Server for Context Engine
 * 
 * Provides HTTP transport layer for VS Code extension and other HTTP clients.
 * This is an ADDITIVE layer - the existing stdio transport remains unchanged.
 * 
 * Architecture:
 * - Uses the same ContextServiceClient as the stdio server
 * - All tool calls delegate to existing service methods
 * - No modifications to core MCP logic
 */

import express, { type Express } from 'express';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import helmet from 'helmet';
import {
    isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { envInt, envString } from '../config/env.js';
import { featureEnabled } from '../config/features.js';
import {
    attachMcpHandlersWithClientCapabilities,
} from '../mcp/attachMcpHandlers.js';
import type { ContextServiceClient } from '../mcp/serviceClient.js';
import { MCP_SERVER_VERSION } from '../mcp/tools/manifest.js';
import {
    createServerCapabilities,
    type ToolRegistryEntry,
} from '../mcp/server.js';
import { initializePlanManagementServices } from '../mcp/tools/planManagement.js';
import { initializeContextPackStore } from '../context/contextPackStore.js';
import type { ContextSafetyMode } from '../security/contextPolicy.js';
import {
    ClientCapabilitiesManager,
    attachClientCapabilitiesHandlers,
} from '../mcp/capabilities/clientCapabilities.js';
import { renderPrometheusMetrics, setGauge } from '../metrics/metrics.js';
import {
    createHttpAuthHook,
    isHttpAuthEnabled,
    isHttpAuthPolicyReady,
    parseHttpAuthTokenRegistry,
    type HttpAuthHook,
} from './authScopes.js';
import { assertBindTargetAuthReady } from './bindTarget.js';
import {
    createCorsMiddleware,
    validateAllowedOrigin,
    loggingMiddleware,
    observabilityMiddleware,
    errorHandler,
    HttpError,
    createApiRateLimitMiddleware,
    createMcpConnectionRateLimitMiddleware,
    createRequestTimeoutMiddleware,
    createHttpAuthMiddleware,
} from './middleware/index.js';
import { updateRequestContext } from '../telemetry/requestContext.js';
import {
    createHealthRouter,
    createStatusRouter,
    createToolsRouter,
} from './routes/index.js';

type McpHttpSession = {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
    clientCapabilitiesManager: ClientCapabilitiesManager;
    closed: boolean;
    closeServerPromise?: Promise<void>;
    /** Epoch ms of the last request handled for this session (R2 idle-TTL tracking). */
    lastActivityMs: number;
};

/** Reason a stateful MCP HTTP session was disposed, for logs/metrics only. */
type McpSessionEvictionReason = 'idle_ttl' | 'shutdown';

type HttpMcpServerBundle = {
    server: McpServer;
    clientCapabilitiesManager: ClientCapabilitiesManager;
};

const DEFAULT_HTTP_BIND_HOST = '127.0.0.1';
const API_JSON_LIMIT = '1mb';
// MCP payloads can carry large prompts/context; keep the ceiling generous to
// avoid breaking legitimate traffic. Per roadmap Appendix E.1 SSE carve-out:
// /mcp must not inherit the /api/v1 body-size limit.
const MCP_JSON_LIMIT = '16mb';
const API_REQUEST_TIMEOUT_MS = 30_000;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const SERVER_HEADERS_TIMEOUT_MS = 70_000;

// ============================================================================
// R2: bounded stateful MCP HTTP session limits.
//
// Bounds mirror the shape (and behavior contract) of the C4 reactive config
// bounds for session_ttl_ms / max_sessions in src/reactive/config.ts: malformed
// env input falls back to the default, well-formed out-of-range input is
// clamped to the nearest bound, and explicit constructor options are clamped
// the same way so tests and production callers get identical guarantees.
// Sessions remain fully stateful; these limits only bound idle resource
// lifetime and concurrent count - they never switch the transport to
// stateless behavior.
// ============================================================================
const SESSION_IDLE_TTL_BOUNDS = { min: 60_000, max: 86_400_000 } as const; // 1 minute..24 hours
const DEFAULT_SESSION_IDLE_TTL_MS = 1_800_000; // 30 minutes
const MAX_SESSIONS_BOUNDS = { min: 1, max: 10_000 } as const;
const DEFAULT_MAX_SESSIONS = 1_000;
const SESSION_SWEEP_INTERVAL_BOUNDS = { min: 1_000, max: 3_600_000 } as const; // 1 second..1 hour
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000; // 1 minute
const SESSION_ADMISSION_RETRY_AFTER_SECONDS = 5;

function clampBoundedInt(value: number, bounds: { min: number; max: number }): number {
    if (!Number.isFinite(value)) return bounds.min;
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

function createHttpMcpServer(
    serviceClient: ContextServiceClient,
    toolRegistryEntries?: ToolRegistryEntry[],
    options?: {
        workspacePath?: string;
        contextSafetyMode?: ContextSafetyMode;
    }
): HttpMcpServerBundle {
    const clientCapabilitiesManager = new ClientCapabilitiesManager();
    const server = new McpServer(
        {
            name: 'context-engine',
            version: MCP_SERVER_VERSION,
        },
        {
            capabilities: createServerCapabilities({ resources: true, prompts: true }),
        }
    );

    attachClientCapabilitiesHandlers(server, clientCapabilitiesManager);
    attachMcpHandlersWithClientCapabilities(server, serviceClient, clientCapabilitiesManager, {
        toolRegistryEntries: toolRegistryEntries ?? undefined,
        readResource: {
            workspaceRoot: options?.workspacePath ?? serviceClient.getWorkspacePath(),
            serviceClient,
            mode: options?.contextSafetyMode,
        },
    });

    return { server, clientCapabilitiesManager };
}

export interface HttpServerOptions {
    /** Port to listen on (default: 3333) */
    port?: number;
    /** Host interface to bind the HTTP server to (default: 127.0.0.1) */
    bindHost?: string;
    /** Server version for health endpoint */
    version?: string;
    /** Optional auth hook for HTTP MCP routes. Disabled by default. */
    authHook?: HttpAuthHook;
    /** Optional tool registry override (primarily for integration tests). */
    toolRegistryEntries?: ToolRegistryEntry[];
    /** Optional context safety mode for policy-enforced resource reads. */
    contextSafetyMode?: ContextSafetyMode;
    /** Optional clock override for deterministic session TTL/eviction tests (default: Date.now). */
    now?: () => number;
    /**
     * Idle TTL for stateful MCP HTTP sessions, in ms, before the sweep evicts them.
     * Bounded to [60_000, 86_400_000] (1 minute to 24 hours), same shape as C4's
     * session_ttl_ms. Out-of-range values are clamped; default 1_800_000 (30 minutes).
     */
    sessionIdleTtlMs?: number;
    /**
     * Hard cap on concurrent stateful MCP HTTP sessions. New session admission is
     * rejected once this many sessions are active. Bounded to [1, 10_000], same
     * shape as C4's max_sessions. Default 1_000.
     */
    maxSessions?: number;
    /**
     * Interval between automatic idle-session sweeps, in ms. Bounded to
     * [1_000, 3_600_000] (1 second to 1 hour); default 60_000 (1 minute).
     * Pass 0 to disable the automatic timer entirely (tests can call
     * `runSessionSweep()` directly against an injected `now` clock instead).
     */
    sessionSweepIntervalMs?: number;
}

/**
 * HTTP Server wrapper for Context Engine.
 * 
 * Exposes MCP tools via REST-like HTTP endpoints for VS Code extension
 * and other HTTP clients.
 */
export class ContextEngineHttpServer {
    private app: Express;
    private server: Server | null = null;
    private readonly port: number;
    private readonly bindHost: string;
    private readonly version: string;
    private readonly authHook?: HttpAuthHook;
    private readonly authPolicyReady: boolean;
    private readonly toolRegistryEntries?: ToolRegistryEntry[];
    private readonly contextSafetyMode?: ContextSafetyMode;
    private readonly mcpSessions = new Map<string, McpHttpSession>();
    private readonly now: () => number;
    private readonly sessionIdleTtlMs: number;
    private readonly maxSessions: number;
    private readonly sessionSweepIntervalMs: number;
    private sessionSweepTimer: ReturnType<typeof setInterval> | null = null;
    private sessionsEvictedTotal = 0;
    private sessionsAdmissionRejectedTotal = 0;

    constructor(
        private readonly serviceClient: ContextServiceClient,
        options: HttpServerOptions = {}
    ) {
        const workspacePath =
            typeof (serviceClient as { getWorkspacePath?: unknown }).getWorkspacePath === 'function'
                ? (serviceClient as { getWorkspacePath: () => string }).getWorkspacePath()
                : process.cwd();
        initializePlanManagementServices(workspacePath);
        initializeContextPackStore(workspacePath);
        this.port = options.port ?? 3333;
        this.bindHost = options.bindHost ?? envString('CE_HTTP_HOST', DEFAULT_HTTP_BIND_HOST) ?? DEFAULT_HTTP_BIND_HOST;
        this.version = options.version ?? '1.0.0';
        this.authHook = options.authHook ?? this.resolveDefaultAuthHook();
        // A caller-supplied auth hook is treated as an intentionally ready
        // policy; otherwise readiness comes from the env-driven token
        // registry (auth enabled AND at least one non-empty token).
        this.authPolicyReady = options.authHook !== undefined || isHttpAuthPolicyReady();
        this.toolRegistryEntries = options.toolRegistryEntries;
        this.contextSafetyMode = options.contextSafetyMode;
        this.now = options.now ?? Date.now;
        this.sessionIdleTtlMs = clampBoundedInt(
            options.sessionIdleTtlMs ?? envInt(
                'CE_HTTP_MCP_SESSION_IDLE_TTL_MS',
                DEFAULT_SESSION_IDLE_TTL_MS,
                SESSION_IDLE_TTL_BOUNDS
            ),
            SESSION_IDLE_TTL_BOUNDS
        );
        this.maxSessions = clampBoundedInt(
            options.maxSessions ?? envInt(
                'CE_HTTP_MCP_MAX_SESSIONS',
                DEFAULT_MAX_SESSIONS,
                MAX_SESSIONS_BOUNDS
            ),
            MAX_SESSIONS_BOUNDS
        );
        const rawSweepIntervalMs = options.sessionSweepIntervalMs ?? envInt(
            'CE_HTTP_MCP_SESSION_SWEEP_INTERVAL_MS',
            DEFAULT_SESSION_SWEEP_INTERVAL_MS,
            SESSION_SWEEP_INTERVAL_BOUNDS
        );
        // 0 explicitly disables the automatic timer (used by deterministic
        // fake-clock tests); any other value is bounded like the other fields.
        this.sessionSweepIntervalMs = rawSweepIntervalMs <= 0
            ? 0
            : clampBoundedInt(rawSweepIntervalMs, SESSION_SWEEP_INTERVAL_BOUNDS);
        this.app = this.createApp();
        this.updateSessionGauges();
        this.startSessionSweepTimer();
    }

    /**
     * Create and configure Express application.
     */
    private createApp(): Express {
        const app = express();

        // Middleware
        app.use(createCorsMiddleware());
        app.use(loggingMiddleware);
        app.use(observabilityMiddleware);

        // Health endpoint at root level
        app.use(createHealthRouter(this.version, {
            serviceClient: this.serviceClient,
            getSessionHealth: () => ({
                activeCount: this.getActiveSessionCount(),
                maxSessions: this.getMaxSessions(),
                admissionRejectedTotal: this.sessionsAdmissionRejectedTotal,
            }),
        }));

        // Optional Prometheus-style metrics endpoint
        if (featureEnabled('metrics') && featureEnabled('http_metrics')) {
            app.get('/metrics', (_req, res) => {
                try {
                    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
                    res.send(renderPrometheusMetrics());
                } catch (error) {
                    console.error('[HTTP] Metrics rendering failed:', error);
                    res.status(500).send('Internal Server Error');
                }
            });
        }

        // API routes under /api/v1
        app.use('/api/v1', createRequestTimeoutMiddleware(API_REQUEST_TIMEOUT_MS));
        app.use('/api/v1', createApiRateLimitMiddleware());
        app.use('/api/v1', createHttpAuthMiddleware());
        app.use('/api/v1', express.json({ limit: API_JSON_LIMIT }));
        app.use('/api/v1', helmet());
        app.use('/api/v1', createStatusRouter(this.serviceClient));
        app.use('/api/v1', createToolsRouter(this.serviceClient));
        app.use('/mcp', express.json({ limit: MCP_JSON_LIMIT }));
        app.use('/mcp', helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false,
            crossOriginResourcePolicy: false,
        }));
        app.use('/mcp', createMcpConnectionRateLimitMiddleware());
        app.use('/mcp', async (req, _res, next) => {
            try {
                await this.enforceMcpTransportPolicy(req);
                next();
            } catch (error) {
                next(error);
            }
        });
        const mcpHandler = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            try {
                await this.handleMcpRequest(req, res);
            } catch (error) {
                next(error);
            }
        };
        app.get('/mcp', mcpHandler);
        app.post('/mcp', mcpHandler);
        app.delete('/mcp', async (req, res, next) => {
            try {
                await this.handleMcpSessionDelete(req, res);
            } catch (error) {
                next(error);
            }
        });

        // Error handler (must be last)
        app.use(errorHandler);

        return app;
    }

    /**
     * Start the HTTP server.
     */
    async start(): Promise<void> {
        // Fail closed: classify the bind target and require a ready,
        // non-empty auth policy for any non-loopback host before we ever
        // call listen(). This must throw synchronously (before the socket
        // opens) - never a silent unauthenticated remote bind.
        assertBindTargetAuthReady(this.bindHost, this.authPolicyReady);

        return new Promise((resolve, reject) => {
            try {
                if (this.bindHost === '0.0.0.0' || this.bindHost === '::') {
                    console.warn(`[HTTP] WARNING: Binding to ${this.bindHost} exposes the HTTP transport to the network.`);
                }

                this.server = this.app.listen(this.port, this.bindHost, () => {
                    if (!this.server) {
                        reject(new Error('HTTP server failed to initialize'));
                        return;
                    }

                    // Server-level (Node http.Server) timeouts are shared across all routes
                    // on this server. We intentionally pick SSE-safe values so `/mcp` streams
                    // survive idle periods. The tighter `/api/v1` per-request timeout
                    // (API_REQUEST_TIMEOUT_MS) is enforced by createRequestTimeoutMiddleware
                    // at the route level, not via socket-level timeouts. See roadmap Appendix E.1.
                    this.server.requestTimeout = 0;
                    this.server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
                    this.server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
                    const displayHost = this.bindHost === '0.0.0.0' ? 'localhost' : this.bindHost;
                    console.error(`[HTTP] Server listening on http://${displayHost}:${this.port}`);
                    console.error(`[HTTP] Health: http://${displayHost}:${this.port}/health`);
                    console.error(`[HTTP] API: http://${displayHost}:${this.port}/api/v1/`);
                    console.error(`[HTTP] MCP: http://${displayHost}:${this.port}/mcp`);
                    if (featureEnabled('metrics') && featureEnabled('http_metrics')) {
                        console.error(`[HTTP] Metrics: http://${displayHost}:${this.port}/metrics`);
                    }
                    resolve();
                });

                this.server.on('error', (err: NodeJS.ErrnoException) => {
                    if (err.code === 'EADDRINUSE') {
                        console.error(`[HTTP] Port ${this.port} is already in use`);
                    }
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Stop the HTTP server.
     *
     * R1c: evicts every stateful MCP HTTP session *before* asking the
     * underlying Node server to close, then force-drops any remaining
     * sockets instead of passively waiting on `server.close()`'s callback.
     * `http.Server#close()` only stops accepting *new* connections -- it
     * waits for existing ones to end on their own, which would let a
     * standing `/mcp` SSE stream (or an idle keep-alive REST connection)
     * block shutdown indefinitely. Evicting sessions first drives the MCP
     * SDK's own transport-close -> abort-in-flight-request mechanism
     * (`Protocol#_onclose`, which aborts every outstanding `tools/call`'s
     * `AbortSignal`), and `closeAllConnections()` guarantees any lingering
     * REST request observes its own request-close abort (`runAbortableTool`
     * in `src/http/routes/tools.ts`) instead of draining for up to
     * `SERVER_KEEP_ALIVE_TIMEOUT_MS`.
     */
    async stop(): Promise<void> {
        this.stopSessionSweepTimer();
        const server = this.server;
        if (!server) {
            return;
        }

        const entries = Array.from(this.mcpSessions.entries());
        await Promise.allSettled(
            entries.map(([sessionId, session]) => this.evictSession(sessionId, session, 'shutdown'))
        );

        await new Promise<void>((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.error('[HTTP] Server stopped');
                resolve();
            });
            // Force-drop any connection still open (in-flight REST request or
            // idle keep-alive socket) so close() settles promptly rather than
            // waiting on natural connection drain/timeout.
            server.closeAllConnections?.();
        });

        this.server = null;
    }

    /**
     * Get the port the server is listening on.
     */
    getPort(): number {
        return this.port;
    }

    /**
     * Check if the server is running.
     */
    isRunning(): boolean {
        return this.server !== null;
    }

    /**
     * Get the Express app instance (for testing).
     */
    getApp(): Express {
        return this.app;
    }

    /** Number of currently active stateful MCP HTTP sessions. */
    getActiveSessionCount(): number {
        return this.mcpSessions.size;
    }

    /** Configured hard cap on concurrent stateful MCP HTTP sessions. */
    getMaxSessions(): number {
        return this.maxSessions;
    }

    /** Configured idle TTL (ms) before a stateful MCP HTTP session is evicted. */
    getSessionIdleTtlMs(): number {
        return this.sessionIdleTtlMs;
    }

    /**
     * Force an idle-session sweep pass. Production servers rely on the
     * internal timer; this is the deterministic entry point for tests that
     * inject a `now` clock override (see `HttpServerOptions.now`) to exercise
     * TTL eviction without waiting on real timers.
     */
    async runSessionSweep(): Promise<number> {
        return this.sweepIdleSessions();
    }

    private startSessionSweepTimer(): void {
        if (this.sessionSweepIntervalMs <= 0) {
            return;
        }
        this.sessionSweepTimer = setInterval(() => {
            this.sweepIdleSessions().catch((error) => {
                console.error('[HTTP] Idle MCP session sweep failed:', error);
            });
        }, this.sessionSweepIntervalMs);
        // Housekeeping timer must never keep the process alive on its own.
        this.sessionSweepTimer.unref?.();
    }

    private stopSessionSweepTimer(): void {
        if (this.sessionSweepTimer) {
            clearInterval(this.sessionSweepTimer);
            this.sessionSweepTimer = null;
        }
    }

    private touchSession(session: McpHttpSession): void {
        session.lastActivityMs = this.now();
    }

    private updateSessionGauges(): void {
        setGauge(
            'context_engine_http_mcp_sessions_active',
            undefined,
            this.mcpSessions.size,
            'Active stateful MCP HTTP sessions currently tracked by the server.'
        );
        setGauge(
            'context_engine_http_mcp_sessions_max',
            undefined,
            this.maxSessions,
            'Configured hard cap on concurrent stateful MCP HTTP sessions.'
        );
        setGauge(
            'context_engine_http_mcp_sessions_evicted_total',
            undefined,
            this.sessionsEvictedTotal,
            'Total stateful MCP HTTP sessions evicted for idle TTL or shutdown.'
        );
        setGauge(
            'context_engine_http_mcp_sessions_admission_rejected_total',
            undefined,
            this.sessionsAdmissionRejectedTotal,
            'Total stateful MCP HTTP session admissions rejected because the session cap was reached.'
        );
    }

    /**
     * Deterministically dispose one session's transport/server resources and
     * remove it from the active-session map. Idempotent: a session that is
     * already closed (e.g. by a concurrent client-initiated close) is a no-op.
     */
    private async evictSession(
        sessionId: string,
        session: McpHttpSession,
        reason: McpSessionEvictionReason
    ): Promise<void> {
        if (session.closed) {
            return;
        }
        session.closed = true;
        this.mcpSessions.delete(sessionId);
        this.sessionsEvictedTotal += 1;
        if (!session.closeServerPromise) {
            session.closeServerPromise = (async () => {
                try {
                    await session.transport.close();
                } catch (error) {
                    console.error(`[HTTP] Failed to close MCP session transport during ${reason} eviction:`, error);
                }
                try {
                    await session.server.close();
                } catch (error) {
                    console.error(`[HTTP] Failed to close MCP session server during ${reason} eviction:`, error);
                }
            })();
        }
        await session.closeServerPromise;
        this.updateSessionGauges();
    }

    /**
     * Evict every session whose last activity is at or past the idle TTL.
     * Uses the injected clock (`this.now`) so tests can drive eviction
     * deterministically without real timers.
     */
    private async sweepIdleSessions(now: number = this.now()): Promise<number> {
        const idleSessionIds: string[] = [];
        for (const [sessionId, session] of this.mcpSessions.entries()) {
            if (session.closed) {
                continue;
            }
            if (now - session.lastActivityMs >= this.sessionIdleTtlMs) {
                idleSessionIds.push(sessionId);
            }
        }

        for (const sessionId of idleSessionIds) {
            const session = this.mcpSessions.get(sessionId);
            if (!session) {
                continue;
            }
            await this.evictSession(sessionId, session, 'idle_ttl');
        }

        if (idleSessionIds.length > 0) {
            console.error(
                `[HTTP] Evicted ${idleSessionIds.length} idle MCP session(s) past the ${this.sessionIdleTtlMs}ms TTL`
            );
        }

        return idleSessionIds.length;
    }

    private async handleMcpRequest(
        req: express.Request,
        res: express.Response
    ): Promise<void> {
        const requestSessionId = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(requestSessionId) ? requestSessionId[0] : requestSessionId;
        updateRequestContext({
            transport: 'mcp',
            sessionId,
        });

        if (sessionId) {
            const session = this.mcpSessions.get(sessionId);
            if (!session) {
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32001,
                        message: `MCP session not found: ${sessionId}`,
                    },
                    id: req.body?.id ?? null,
                });
                return;
            }

            this.touchSession(session);

            if (req.method === 'GET') {
                await session.transport.handleRequest(req, res);
            } else {
                await session.transport.handleRequest(req, res, req.body);
            }
            return;
        }

        const requestId = (req.body as { id?: unknown } | undefined)?.id ?? null;

        if (!isInitializeRequest(req.body)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: requestId,
            });
            return;
        }

        // R2: reject new session admission once the hard cap is reached
        // rather than silently growing the session map. Existing sessions
        // are never evicted to make room; the cap only bounds admission of
        // brand-new sessions.
        if (this.mcpSessions.size >= this.maxSessions) {
            this.sessionsAdmissionRejectedTotal += 1;
            this.updateSessionGauges();
            res.setHeader('Retry-After', String(SESSION_ADMISSION_RETRY_AFTER_SECONDS));
            res.status(503).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: `MCP session capacity reached (max ${this.maxSessions} concurrent sessions)`,
                },
                id: requestId,
            });
            return;
        }

        let session: McpHttpSession | undefined;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
                if (session) {
                    this.mcpSessions.set(initializedSessionId, session);
                    this.updateSessionGauges();
                }
                updateRequestContext({
                    transport: 'mcp',
                    sessionId: initializedSessionId,
                });
            },
        });
        const { server, clientCapabilitiesManager } = createHttpMcpServer(this.serviceClient, this.toolRegistryEntries, {
            workspacePath: this.serviceClient.getWorkspacePath(),
            contextSafetyMode: this.contextSafetyMode,
        });
        session = { server, transport, clientCapabilitiesManager, closed: false, lastActivityMs: this.now() };

        transport.onclose = () => {
            const activeSessionId = transport.sessionId;
            if (!session || session.closed) {
                return;
            }
            session.closed = true;
            if (activeSessionId) {
                this.mcpSessions.delete(activeSessionId);
            }
            if (!session.closeServerPromise) {
                session.closeServerPromise = server.close().catch((error) => {
                    console.error('[HTTP] Failed to close MCP session server:', error);
                });
            }
            this.updateSessionGauges();
        };

        await server.connect(transport);
        if (transport.sessionId) {
            updateRequestContext({
                transport: 'mcp',
                sessionId: transport.sessionId,
            });
        }
        await transport.handleRequest(req, res, req.body);
        this.touchSession(session);
        updateRequestContext({
            sessionId: transport.sessionId,
        });
    }

    private async handleMcpSessionDelete(
        req: express.Request,
        res: express.Response
    ): Promise<void> {
        const requestSessionId = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(requestSessionId) ? requestSessionId[0] : requestSessionId;
        updateRequestContext({
            transport: 'mcp',
            sessionId,
        });

        if (!sessionId) {
            res.status(404).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: 'MCP session not found',
                },
                id: null,
            });
            return;
        }

        const session = this.mcpSessions.get(sessionId);
        if (!session) {
            res.status(404).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: `MCP session not found: ${sessionId}`,
                },
                id: null,
            });
            return;
        }

        if (!session.closed) {
            session.closed = true;
            this.mcpSessions.delete(sessionId);
            await session.transport.close();
            if (!session.closeServerPromise) {
                session.closeServerPromise = session.server.close().catch((error) => {
                    console.error('[HTTP] Failed to close MCP session server:', error);
                });
            }
            await session.closeServerPromise;
            this.updateSessionGauges();
        }

        res.status(204).end();
    }

    private resolveDefaultAuthHook(): HttpAuthHook | undefined {
        if (!isHttpAuthEnabled()) {
            return undefined;
        }

        const registry = parseHttpAuthTokenRegistry();
        return createHttpAuthHook(registry);
    }

    private async enforceMcpTransportPolicy(req: express.Request): Promise<void> {
        const requestOrigin = req.headers.origin;
        const origin = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin;
        validateAllowedOrigin(origin);

        if (req.method === 'OPTIONS') {
            return;
        }

        if (!this.authHook) {
            return;
        }

        const decision = await this.authHook(req);
        if (!decision.authorized) {
            throw new HttpError(
                decision.statusCode ?? 401,
                decision.message ?? 'Unauthorized MCP transport request'
            );
        }
    }
}
