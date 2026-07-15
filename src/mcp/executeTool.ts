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
import { errorResult, normalizeToolResult } from './utils/resultBuilder.js';
import { assertValidToolInput } from './utils/validateToolInput.js';

export type SignalAwareToolHandler = (
  args: unknown,
  signal?: AbortSignal
) => Promise<ContextEngineToolHandlerResult>;

/** Back-compat alias for handlers that ignore cancellation signals. */
export type ToolHandler = (args: unknown) => Promise<ContextEngineToolHandlerResult>;

/**
 * Stable tool-call outcome vocabulary shared by every transport that flows
 * through {@link executeToolCall} -- MCP stdio, MCP HTTP, and REST
 * (`src/http/httpToolExecutor.ts`).
 *
 * `'cancelled'` is the single cancellation outcome for all of them. It is
 * produced whenever `params.signal` is observed as aborted at (or before)
 * the moment the handler settles, regardless of:
 *   - *why* it aborted (an explicit MCP `notifications/cancelled`, a REST
 *     request disconnect, or a caller-owned timeout racing the same
 *     signal -- see `runAbortableTool` in `src/http/routes/tools.ts`), and
 *   - *what* the handler itself resolved or rejected with (a clean abort
 *     rejection, an unrelated thrown error, or even a successful result
 *     that raced past the abort).
 *
 * This executor never invents a second, transport-specific cancellation
 * mapping -- REST and MCP both fall back to this one classification.
 * Deeper propagation (forwarding the signal into retrieval queues,
 * providers, and rerankers so *they* also stop early) is out of scope here
 * and is owned by a later task; this executor only guarantees that it never
 * misreports a cancelled call as a normal success or error.
 */
export type ToolCallResult = 'success' | 'error' | 'cancelled';

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

/**
 * True once the caller-supplied signal has fired, for whatever reason
 * (explicit cancel, request disconnect, or a caller-owned timeout). This is
 * the *only* signal executeTool.ts trusts to classify a call as cancelled --
 * never an error's `name`/`code`, since those are handler-specific and would
 * let unrelated abort-shaped errors masquerade as cancellations (or vice
 * versa).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function buildCancelledResponse(name: string): ContextEngineToolResult {
  return errorResult(`Cancelled: ${name} was cancelled before completion.`);
}

/**
 * Produce the single 'cancelled' outcome shared by every cancellation site
 * below (pre-abort, queued-abort, handler-abort/timeout, and mixed
 * error/cancel). No handler result -- success or error -- is ever published
 * through this path: the response text, audit outcome, and metrics label are
 * always 'cancelled', matching the MCP SDK's own no-publication-after-cancel
 * behavior at the transport layer (`Protocol#_onrequest` checks the same
 * kind of abort flag before sending a response).
 */
function finalizeCancelled(
  name: string,
  startTime: number,
  now: () => number,
  log: (message: string) => void,
  useObservability: boolean,
  span?: { setAttribute: (key: string, value: string) => void }
): ExecuteToolCallResult {
  const elapsedMs = now() - startTime;
  span?.setAttribute('context_engine.outcome', 'cancelled');
  log(
    formatToolLogMessage(
      useObservability,
      `[${new Date().toISOString()}] Tool ${name} cancelled after ${elapsedMs}ms`
    )
  );
  auditLogToolCallCompleted(name, 'cancelled', elapsedMs);

  return {
    response: buildCancelledResponse(name),
    result: 'cancelled',
    elapsedMs,
  };
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

  // Pre-abort: the caller already cancelled before this call was even
  // dispatched. The handler is never looked up or invoked, so no
  // handler-owned permit/resource is ever acquired on this path -- there is
  // nothing to release.
  if (isAborted(signal)) {
    return finalizeCancelled(name, startTime, now, log, useObservability, span);
  }

  try {
    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    assertValidToolInput(name, args, params.toolInputSchemas?.get(name));

    // Queued abort: cancellation landed while this call was queued behind
    // synchronous dispatch work (handler lookup/schema validation) and
    // before the handler itself started running. Still no handler
    // invocation, still no permit acquired.
    if (isAborted(signal)) {
      return finalizeCancelled(name, startTime, now, log, useObservability, span);
    }

    const result = await handler(args, signal);

    // Handler abort / timeout: the handler ran to completion -- successfully
    // -- but the signal aborted at some point during that run (a direct
    // cancel, or a caller-owned timeout that reused the same signal, e.g.
    // `runAbortableTool`). The executor always awaits the handler's own
    // settlement rather than racing/abandoning it, so any permit or resource
    // the handler acquired is released via its own cleanup (try/finally)
    // before this function ever returns. The result is still classified
    // 'cancelled' and is never published as a success.
    if (isAborted(signal)) {
      return finalizeCancelled(name, startTime, now, log, useObservability, span);
    }

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
    // Mixed error/cancel: once the signal is observed aborted, any handler
    // failure -- an McpError, an abort-shaped rejection, or an unrelated
    // bug -- is reported as 'cancelled', not 'error'. The caller already
    // gave up; the *reason* the handler failed no longer matters and must
    // never surface as a misleading error outcome. Conversely, an
    // abort-shaped error (e.g. `error.name === 'AbortError'`) that arrives
    // while the signal is still unset/not aborted is a genuine handler
    // error, not a cancellation, and falls through to the existing error
    // path below.
    if (isAborted(signal)) {
      return finalizeCancelled(name, startTime, now, log, useObservability, span);
    }

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
