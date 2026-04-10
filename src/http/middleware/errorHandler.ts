/**
 * Error Handler Middleware
 * 
 * Centralized error handling for HTTP layer.
 */

import type { Request, Response, NextFunction } from 'express';
import { formatRequestLogPrefix } from '../../telemetry/requestContext.js';

/**
 * HTTP error with status code
 */
export class HttpError extends Error {
    constructor(
        public statusCode: number,
        message: string
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

/**
 * Create a 400 Bad Request error
 */
export function badRequest(message: string): HttpError {
    return new HttpError(400, message);
}

/**
 * Create a 404 Not Found error
 */
export function notFound(message: string): HttpError {
    return new HttpError(404, message);
}

/**
 * Create a 500 Internal Server Error
 */
export function internalError(message: string): HttpError {
    return new HttpError(500, message);
}

/**
 * Error handler middleware.
 * Must be registered last in the middleware chain.
 */
export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction
): void {
    console.error(`${formatRequestLogPrefix()} [HTTP] Error: ${err.message}`);

    if (err instanceof HttpError) {
        res.status(err.statusCode).json({
            error: err.message,
            statusCode: err.statusCode,
        });
        return;
    }

    // Default to 500 for unknown errors
    res.status(500).json({
        error: 'Internal server error',
        statusCode: 500,
    });
}
