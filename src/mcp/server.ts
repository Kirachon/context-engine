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
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ContextServiceClient } from './serviceClient.js';
import { semanticSearchTool, handleSemanticSearch } from './tools/search.js';
import { getFileTool, handleGetFile } from './tools/file.js';
import { getContextTool, handleGetContext } from './tools/context.js';
import { enhancePromptTool, handleEnhancePrompt } from './tools/enhance.js';
import { indexWorkspaceTool, handleIndexWorkspace } from './tools/index.js';
import { indexStatusTool, handleIndexStatus } from './tools/status.js';
import {
  reindexWorkspaceTool,
  clearIndexTool,
  handleReindexWorkspace,
  handleClearIndex,
} from './tools/lifecycle.js';
import { toolManifestTool, handleToolManifest } from './tools/manifest.js';
import { codebaseRetrievalTool, handleCodebaseRetrieval } from './tools/codebaseRetrieval.js';
import {
  createPlanTool,
  refinePlanTool,
  visualizePlanTool,
  handleCreatePlan,
  handleRefinePlan,
  handleVisualizePlan,
} from './tools/plan.js';
import {
  planManagementTools,
  initializePlanManagementServices,
  handleSavePlan,
  handleLoadPlan,
  handleListPlans,
  handleDeletePlan,
  handleRequestApproval,
  handleRespondApproval,
  handleStartStep,
  handleCompleteStep,
  handleFailStep,
  handleViewProgress,
  handleViewHistory,
  handleComparePlanVersions,
  handleRollbackPlan,
} from './tools/planManagement.js';
import { FileWatcher } from '../watcher/index.js';

export class ContextEngineMCPServer {
  private server: Server;
  private serviceClient: ContextServiceClient;
  private isShuttingDown = false;
  private workspacePath: string;
  private fileWatcher?: FileWatcher;
  private enableWatcher: boolean;

