import type { Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

function getMcpSessionId(req: Request): string | undefined {
    const headerValue = req.headers['mcp-session-id'];
    if (Array.isArray(headerValue)) {
        return headerValue[0];
    }

    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
}

function getClientKey(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function applyRateLimitResponse(res: Response, message: string): void {
    res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({
        error: message,
        statusCode: 429,
    });
}

export function createApiRateLimitMiddleware(): RequestHandler {
    return rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit: RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
            applyRateLimitResponse(res, 'Too many API requests. Please retry shortly.');
        },
        keyGenerator: (req) => getClientKey(req),
    });
}

export function createMcpConnectionRateLimitMiddleware(): RequestHandler {
    const initializeLimiter = rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit: RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
            applyRateLimitResponse(res, 'Too many MCP session initialization attempts. Please retry shortly.');
        },
        keyGenerator: (req) => getClientKey(req),
    });

    const reconnectLimiter = rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit: RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
            applyRateLimitResponse(res, 'Too many MCP session reconnect attempts. Please retry shortly.');
        },
        keyGenerator: (req) => {
            const sessionId = getMcpSessionId(req);
            const clientKey = getClientKey(req);
            return sessionId ? `${clientKey}:mcp-session:${sessionId}` : clientKey;
        },
    });

    return (req, res, next) => {
        if (req.method === 'OPTIONS') {
            next();
            return;
        }

        if (!getMcpSessionId(req) && req.method === 'POST' && isInitializeRequest(req.body)) {
            initializeLimiter(req, res, next);
            return;
        }

        if (req.method === 'GET' && getMcpSessionId(req)) {
            reconnectLimiter(req, res, next);
            return;
        }

        next();
    };
}
