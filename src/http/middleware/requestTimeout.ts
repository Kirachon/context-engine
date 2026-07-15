import type { RequestHandler } from 'express';
import { HttpError } from './errorHandler.js';

/**
 * Generic `/api/v1` request-timeout backstop (R1c).
 *
 * Individual tool routes own their own, more precise timeout via
 * `runAbortableTool` (`src/http/routes/tools.ts`), which extends this
 * socket-inactivity timer to the route-specific value (`req.setTimeout`)
 * before it would otherwise fire and races it against an explicit
 * `AbortController` tied to the same request. This middleware therefore
 * only fires in practice for routes that never reach that per-route
 * wiring (e.g. a request that fails before dispatch, or a future route
 * that forgets to opt in) -- its `next(new HttpError(504, ...))` and the
 * per-route rejection are expected to race safely rather than double
 * -publish: both `asyncHandler` (tools.ts) and `errorHandler` below no-op
 * once headers have already been sent.
 */
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
            if (res.headersSent || res.writableEnded) {
                return;
            }
            next(new HttpError(504, `Request timed out after ${timeoutMs}ms`));
        };

        req.setTimeout(timeoutMs, onTimeout);
        res.setTimeout(timeoutMs, onTimeout);
        res.once('finish', markCompleted);
        res.once('close', markCompleted);

        next();
    };
}
