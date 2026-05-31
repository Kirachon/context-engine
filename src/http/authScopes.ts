import type { Request } from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { envBool } from '../config/env.js';

export const HTTP_AUTH_SCOPES = {
    TOOLS_READ: 'tools:read',
    TOOLS_WRITE: 'tools:write',
    RESOURCES_READ: 'resources:read',
    TASKS_CANCEL: 'tasks:cancel',
} as const;

export type HttpAuthScope = typeof HTTP_AUTH_SCOPES[keyof typeof HTTP_AUTH_SCOPES];

export const ALL_HTTP_AUTH_SCOPES: readonly HttpAuthScope[] = Object.values(HTTP_AUTH_SCOPES);

export type HttpAuthDecision = {
    authorized: boolean;
    statusCode?: number;
    message?: string;
    scopes?: readonly HttpAuthScope[];
};

export type HttpAuthHook = (req: Request) => HttpAuthDecision | Promise<HttpAuthDecision>;

const HTTP_AUTH_ENABLED_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_ENABLED';
const HTTP_AUTH_TOKENS_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_TOKENS';

const API_WRITE_PATHS = new Set([
    '/index',
    '/enhance-prompt',
    '/plan',
    '/review-changes',
    '/review-git-diff',
    '/review-auto',
]);

export function isHttpAuthEnabled(): boolean {
    return envBool(HTTP_AUTH_ENABLED_ENV, false);
}

function isHttpAuthScope(value: string): value is HttpAuthScope {
    return (ALL_HTTP_AUTH_SCOPES as readonly string[]).includes(value);
}

export function parseHttpAuthTokenRegistry(
    raw = process.env[HTTP_AUTH_TOKENS_ENV]
): ReadonlyMap<string, readonly HttpAuthScope[]> {
    if (raw === undefined || raw.trim() === '') {
        return new Map();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${HTTP_AUTH_TOKENS_ENV} must be valid JSON`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${HTTP_AUTH_TOKENS_ENV} must be a JSON object mapping tokens to scope arrays`);
    }

    const registry = new Map<string, readonly HttpAuthScope[]>();
    for (const [token, scopesValue] of Object.entries(parsed)) {
        if (!token.trim()) {
            continue;
        }
        if (!Array.isArray(scopesValue)) {
            throw new Error(`${HTTP_AUTH_TOKENS_ENV} entry for token "${token}" must be a scope array`);
        }

        const scopes = scopesValue.map((scope) => {
            if (typeof scope !== 'string' || !isHttpAuthScope(scope)) {
                throw new Error(
                    `${HTTP_AUTH_TOKENS_ENV} entry for token "${token}" contains invalid scope "${String(scope)}"`
                );
            }
            return scope;
        });

        registry.set(token, scopes);
    }

    return registry;
}

export function extractBearerToken(req: Request): string | null {
    const authorization = req.headers.authorization;
    const headerValue = Array.isArray(authorization) ? authorization[0] : authorization;
    if (typeof headerValue !== 'string') {
        return null;
    }

    const match = headerValue.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return null;
    }

    const token = match[1]?.trim();
    return token ? token : null;
}

export function resolveTokenScopes(
    token: string,
    registry: ReadonlyMap<string, readonly HttpAuthScope[]> = parseHttpAuthTokenRegistry()
): readonly HttpAuthScope[] | null {
    const scopes = registry.get(token);
    return scopes ?? null;
}

export function hasRequiredScope(
    grantedScopes: readonly HttpAuthScope[],
    requiredScope: HttpAuthScope
): boolean {
    return grantedScopes.includes(requiredScope);
}

export function resolveRequiredMcpScope(req: Request): HttpAuthScope | null {
    if (req.method === 'DELETE') {
        return HTTP_AUTH_SCOPES.TASKS_CANCEL;
    }

    if (req.method === 'GET') {
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    const rpcMethod = req.body?.method;
    if (typeof rpcMethod !== 'string') {
        if (isInitializeRequest(req.body)) {
            return HTTP_AUTH_SCOPES.TOOLS_READ;
        }
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    if (rpcMethod === 'notifications/initialized') {
        return null;
    }

    if (rpcMethod === 'initialize') {
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    if (rpcMethod === 'tools/call') {
        return HTTP_AUTH_SCOPES.TOOLS_WRITE;
    }

    if (rpcMethod === 'tools/list') {
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    if (rpcMethod.startsWith('resources/')) {
        return HTTP_AUTH_SCOPES.RESOURCES_READ;
    }

    if (rpcMethod.startsWith('prompts/')) {
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    return HTTP_AUTH_SCOPES.TOOLS_READ;
}

export function resolveRequiredApiScope(req: Request): HttpAuthScope {
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';

    if (req.method === 'GET') {
        return HTTP_AUTH_SCOPES.TOOLS_READ;
    }

    if (req.method === 'POST' && API_WRITE_PATHS.has(normalizedPath)) {
        return HTTP_AUTH_SCOPES.TOOLS_WRITE;
    }

    return HTTP_AUTH_SCOPES.TOOLS_READ;
}

export function authorizeHttpRequest(
    req: Request,
    options?: {
        requiredScope?: HttpAuthScope | null;
        resolveRequiredScope?: (req: Request) => HttpAuthScope | null;
        registry?: ReadonlyMap<string, readonly HttpAuthScope[]>;
    }
): HttpAuthDecision {
    const registry = options?.registry ?? parseHttpAuthTokenRegistry();
    const token = extractBearerToken(req);

    if (!token) {
        return {
            authorized: false,
            statusCode: 401,
            message: 'Missing or invalid authorization',
        };
    }

    const scopes = resolveTokenScopes(token, registry);
    if (!scopes) {
        return {
            authorized: false,
            statusCode: 401,
            message: 'Missing or invalid authorization',
        };
    }

    const requiredScope = options?.requiredScope !== undefined
        ? options.requiredScope
        : options?.resolveRequiredScope?.(req) ?? null;

    if (requiredScope !== null && !hasRequiredScope(scopes, requiredScope)) {
        return {
            authorized: false,
            statusCode: 403,
            message: `Insufficient scope: requires ${requiredScope}`,
            scopes,
        };
    }

    return {
        authorized: true,
        scopes,
    };
}

export function createHttpAuthHook(
    registry: ReadonlyMap<string, readonly HttpAuthScope[]> = parseHttpAuthTokenRegistry()
): HttpAuthHook {
    return (req) => authorizeHttpRequest(req, {
        resolveRequiredScope: resolveRequiredMcpScope,
        registry,
    });
}
