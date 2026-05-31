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
import { envString } from '../config/env.js';
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
import { renderPrometheusMetrics } from '../metrics/metrics.js';
import {
    createHttpAuthHook,
    isHttpAuthEnabled,
    parseHttpAuthTokenRegistry,
    type HttpAuthHook,
} from './authScopes.js';
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
};

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
    private readonly toolRegistryEntries?: ToolRegistryEntry[];
    private readonly contextSafetyMode?: ContextSafetyMode;
    private readonly mcpSessions = new Map<string, McpHttpSession>();

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
        this.toolRegistryEntries = options.toolRegistryEntries;
        this.contextSafetyMode = options.contextSafetyMode;
        this.app = this.createApp();
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
        app.use(createHealthRouter(this.version));

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
        return new Promise((resolve, reject) => {
            try {
                if (this.bindHost === '0.0.0.0') {
                    console.warn('[HTTP] WARNING: Binding to 0.0.0.0 exposes the HTTP transport to the network.');
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
     */
    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }

            const closeMcpSessions = async (): Promise<void> => {
                const sessions = Array.from(new Set(this.mcpSessions.values()));
                this.mcpSessions.clear();
                await Promise.allSettled(
                    sessions.map(async ({ transport, server }) => {
                        await transport.close();
                        await server.close();
                    })
                );
            };

            this.server.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    closeMcpSessions()
                        .then(() => {
                            console.error('[HTTP] Server stopped');
                            this.server = null;
                            resolve();
                        })
                        .catch(reject);
                }
            });
        });
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

            if (req.method === 'GET') {
                await session.transport.handleRequest(req, res);
            } else {
                await session.transport.handleRequest(req, res, req.body);
            }
            return;
        }

        if (!isInitializeRequest(req.body)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: req.body?.id ?? null,
            });
            return;
        }

        let session: McpHttpSession | undefined;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (initializedSessionId) => {
                if (session) {
                    this.mcpSessions.set(initializedSessionId, session);
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
        session = { server, transport, clientCapabilitiesManager, closed: false };

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
        };

        await server.connect(transport);
        if (transport.sessionId) {
            updateRequestContext({
                transport: 'mcp',
                sessionId: transport.sessionId,
            });
        }
        await transport.handleRequest(req, res, req.body);
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
