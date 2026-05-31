import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { setActiveSpanAttributes } from '../observability/otel.js';
import {
  ClientCapabilitiesManager,
  runWithClientCapabilitiesManager,
} from './capabilities/clientCapabilities.js';
import { executeToolCall, type SignalAwareToolHandler, type ToolHandler } from './executeTool.js';
import { buildPromptByName, PROMPT_DEFINITIONS } from './prompts/promptRegistry.js';
import { buildResourceList, readResourceByUri, type ResourceReadContext } from './resources/resourceRouter.js';
import { buildResourceTemplateList } from './resources/resourceTemplates.js';
import type { ContextServiceClient } from './serviceClient.js';
import { buildToolRegistryEntries, type ToolRegistryEntry } from './toolRegistry.js';
import { buildToolInputSchemaMap } from './utils/validateToolInput.js';

export type AttachMcpHandlersOptions = {
  toolRegistryEntries?: ToolRegistryEntry[];
  readResource?: ResourceReadContext;
  /** Wrap list/get/read operations (stdio request context). */
  wrapOperation?: <T>(operation: string, fn: () => Promise<T>) => Promise<T>;
  /** Wrap tool execution (HTTP client-capabilities context). */
  wrapToolCall?: <T>(fn: () => Promise<T>) => Promise<T>;
  useObservability?: boolean;
  recordMetrics?: boolean;
};

export type AttachedMcpHandlers = {
  tools: ToolRegistryEntry['tool'][];
  toolCount: number;
};

function identityWrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export function attachMcpHandlers(
  server: Server,
  serviceClient: ContextServiceClient,
  options: AttachMcpHandlersOptions = {}
): AttachedMcpHandlers {
  const entries = options.toolRegistryEntries ?? buildToolRegistryEntries(serviceClient);
  const tools = entries.map((entry) => entry.tool);
  const toolHandlers = new Map<string, SignalAwareToolHandler | ToolHandler>(
    entries.map((entry) => [entry.tool.name, entry.handler])
  );
  const toolInputSchemas = buildToolInputSchemaMap(entries);
  const wrapOperation = options.wrapOperation ?? ((_operation, fn) => fn());
  const wrapToolCall = options.wrapToolCall ?? identityWrap;
  const useObservability = options.useObservability ?? true;
  const recordMetrics = options.recordMetrics ?? true;

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    wrapOperation('tools/list', async () => ({ tools }))
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    wrapOperation('resources/list', async () => ({
      resources: await buildResourceList(),
    }))
  );

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
    wrapOperation('resources/templates/list', async () => ({
      resourceTemplates: buildResourceTemplateList(),
    }))
  );

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    wrapOperation('resources/read', async () => {
      if (useObservability) {
        setActiveSpanAttributes({
          'context_engine.operation': 'resources/read',
        });
      }
      return await readResourceByUri(request.params.uri, options.readResource ?? {
        workspaceRoot: serviceClient.getWorkspacePath(),
        serviceClient,
      });
    })
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () =>
    wrapOperation('prompts/list', async () => ({
      prompts: PROMPT_DEFINITIONS,
    }))
  );

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    wrapOperation('prompts/get', async () => {
      if (useObservability) {
        setActiveSpanAttributes({
          'context_engine.operation': 'prompts/get',
        });
      }
      return buildPromptByName(request.params.name, request.params.arguments ?? {});
    })
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    wrapToolCall(async () => {
      const { name, arguments: args } = request.params;
      if (useObservability) {
        setActiveSpanAttributes({
          'context_engine.tool': name,
          'context_engine.operation': 'tools/call',
        });
      }
      const execution = await executeToolCall({
        name,
        args,
        toolHandlers,
        toolInputSchemas,
        signal: extra.signal,
        useObservability,
        recordMetrics,
      });
      return execution.response;
    })
  );

  return { tools, toolCount: tools.length };
}

export function attachMcpHandlersWithClientCapabilities(
  server: Server,
  serviceClient: ContextServiceClient,
  clientCapabilitiesManager: ClientCapabilitiesManager,
  options: Omit<AttachMcpHandlersOptions, 'wrapToolCall'> = {}
): AttachedMcpHandlers {
  return attachMcpHandlers(server, serviceClient, {
    ...options,
    wrapToolCall: (fn) => runWithClientCapabilitiesManager(clientCapabilitiesManager, fn),
  });
}
