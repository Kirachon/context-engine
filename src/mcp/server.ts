/**
 * Layer 3: MCP Interface Layer - Server
 *
 * Main MCP server that exposes tools to coding agents
 *
 * Architecture:
 * - Stateless adapter between MCP protocol and service layer
 * - No business logic
 * - No retrieval logic
 * - Pure protocol translation
 *
 * Features:
 * - Graceful shutdown handling (SIGTERM, SIGINT)
 * - Request logging for debugging
 * - Proper error formatting for agents
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { normalizeIgnoredPatterns } from '../watcher/ignoreRules.js';

import { initializeContextPackStore } from '../context/contextPackStore.js';
import { setActiveSpanAttributes } from '../observability/otel.js';
import { FileWatcher } from '../watcher/index.js';
import {
  ClientCapabilitiesManager,
  attachClientCapabilitiesHandlers,
} from './capabilities/clientCapabilities.js';
import { executeToolCall, type ToolHandler } from './executeTool.js';
import { buildToolInputSchemaMap } from './utils/validateToolInput.js';
import { buildPromptByName, PROMPT_DEFINITIONS } from './prompts/promptRegistry.js';
import { RootsManager, attachRootsHandlers } from './roots/rootsManager.js';
import { buildResourceList, readResourceByUri } from './resources/resourceRouter.js';
import { buildResourceTemplateList } from './resources/resourceTemplates.js';
import { ContextServiceClient } from './serviceClient.js';
import { createServerCapabilities } from './serverCapabilities.js';
import { runWithStdioRequestContext } from './stdioRequestContext.js';
import { MCP_SERVER_VERSION } from './tools/manifest.js';
import { initializePlanManagementServices } from './tools/planManagement.js';
import { buildToolRegistryEntries } from './toolRegistry.js';

export type { ToolRegistryEntry, ToolHandler } from './toolRegistry.js';
export { buildToolRegistryEntries } from './toolRegistry.js';
export { SERVER_CAPABILITY_PARITY, createServerCapabilities } from './serverCapabilities.js';
export type { ServerCapabilityOptions } from './serverCapabilities.js';
export { PROMPT_DEFINITIONS, buildPromptByName } from './prompts/promptRegistry.js';
export { runWithStdioRequestContext } from './stdioRequestContext.js';

export class ContextEngineMCPServer {
  private server: Server;
  private serviceClient: ContextServiceClient;
  private isShuttingDown = false;
  private workspacePath: string;
  private fileWatcher?: FileWatcher;
  private enableWatcher: boolean;
  private runtimeToolCount = 0;
  private rootsManager: RootsManager;
  private clientCapabilitiesManager: ClientCapabilitiesManager;

  constructor(
    workspacePath: string,
    serverName: string = 'context-engine',
    options?: { enableWatcher?: boolean; watchDebounceMs?: number }
  ) {
    this.workspacePath = workspacePath;
    this.serviceClient = new ContextServiceClient(workspacePath);
    this.rootsManager = new RootsManager(workspacePath);
    this.clientCapabilitiesManager = new ClientCapabilitiesManager();
    this.serviceClient.setRootsManager(this.rootsManager);
    this.serviceClient.setClientCapabilitiesManager(this.clientCapabilitiesManager);

    // Initialize Phase 2 plan management services
    initializePlanManagementServices(workspacePath);
    initializeContextPackStore(workspacePath);
    this.enableWatcher = options?.enableWatcher ?? false;

    this.server = new Server(
      {
        name: serverName,
        version: MCP_SERVER_VERSION,
      },
      {
        capabilities: createServerCapabilities({ resources: true, prompts: true }),
      }
    );

    this.setupHandlers();
    attachRootsHandlers(this.server, this.rootsManager);
    attachClientCapabilitiesHandlers(this.server, this.clientCapabilitiesManager);

    if (this.enableWatcher) {
      // Get ignore patterns from serviceClient to sync with indexing behavior
      const ignorePatterns = this.serviceClient.getIgnorePatterns();
      const excludedDirs = this.serviceClient.getExcludedDirectories();

      const watcherIgnored = normalizeIgnoredPatterns(workspacePath, ignorePatterns, excludedDirs);

      console.error(`[watcher] Loaded ${watcherIgnored.length} ignore patterns`);

      this.fileWatcher = new FileWatcher(
        workspacePath,
        {
          onBatch: async (changes) => {
            const workspaceChangeApi = (
              this.serviceClient as ContextServiceClient & {
                applyWorkspaceChanges?: (
                  batch: Array<{ type: 'add' | 'change' | 'unlink'; path: string }>
                ) => Promise<void>;
              }
            ).applyWorkspaceChanges;
            if (typeof workspaceChangeApi === 'function') {
              await workspaceChangeApi.call(
                this.serviceClient,
                changes.map((change) => ({ type: change.type, path: change.path }))
              );
              return;
            }

            try {
              const paths = changes
                .filter((c) => c.type !== 'unlink')
                .map((c) => c.path);
              if (paths.length === 0) {
                return;
              }
              await this.serviceClient.indexFiles(paths);
            } catch (error) {
              console.error('[watcher] Incremental indexing failed:', error);
            }
          },
        },
        {
          debounceMs: options?.watchDebounceMs ?? 500,
          ignored: watcherIgnored,
        }
      );
      this.fileWatcher.start();
    }
  }

  private setupHandlers(): void {
    const toolRegistryEntries = buildToolRegistryEntries(this.serviceClient);

    const tools = toolRegistryEntries.map((entry) => entry.tool);
    const toolHandlers = new Map<string, ToolHandler>(
      toolRegistryEntries.map((entry) => [entry.tool.name, entry.handler])
    );
    const toolInputSchemas = buildToolInputSchemaMap(toolRegistryEntries);
    this.runtimeToolCount = tools.length;

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => await runWithStdioRequestContext('tools/list', async () => ({
      tools,
    })));

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => await runWithStdioRequestContext('resources/list', async () => ({
      resources: await buildResourceList(),
    })));

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => await runWithStdioRequestContext('resources/templates/list', async () => ({
      resourceTemplates: buildResourceTemplateList(),
    })));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => await runWithStdioRequestContext('resources/read', async () => {
      setActiveSpanAttributes({
        'context_engine.operation': 'resources/read',
      });
      return await readResourceByUri(request.params.uri, {
        workspaceRoot: this.workspacePath,
        serviceClient: this.serviceClient,
        allowedRoots: this.rootsManager.getAllowedRootsForPolicy(),
      });
    }));

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => await runWithStdioRequestContext('prompts/list', async () => ({
      prompts: PROMPT_DEFINITIONS,
    })));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => await runWithStdioRequestContext('prompts/get', async () => {
      setActiveSpanAttributes({
        'context_engine.operation': 'prompts/get',
      });
      return buildPromptByName(request.params.name, request.params.arguments ?? {});
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => await runWithStdioRequestContext('tools/call', async () => {
      const { name, arguments: args } = request.params;
      setActiveSpanAttributes({
        'context_engine.tool': name,
        'context_engine.operation': 'tools/call',
      });
      const execution = await executeToolCall({
        name,
        args,
        toolHandlers,
        toolInputSchemas,
        signal: extra.signal,
        useObservability: true,
        recordMetrics: true,
      });

      return execution.response;
    }));
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('='.repeat(60));
    console.error(`Context Engine MCP Server v${MCP_SERVER_VERSION}`);
    console.error('='.repeat(60));
    console.error(`Workspace: ${this.workspacePath}`);
    console.error('Transport: stdio');
    console.error(`Watcher: ${this.enableWatcher ? 'enabled' : 'disabled'}`);
    console.error('');
    console.error(`Available tools (${this.runtimeToolCount} total):`);
    console.error('  Core Context:');
    console.error('    - index_workspace, codebase_retrieval, semantic_search');
    console.error('    - get_file, get_context_for_prompt, enhance_prompt');
    console.error('  Index Management:');
    console.error('    - index_status, reindex_workspace, clear_index, tool_manifest');
    console.error('  Memory (v1.4.1):');
    console.error('    - add_memory, list_memories');
    console.error('  Planning (v1.4.0):');
    console.error('    - create_plan, refine_plan, visualize_plan');
    console.error('    - save_plan, load_plan, list_plans, delete_plan');
    console.error('    - request_approval, respond_approval');
    console.error('    - start_step, complete_step, fail_step, view_progress');
    console.error('    - view_history, compare_plan_versions, rollback_plan');
    console.error('  Code Review (v1.5.0):');
    console.error('    - review_changes, review_git_diff, review_diff, review_auto, check_invariants, run_static_analysis');
    console.error('  Reactive Review (v1.6.0):');
    console.error('    - reactive_review_pr, get_review_status');
    console.error('    - pause_review, resume_review, get_review_telemetry');
    console.error('    - scrub_secrets, validate_content');
    console.error('');
    console.error('Server ready. Waiting for requests...');
    console.error('='.repeat(60));
  }

  async indexWorkspace(): Promise<void> {
    await this.serviceClient.indexWorkspace();
  }

  /**
   * Get the workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get the service client instance.
   * Used by HTTP server to share the same service client.
   */
  getServiceClient(): ContextServiceClient {
    return this.serviceClient;
  }

  async shutdown(reason: string = 'shutdown'): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.error(`Shutting down MCP server (${reason})...`);

    try {
      this.serviceClient.clearCache();

      if (this.fileWatcher) {
        await this.fileWatcher.stop();
      }

      await this.server.close();
      console.error('Server shutdown complete');
    } finally {
      this.isShuttingDown = false;
    }
  }
}
