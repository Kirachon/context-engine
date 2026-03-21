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
import { MCP_SERVER_VERSION, toolManifestTool, handleToolManifest } from './tools/manifest.js';
import { codebaseRetrievalTool, handleCodebaseRetrieval } from './tools/codebaseRetrieval.js';
import {
  createPlanTool,
  refinePlanTool,
  visualizePlanTool,
  executePlanTool,
  handleCreatePlan,
  handleRefinePlan,
  handleVisualizePlan,
  handleExecutePlan,
} from './tools/plan.js';
import {
  addMemoryTool,
  listMemoriesTool,
  handleAddMemory,
  handleListMemories,
} from './tools/memory.js';
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
import { reviewChangesTool, handleReviewChanges } from './tools/codeReview.js';
import { reviewGitDiffTool, handleReviewGitDiff } from './tools/gitReview.js';
import { reviewDiffTool, handleReviewDiff } from './tools/reviewDiff.js';
import { reviewAutoTool, handleReviewAuto } from './tools/reviewAuto.js';
import { checkInvariantsTool, handleCheckInvariants } from './tools/checkInvariants.js';
import { runStaticAnalysisTool, handleRunStaticAnalysis } from './tools/staticAnalysis.js';
import { incCounter, observeDurationMs } from '../metrics/metrics.js';
import { type ToolHandler as RuntimeToolHandler } from './tooling/runtime.js';
import {
  reactiveReviewTools,
  handleReactiveReviewPR,
  handleGetReviewStatus,
  handlePauseReview,
  handleResumeReview,
  handleGetReviewTelemetry,
  handleScrubSecrets,
  handleValidateContent,
} from './tools/reactiveReview.js';
import { FileWatcher } from '../watcher/index.js';

type ToolRegistryEntry = {
  tool: { name: string };
  handler: SignalAwareToolHandler;
};

// Re-export for compatibility with existing server.ts type import paths.
export type ToolHandler = RuntimeToolHandler;

type SignalAwareToolHandler = (args: unknown, signal?: AbortSignal) => Promise<string>;

function formatToolExecutionResponse(result: string): {
  response: {
    content: Array<{ type: 'text'; text: string }>;
    isError?: false;
  };
} {
  return {
    response: {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    },
  };
}

