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
          // Memory tools (v1.4.1)
          addMemoryTool,
          listMemoriesTool,
          // Planning tools (Phase 1)
          createPlanTool,
          refinePlanTool,
          visualizePlanTool,
          executePlanTool,
          // Plan management tools (Phase 2)
          ...planManagementTools,
          // Code Review tools (v1.5.0)
          reviewChangesTool,
          reviewGitDiffTool,
          // Reactive Review tools (Phase 4)
          ...reactiveReviewTools,
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

          // Memory tools (v1.4.1)
          case 'add_memory':
            result = await handleAddMemory(args as any, this.serviceClient);
            break;

          case 'list_memories':
            result = await handleListMemories(args as any, this.serviceClient);
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

          case 'execute_plan':
            result = await handleExecutePlan(args as any, this.serviceClient);
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

          // Code Review tools (v1.5.0)
          case 'review_changes':
            result = await handleReviewChanges(args as any, this.serviceClient);
            break;

          case 'review_git_diff':
            result = await handleReviewGitDiff(args as any, this.serviceClient);
            break;

          // Reactive Review tools (Phase 4)
          case 'reactive_review_pr':
            result = await handleReactiveReviewPR(args as any, this.serviceClient);
            break;

          case 'get_review_status':
            result = await handleGetReviewStatus(args as any, this.serviceClient);
            break;

          case 'pause_review':
            result = await handlePauseReview(args as any, this.serviceClient);
            break;

          case 'resume_review':
            result = await handleResumeReview(args as any, this.serviceClient);
            break;

          case 'get_review_telemetry':
            result = await handleGetReviewTelemetry(args as any, this.serviceClient);
            break;

          case 'scrub_secrets':
            result = await handleScrubSecrets(args as any);
            break;

          case 'validate_content':
            result = await handleValidateContent(args as any);
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
    console.error('Context Engine MCP Server v1.6.0');
    console.error('='.repeat(60));
    console.error(`Workspace: ${this.workspacePath}`);
    console.error('Transport: stdio');
    console.error(`Watcher: ${this.enableWatcher ? 'enabled' : 'disabled'}`);
    console.error('');
    console.error('Available tools (36 total):');
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
    console.error('    - review_changes, review_git_diff');
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
