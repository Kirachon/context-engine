import { executeToolCall } from '../mcp/executeTool.js';
import type { ContextServiceClient } from '../mcp/serviceClient.js';
import { buildToolRegistryEntries } from '../mcp/toolRegistry.js';
import type { ContextEngineToolResult } from '../mcp/types/toolResult.js';
import { buildToolInputSchemaMap } from '../mcp/utils/validateToolInput.js';

/**
 * Execute a registered MCP tool over HTTP REST with the same pipeline as stdio/HTTP MCP:
 * schema validation, audit logging, metrics, and structured result normalization.
 */
export async function executeHttpRegisteredTool(
  serviceClient: ContextServiceClient,
  toolName: string,
  args: unknown,
  signal?: AbortSignal
): Promise<ContextEngineToolResult> {
  const entries = buildToolRegistryEntries(serviceClient);
  const toolHandlers = new Map(entries.map((entry) => [entry.tool.name, entry.handler]));
  const toolInputSchemas = buildToolInputSchemaMap(entries);

  const execution = await executeToolCall({
    name: toolName,
    args,
    toolHandlers,
    toolInputSchemas,
    signal,
    useObservability: true,
    recordMetrics: true,
  });

  return execution.response;
}
