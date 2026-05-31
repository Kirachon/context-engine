import type { ContextServiceClient } from './serviceClient.js';
import type { SignalAwareToolHandler } from './executeTool.js';
import type { ContextEngineToolHandlerResult } from './types/toolResult.js';

export type ServiceClientToolHandler<TArgs> = (
  args: TArgs,
  serviceClient: ContextServiceClient,
  signal?: AbortSignal
) => Promise<ContextEngineToolHandlerResult>;

export type RecordToolHandler = (
  args: Record<string, unknown>
) => Promise<ContextEngineToolHandlerResult>;

export type StandaloneToolHandler<TArgs> = (
  args: TArgs
) => Promise<ContextEngineToolHandlerResult>;

/**
 * Binds a typed service-client handler to the MCP unknown-args boundary.
 * Input schemas are validated in executeToolCall before this runs.
 */
export function bindServiceClientTool<TArgs>(
  serviceClient: ContextServiceClient,
  handler: ServiceClientToolHandler<TArgs>
): SignalAwareToolHandler {
  return (args, signal) => handler(args as TArgs, serviceClient, signal);
}

export function bindServiceClientToolWithSignal<TArgs>(
  serviceClient: ContextServiceClient,
  handler: ServiceClientToolHandler<TArgs>
): SignalAwareToolHandler {
  return bindServiceClientTool(serviceClient, handler);
}

export function bindRecordTool(handler: RecordToolHandler): SignalAwareToolHandler {
  return (args) => handler(args as Record<string, unknown>);
}

export function bindStandaloneTool<TArgs>(handler: StandaloneToolHandler<TArgs>): SignalAwareToolHandler {
  return (args) => handler(args as TArgs);
}
