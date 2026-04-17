import type { RequestHandler } from 'express';
import { HttpError } from './errorHandler.js';

export function createRequestTimeoutMiddleware(timeoutMs: number): RequestHandler {
    return (req, res, next) => {
        let completed = false;

        const markCompleted = (): void => {
            completed = true;
        };

        const onTimeout = (): void => {
            if (completed) {
                return;
            }

            completed = true;
            next(new HttpError(504, `Request timed out after ${timeoutMs}ms`));
        };

        req.setTimeout(timeoutMs, onTimeout);
        res.setTimeout(timeoutMs, onTimeout);
        res.once('finish', markCompleted);
        res.once('close', markCompleted);

        next();
    };
}
