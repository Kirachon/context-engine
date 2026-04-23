import type { NextFunction, Request, Response } from 'express';

import { withObservabilitySpanContext } from '../../observability/otel.js';
import { getRequestContext } from '../../telemetry/requestContext.js';

function resolveRouteId(req: Request): string {
  if (req.path === '/mcp') {
    return '/mcp';
  }

  if (req.baseUrl) {
    return req.path === '/'
      ? req.baseUrl
      : `${req.baseUrl}${req.path}`;
  }

  return req.path;
}

export function observabilityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestContext = getRequestContext();
  if (!requestContext) {
    next();
    return;
  }

  const spanName = requestContext.transport === 'mcp' ? 'mcp.http.request' : 'http.request';
  const routeId = resolveRouteId(req);

  withObservabilitySpanContext(
    spanName,
    {
      headers: req.headers as Record<string, string | string[] | undefined>,
      attributes: {
        'context_engine.request_id': requestContext.requestId,
        'context_engine.transport': requestContext.transport,
        'context_engine.route': routeId,
        'context_engine.operation': requestContext.transport === 'mcp' ? 'mcp_http_request' : 'http_request',
        'http.request.method': req.method,
      },
    },
    (span) => {
      if (!span) {
        next();
        return;
      }

      let finished = false;
      const finalize = (outcome: 'success' | 'closed'): void => {
        if (finished) {
          return;
        }
        finished = true;
        span.setAttribute('http.response.status_code', res.statusCode);
        span.setAttribute('context_engine.outcome', outcome);
        span.end();
      };

      res.on('finish', () => finalize('success'));
      res.on('close', () => finalize('closed'));
      next();
    }
  );
}