  constructor(
    workspacePath: string,
    serverName: string = 'context-engine',
    options?: { enableWatcher?: boolean; watchDebounceMs?: number }
  ) {
    this.workspacePath = workspacePath;
    this.serviceClient = new ContextServiceClient(workspacePath);

    // Initialize Phase 2 plan management services
    initializePlanManagementServices(workspacePath);
    this.enableWatcher = options?.enableWatcher ?? false;

    this.server = new Server(
      {
        name: serverName,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupGracefulShutdown();

    if (this.enableWatcher) {
      this.fileWatcher = new FileWatcher(
        workspacePath,
        {
          onBatch: async (changes) => {
            // Ignore deletions for now; they can be handled by a full reindex if needed
            const paths = changes
              .filter((c) => c.type !== 'unlink')
              .map((c) => c.path);
            if (paths.length === 0) return;
            try {
              await this.serviceClient.indexFiles(paths);
            } catch (error) {
              console.error('[watcher] Incremental indexing failed:', error);
            }
          },
        },
        {
          debounceMs: options?.watchDebounceMs ?? 500,
        }
      );
      this.fileWatcher.start();
    }
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.error(`\nReceived ${signal}, shutting down gracefully...`);

      try {
        // Clear caches
        this.serviceClient.clearCache();

        // Stop watcher if running
        if (this.fileWatcher) {
          await this.fileWatcher.stop();
        }

        // Close server connection
        await this.server.close();

        console.error('Server shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
      // Don't exit on unhandled rejection, just log
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          indexWorkspaceTool,
          codebaseRetrievalTool,
          semanticSearchTool,
          getFileTool,
          getContextTool,
          enhancePromptTool,
          indexStatusTool,
          reindexWorkspaceTool,
          clearIndexTool,
          toolManifestTool,
          // Planning tools (Phase 1)
          createPlanTool,
          refinePlanTool,
          visualizePlanTool,
          // Plan management tools (Phase 2)
          ...planManagementTools,
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startTime = Date.now();

      // Log request (to stderr so it doesn't interfere with stdio transport)
      console.error(`[${new Date().toISOString()}] Tool: ${name}`);

      try {
        let result: string;

        switch (name) {
          case 'index_workspace':
            result = await handleIndexWorkspace(args as any, this.serviceClient);
            break;

          case 'reindex_workspace':
            result = await handleReindexWorkspace(args as any, this.serviceClient);
            break;

          case 'clear_index':
            result = await handleClearIndex(args as any, this.serviceClient);
            break;

          case 'index_status':
            result = await handleIndexStatus(args as any, this.serviceClient);
            break;

          case 'tool_manifest':
            result = await handleToolManifest(args as any, this.serviceClient);
            break;

          case 'codebase_retrieval':
            result = await handleCodebaseRetrieval(args as any, this.serviceClient);
            break;

          case 'semantic_search':
            result = await handleSemanticSearch(args as any, this.serviceClient);
            break;

          case 'get_file':
            result = await handleGetFile(args as any, this.serviceClient);
            break;

          case 'get_context_for_prompt':
            result = await handleGetContext(args as any, this.serviceClient);
            break;

          case 'enhance_prompt':
            result = await handleEnhancePrompt(args as any, this.serviceClient);
            break;

          // Planning tools (Phase 1)
          case 'create_plan':
            result = await handleCreatePlan(args as any, this.serviceClient);
            break;

          case 'refine_plan':
            result = await handleRefinePlan(args as any, this.serviceClient);
            break;

          case 'visualize_plan':
            result = await handleVisualizePlan(args as any, this.serviceClient);
            break;

          // Plan management tools (Phase 2)
          case 'save_plan':
            result = await handleSavePlan(args as Record<string, unknown>);
            break;

          case 'load_plan':
            result = await handleLoadPlan(args as Record<string, unknown>);
            break;

          case 'list_plans':
            result = await handleListPlans(args as Record<string, unknown>);
            break;

          case 'delete_plan':
            result = await handleDeletePlan(args as Record<string, unknown>);
            break;

          case 'request_approval':
            result = await handleRequestApproval(args as Record<string, unknown>);
            break;

          case 'respond_approval':
            result = await handleRespondApproval(args as Record<string, unknown>);
            break;

          case 'start_step':
            result = await handleStartStep(args as Record<string, unknown>);
            break;

          case 'complete_step':
            result = await handleCompleteStep(args as Record<string, unknown>);
            break;

          case 'fail_step':
            result = await handleFailStep(args as Record<string, unknown>);
            break;

          case 'view_progress':
            result = await handleViewProgress(args as Record<string, unknown>);
            break;

          case 'view_history':
            result = await handleViewHistory(args as Record<string, unknown>);
            break;

          case 'compare_plan_versions':
            result = await handleComparePlanVersions(args as Record<string, unknown>);
            break;

          case 'rollback_plan':
            result = await handleRollbackPlan(args as Record<string, unknown>);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        const elapsed = Date.now() - startTime;
        console.error(`[${new Date().toISOString()}] Tool ${name} completed in ${elapsed}ms`);

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.error(`[${new Date().toISOString()}] Tool ${name} failed after ${elapsed}ms: ${errorMessage}`);

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('='.repeat(60));
    console.error('Context Engine MCP Server v1.4.1');
    console.error('='.repeat(60));
    console.error(`Workspace: ${this.workspacePath}`);
    console.error('Transport: stdio');
    console.error(`Watcher: ${this.enableWatcher ? 'enabled' : 'disabled'}`);
    console.error('');
    console.error('Available tools (26 total):');
    console.error('  Core Context:');
    console.error('    - index_workspace, codebase_retrieval, semantic_search');
    console.error('    - get_file, get_context_for_prompt, enhance_prompt');
    console.error('  Index Management:');
    console.error('    - index_status, reindex_workspace, clear_index, tool_manifest');
    console.error('  Planning (v1.4.0):');
    console.error('    - create_plan, refine_plan, visualize_plan');
    console.error('    - save_plan, load_plan, list_plans, delete_plan');
    console.error('    - request_approval, respond_approval');
    console.error('    - start_step, complete_step, fail_step, view_progress');
    console.error('    - view_history, compare_plan_versions, rollback_plan');
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
}
