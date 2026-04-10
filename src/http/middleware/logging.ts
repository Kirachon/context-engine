/**
 * Request/Response Logging Middleware
 * 
 * Logs HTTP requests for debugging and monitoring.
 */

import type { Request, Response, NextFunction } from 'express';
import {
    createRequestContext,
    formatRequestLogPrefix,
    runWithRequestContext,
} from '../../telemetry/requestContext.js';

export const REQUEST_ID_HEADER = 'x-context-engine-request-id';

/**
 * Logging middleware that logs request details to stderr.
 * Uses stderr to avoid interfering with stdio transport.
 */
export function loggingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const context = createRequestContext({
        transport: req.path === '/mcp' ? 'mcp' : 'http',
        method: req.method,
        path: req.path,
    });
    const start = Date.now();

    res.setHeader(REQUEST_ID_HEADER, context.requestId);

    runWithRequestContext(context, () => {
        console.error(`${formatRequestLogPrefix()} [HTTP] ${req.method} ${req.path}`);

        res.on('finish', () => {
            const duration = Date.now() - start;
            console.error(
                `${formatRequestLogPrefix()} [HTTP] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`
            );
        });

        next();
    });
}