async function executeToolCallWithSignal(params: {
  name: string;
  args: unknown;
  toolHandlers: Map<string, SignalAwareToolHandler>;
  signal?: AbortSignal;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<{
  response: {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
  } | {
    content: Array<{ type: 'text'; text: string }>;
    isError?: false;
  };
  result: 'success' | 'error';
  elapsedMs: number;
}> {
  const { name, args, toolHandlers, signal } = params;
  const now = params.now ?? Date.now;
  const log = params.log ?? console.error;
  const startTime = now();

  log(`[${new Date().toISOString()}] Tool: ${name}`);

  try {
    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = await handler(args, signal);
    const elapsedMs = now() - startTime;
    log(`[${new Date().toISOString()}] Tool ${name} completed in ${elapsedMs}ms`);

    return {
      response: formatToolExecutionResponse(result).response,
      result: 'success',
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    log(`[${new Date().toISOString()}] Tool ${name} failed after ${elapsedMs}ms: ${errorMessage}`);

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

export class ContextEngineMCPServer {
  private server: Server;
  private serviceClient: ContextServiceClient;
  private isShuttingDown = false;
  private workspacePath: string;
  private fileWatcher?: FileWatcher;
  private enableWatcher: boolean;
  private runtimeToolCount = 0;

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
        version: MCP_SERVER_VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: true },
        },
      }
    );

    this.setupHandlers();
    this.setupGracefulShutdown();

    if (this.enableWatcher) {
      // Get ignore patterns from serviceClient to sync with indexing behavior
      const ignorePatterns = this.serviceClient.getIgnorePatterns();
      const excludedDirs = this.serviceClient.getExcludedDirectories();

      // Normalize workspace path for pattern matching (use forward slashes)
      const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/');

      // Convert patterns to chokidar-compatible format
      // Chokidar accepts strings, RegExp, or functions
      const watcherIgnored: (string | RegExp)[] = [
        // Exclude directories (match anywhere in path)
        ...excludedDirs.map(dir => `**/${dir}/**`),
        // Include gitignore/contextignore patterns
        ...ignorePatterns.map(pattern => {
          // Handle root-anchored patterns (e.g., /.env should match only at workspace root)
          if (pattern.startsWith('/')) {
            // For root-anchored patterns, prepend workspace path for absolute matching
            // Chokidar uses absolute paths, so we need to match against workspace root
            return `${normalizedWorkspacePath}${pattern}`;
          }
          // Handle directory-only patterns
          if (pattern.endsWith('/')) {
            return `**/${pattern}**`;
          }
          // Match anywhere in path
          return `**/${pattern}`;
        }),
      ];

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
    const findToolByName = (tools: Array<{ name: string }>, name: string): { name: string } => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`Tool definition not found: ${name}`);
      }
      return tool;
    };

    const toolRegistryEntries: ToolRegistryEntry[] = [
      { tool: indexWorkspaceTool, handler: (args) => handleIndexWorkspace(args as any, this.serviceClient) },
      { tool: codebaseRetrievalTool, handler: (args) => handleCodebaseRetrieval(args as any, this.serviceClient) },
      { tool: semanticSearchTool, handler: (args) => handleSemanticSearch(args as any, this.serviceClient) },
      { tool: getFileTool, handler: (args) => handleGetFile(args as any, this.serviceClient) },
      { tool: getContextTool, handler: (args) => handleGetContext(args as any, this.serviceClient) },
      { tool: enhancePromptTool, handler: (args, signal) => handleEnhancePrompt(args as any, this.serviceClient, signal) },
      { tool: indexStatusTool, handler: (args) => handleIndexStatus(args as any, this.serviceClient) },
      { tool: reindexWorkspaceTool, handler: (args) => handleReindexWorkspace(args as any, this.serviceClient) },
      { tool: clearIndexTool, handler: (args) => handleClearIndex(args as any, this.serviceClient) },
      { tool: toolManifestTool, handler: (args) => handleToolManifest(args as any, this.serviceClient) },
      // Memory tools (v1.4.1)
      { tool: addMemoryTool, handler: (args) => handleAddMemory(args as any, this.serviceClient) },
      { tool: listMemoriesTool, handler: (args) => handleListMemories(args as any, this.serviceClient) },
      // Planning tools (Phase 1)
      { tool: createPlanTool, handler: (args, signal) => handleCreatePlan(args as any, this.serviceClient, signal) },
      { tool: refinePlanTool, handler: (args, signal) => handleRefinePlan(args as any, this.serviceClient, signal) },
      { tool: visualizePlanTool, handler: (args) => handleVisualizePlan(args as any, this.serviceClient) },
      { tool: executePlanTool, handler: (args, signal) => handleExecutePlan(args as any, this.serviceClient, signal) },
      // Plan management tools (Phase 2)
      { tool: findToolByName(planManagementTools, 'save_plan'), handler: (args) => handleSavePlan(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'load_plan'), handler: (args) => handleLoadPlan(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'list_plans'), handler: (args) => handleListPlans(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'delete_plan'), handler: (args) => handleDeletePlan(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'request_approval'), handler: (args) => handleRequestApproval(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'respond_approval'), handler: (args) => handleRespondApproval(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'start_step'), handler: (args) => handleStartStep(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'complete_step'), handler: (args) => handleCompleteStep(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'fail_step'), handler: (args) => handleFailStep(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'view_progress'), handler: (args) => handleViewProgress(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'view_history'), handler: (args) => handleViewHistory(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'compare_plan_versions'), handler: (args) => handleComparePlanVersions(args as Record<string, unknown>) },
      { tool: findToolByName(planManagementTools, 'rollback_plan'), handler: (args) => handleRollbackPlan(args as Record<string, unknown>) },
      // Code Review tools (v1.5.0)
      {
        tool: reviewChangesTool,
        handler: (args, signal) =>
          (handleReviewChanges as unknown as (
            args: unknown,
            serviceClient: ContextServiceClient,
            signal?: AbortSignal
          ) => Promise<string>)(args as any, this.serviceClient, signal),
      },
      {
        tool: reviewGitDiffTool,
        handler: (args, signal) =>
          (handleReviewGitDiff as unknown as (
            args: unknown,
            serviceClient: ContextServiceClient,
            signal?: AbortSignal
          ) => Promise<string>)(args as any, this.serviceClient, signal),
      },
      {
        tool: reviewDiffTool,
        handler: (args, signal) =>
          (handleReviewDiff as unknown as (
            args: unknown,
            serviceClient: ContextServiceClient,
            signal?: AbortSignal
          ) => Promise<string>)(args as any, this.serviceClient, signal),
      },
      {
        tool: reviewAutoTool,
        handler: (args, signal) =>
          (handleReviewAuto as unknown as (
            args: unknown,
            serviceClient: ContextServiceClient,
            signal?: AbortSignal
          ) => Promise<string>)(args as any, this.serviceClient, signal),
      },
      { tool: checkInvariantsTool, handler: (args) => handleCheckInvariants(args as any, this.serviceClient) },
      { tool: runStaticAnalysisTool, handler: (args) => handleRunStaticAnalysis(args as any, this.serviceClient) },
      // Reactive Review tools (Phase 4)
      { tool: findToolByName(reactiveReviewTools, 'reactive_review_pr'), handler: (args) => handleReactiveReviewPR(args as any, this.serviceClient) },
      { tool: findToolByName(reactiveReviewTools, 'get_review_status'), handler: (args) => handleGetReviewStatus(args as any, this.serviceClient) },
      { tool: findToolByName(reactiveReviewTools, 'pause_review'), handler: (args) => handlePauseReview(args as any, this.serviceClient) },
      { tool: findToolByName(reactiveReviewTools, 'resume_review'), handler: (args) => handleResumeReview(args as any, this.serviceClient) },
      { tool: findToolByName(reactiveReviewTools, 'get_review_telemetry'), handler: (args) => handleGetReviewTelemetry(args as any, this.serviceClient) },
      { tool: findToolByName(reactiveReviewTools, 'scrub_secrets'), handler: (args) => handleScrubSecrets(args as any) },
      { tool: findToolByName(reactiveReviewTools, 'validate_content'), handler: (args) => handleValidateContent(args as any) },
    ];

    const tools = toolRegistryEntries.map((entry) => entry.tool);
    const toolHandlers = new Map<string, ToolHandler>(
      toolRegistryEntries.map((entry) => [entry.tool.name, entry.handler])
    );
    this.runtimeToolCount = tools.length;

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const execution = await executeToolCallWithSignal({
        name,
        args,
        toolHandlers,
        signal: extra.signal,
      });

      const metricLabels = { tool: name, result: execution.result };
      incCounter(
        'context_engine_mcp_tool_calls_total',
        metricLabels,
        1,
        'Total MCP tool calls handled by the server.'
      );
      observeDurationMs(
        'context_engine_mcp_tool_call_duration_seconds',
        metricLabels,
        execution.elapsedMs,
        { help: 'MCP tool call handling duration in seconds.' }
      );

      return execution.response;
    });
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
}
