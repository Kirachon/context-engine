import type { Request, Response, NextFunction } from 'express';
import {
    authorizeHttpRequest,
    isHttpAuthEnabled,
    parseHttpAuthTokenRegistry,
    resolveRequiredApiScope,
} from '../authScopes.js';
import { auditLogScopeDecision } from '../../telemetry/auditLog.js';
import { HttpError } from './errorHandler.js';

export function createHttpAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, _res, next) => {
        if (!isHttpAuthEnabled()) {
            next();
            return;
        }

        try {
            const decision = authorizeHttpRequest(req, {
                resolveRequiredScope: resolveRequiredApiScope,
                registry: parseHttpAuthTokenRegistry(),
            });

            auditLogScopeDecision({
                authorized: decision.authorized,
                statusCode: decision.statusCode,
                requiredScope: resolveRequiredApiScope(req),
                grantedScopes: decision.scopes,
                method: req.method,
                path: req.path,
                rpcMethod: typeof req.body?.method === 'string' ? req.body.method : undefined,
                message: decision.message,
            });

            if (!decision.authorized) {
                throw new HttpError(
                    decision.statusCode ?? 401,
                    decision.message ?? 'Unauthorized HTTP request'
                );
            }

            next();
        } catch (error) {
            next(error);
        }
    };
}
