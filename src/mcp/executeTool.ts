import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { incCounter, observeDurationMs } from '../metrics/metrics.js';
import { runWithObservabilitySpan } from '../observability/otel.js';
import {
  auditLogToolCallCompleted,
  auditLogToolCallStarted,
} from '../telemetry/auditLog.js';
import { formatRequestLogPrefix, getRequestContext } from '../telemetry/requestContext.js';
import type { JsonSchema } from './types/outputSchema.js';
import type { ContextEngineToolHandlerResult, ContextEngineToolResult } from './types/toolResult.js';
import { normalizeToolResult } from './utils/resultBuilder.js';
import { assertValidToolInput } from './utils/validateToolInput.js';

export type SignalAwareToolHandler = (
  args: unknown,
  signal?: AbortSignal
) => Promise<ContextEngineToolHandlerResult>;

/** Back-compat alias for handlers that ignore cancellation signals. */
export type ToolHandler = (args: unknown) => Promise<ContextEngineToolHandlerResult>;

export type ToolCallResult = 'success' | 'error';

export type ExecuteToolCallParams = {
  name: string;
  args: unknown;
  toolHandlers: Map<string, SignalAwareToolHandler>;
  toolInputSchemas?: Map<string, JsonSchema>;
  signal?: AbortSignal;
  now?: () => number;
  log?: (message: string) => void;
  /** Wrap execution in an observability span and request-context log prefix. */
  useObservability?: boolean;
  /** Record MCP tool call counters and duration histograms. */
  recordMetrics?: boolean;
};

export type ExecuteToolCallResult = {
  response: ContextEngineToolResult;
  result: ToolCallResult;
  elapsedMs: number;
};

function formatToolLogMessage(useObservability: boolean, message: string): string {
  if (!useObservability) {
    return message;
  }
  return `${formatRequestLogPrefix()} ${message}`;
}

async function executeToolCallCore(
  params: ExecuteToolCallParams,
  span?: { setAttribute: (key: string, value: string) => void }
): Promise<ExecuteToolCallResult> {
  const { name, args, toolHandlers, signal } = params;
  const now = params.now ?? Date.now;
  const log = params.log ?? console.error;
  const useObservability = params.useObservability ?? false;
  const startTime = now();

  log(formatToolLogMessage(useObservability, `[${new Date().toISOString()}] Tool: ${name}`));
  auditLogToolCallStarted(name, args);

  try {
    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    assertValidToolInput(name, args, params.toolInputSchemas?.get(name));
    const result = await handler(args, signal);
    const elapsedMs = now() - startTime;
    span?.setAttribute('context_engine.outcome', 'success');
    log(
      formatToolLogMessage(
        useObservability,
        `[${new Date().toISOString()}] Tool ${name} completed in ${elapsedMs}ms`
      )
    );
    auditLogToolCallCompleted(name, 'success', elapsedMs);

    return {
      response: normalizeToolResult(result),
      result: 'success',
      elapsedMs,
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    const elapsedMs = now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    span?.setAttribute('context_engine.outcome', 'error');

    log(
      formatToolLogMessage(
        useObservability,
        `[${new Date().toISOString()}] Tool ${name} failed after ${elapsedMs}ms: ${errorMessage}`
      )
    );
    auditLogToolCallCompleted(name, 'error', elapsedMs, errorMessage);

    return {
      response: {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      },
      result: 'error',
      elapsedMs,
    };
  }
}

function recordToolCallMetrics(name: string, result: ToolCallResult, elapsedMs: number): void {
  const metricLabels = { tool: name, result };
  incCounter(
    'context_engine_mcp_tool_calls_total',
    metricLabels,
    1,
    'Total MCP tool calls handled by the server.'
  );
  observeDurationMs(
    'context_engine_mcp_tool_call_duration_seconds',
    metricLabels,
    elapsedMs,
    { help: 'MCP tool call handling duration in seconds.' }
  );
}

export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecuteToolCallResult> {
  const useObservability = params.useObservability ?? false;
  const recordMetrics = params.recordMetrics ?? false;

  const finalize = async (
    execution: ExecuteToolCallResult
  ): Promise<ExecuteToolCallResult> => {
    if (recordMetrics) {
      recordToolCallMetrics(params.name, execution.result, execution.elapsedMs);
    }
    return execution;
  };

  if (!useObservability) {
    return finalize(await executeToolCallCore(params));
  }

  const requestContext = getRequestContext();

  return finalize(
    await runWithObservabilitySpan(
      'mcp.tool',
      {
        attributes: {
          'context_engine.request_id': requestContext?.requestId,
          'context_engine.transport': requestContext?.transport ?? 'stdio',
          'context_engine.tool': params.name,
          'context_engine.operation': 'tool_call',
        },
      },
      async (span) => await executeToolCallCore(params, span)
    )
  );
}
