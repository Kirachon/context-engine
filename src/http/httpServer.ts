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
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { featureEnabled } from '../config/features.js';
import type { ContextServiceClient } from '../mcp/serviceClient.js';
import { MCP_SERVER_VERSION } from '../mcp/tools/manifest.js';
import {
    PROMPT_DEFINITIONS,
    buildPromptByName,
    buildResourceList,
    buildToolRegistryEntries,
    createServerCapabilities,
    readResourceByUri,
} from '../mcp/server.js';
import { initializePlanManagementServices } from '../mcp/tools/planManagement.js';
import { renderPrometheusMetrics } from '../metrics/metrics.js';
import {
    createCorsMiddleware,
    loggingMiddleware,
    errorHandler,
} from './middleware/index.js';
import { updateRequestContext } from '../telemetry/requestContext.js';
import {
    createHealthRouter,
    createStatusRouter,
    createToolsRouter,
} from './routes/index.js';

type SignalAwareToolHandler = (args: unknown, signal?: AbortSignal) => Promise<string>;

type McpHttpSession = {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
};

function createHttpMcpServer(serviceClient: ContextServiceClient): McpServer {
    const server = new McpServer(
        {
            name: 'context-engine',
            version: MCP_SERVER_VERSION,
        },
        {
            capabilities: createServerCapabilities({ resources: true, prompts: true }),
        }
    );

    const toolRegistryEntries = buildToolRegistryEntries(serviceClient);
    const tools = toolRegistryEntries.map((entry) => entry.tool);
    const toolHandlers = new Map<string, SignalAwareToolHandler>(
        toolRegistryEntries.map((entry) => [entry.tool.name, entry.handler])
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: await buildResourceList(),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
        readResourceByUri(request.params.uri)
    );
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PROMPT_DEFINITIONS,
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
        buildPromptByName(request.params.name, request.params.arguments ?? {})
    );
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;
        const handler = toolHandlers.get(name);

        if (!handler) {
            throw new Error(`Unknown tool: ${name}`);
        }

        const result = await handler(args, extra.signal);
        return {
            content: [
                {
                    type: 'text',
                    text: result,
                },
            ],
        };
    });

    return server;
}

export interface HttpServerOptions {
    /** Port to listen on (default: 3333) */
    port?: number;
    /** Server version for health endpoint */
    version?: string;
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
    private readonly version: string;
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
        this.port = options.port || 3333;
        this.version = options.version || '1.0.0';
        this.app = this.createApp();
    }

    /**
     * Create and configure Express application.
     */
    private createApp(): Express {
        const app = express();

        // Middleware
        app.use(express.json());
        app.use(createCorsMiddleware());
        app.use(loggingMiddleware);

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
        app.use('/api/v1', createStatusRouter(this.serviceClient));
        app.use('/api/v1', createToolsRouter(this.serviceClient));
        app.post('/mcp', async (req, res, next) => {
            try {
                await this.handleMcpRequest(req, res);
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
                this.server = this.app.listen(this.port, () => {
                    console.error(`[HTTP] Server listening on http://localhost:${this.port}`);
                    console.error(`[HTTP] Health: http://localhost:${this.port}/health`);
                    console.error(`[HTTP] API: http://localhost:${this.port}/api/v1/`);
                    console.error(`[HTTP] MCP: http://localhost:${this.port}/mcp`);
                    if (featureEnabled('metrics') && featureEnabled('http_metrics')) {
                        console.error(`[HTTP] Metrics: http://localhost:${this.port}/metrics`);
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

            await session.transport.handleRequest(req, res, req.body);
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
        const server = createHttpMcpServer(this.serviceClient);
        session = { server, transport };

        transport.onclose = () => {
            const activeSessionId = transport.sessionId;
            if (activeSessionId) {
                this.mcpSessions.delete(activeSessionId);
            }
            void server.close().catch((error) => {
                console.error('[HTTP] Failed to close MCP session server:', error);
            });
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
}
