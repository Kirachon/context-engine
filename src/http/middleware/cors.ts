/**
 * CORS Middleware Configuration
 * 
 * Allows VS Code extension and other HTTP clients to access the API.
 */

import cors from 'cors';
import type { CorsOptions } from 'cors';
import { HttpError } from './errorHandler.js';

const ALLOWED_LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
        return true;
    }

    if (origin.startsWith('vscode-webview://')) {
        return true;
    }

    try {
        const parsed = new URL(origin);
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && ALLOWED_LOCAL_HOSTNAMES.has(parsed.hostname)
        );
    } catch {
        return false;
    }
}

export function validateAllowedOrigin(origin: string | undefined): void {
    if (!isAllowedOrigin(origin)) {
        throw new HttpError(403, `Origin not allowed: ${origin}`);
    }
}

/**
 * CORS configuration for the HTTP server.
 * Allows requests from VS Code webviews and localhost development.
 */
export const corsOptions: CorsOptions = {
    // Add CORS headers only for explicitly-allowed origins.
    origin: (origin, callback) => {
        if (!isAllowedOrigin(origin)) {
            callback(new HttpError(403, `Origin not allowed: ${origin}`));
            return;
        }

        callback(null, true);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
    exposedHeaders: ['Mcp-Session-Id'],
    credentials: true,
    maxAge: 86400, // 24 hours
};

/**
 * Create configured CORS middleware
 */
export function createCorsMiddleware() {
    return cors(corsOptions);
}
