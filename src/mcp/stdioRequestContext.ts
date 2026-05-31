import { runWithObservabilitySpan } from '../observability/otel.js';
import { createRequestContext, runWithRequestContext } from '../telemetry/requestContext.js';

export async function runWithStdioRequestContext<T>(
  method: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const requestContext = createRequestContext({
    transport: 'stdio',
    method,
    path: 'stdio',
  });

  return await runWithRequestContext(requestContext, () =>
    runWithObservabilitySpan(
      'mcp.stdio.request',
      {
        attributes: {
          'context_engine.request_id': requestContext.requestId,
          'context_engine.transport': requestContext.transport,
          'context_engine.route': 'stdio',
          'context_engine.operation': method,
        },
      },
      async () => await fn()
    )
  );
}
