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
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type GetPromptResult,
  type Prompt,
  type PromptMessage,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { normalizeIgnoredPatterns } from '../watcher/ignoreRules.js';

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
import { MCP_SERVER_VERSION, getToolManifest, toolManifestTool, handleToolManifest } from './tools/manifest.js';
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
  getPlanHistoryService,
  getPlanPersistenceService,
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
import { CODE_REVIEW_SYSTEM_PROMPT, buildCodeReviewPrompt } from './prompts/codeReview.js';
import {
  ENHANCE_REQUEST_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
  buildCreatePlanPromptRequest,
  buildEnhanceRequestPrompt,
  buildRefinePlanPromptRequest,
  getCreatePlanPromptArguments,
  getEnhanceRequestPromptArguments,
} from './prompts/planning.js';
import {
  applyPromptDiscoverability,
  applyResourceDiscoverability,
  applyToolDiscoverability,
  getDefaultDiscoverabilityTitle,
} from './tooling/discoverability.js';
import { validateExternalSources, validatePathScopeGlobs } from './tooling/validation.js';
import { formatRequestLogPrefix } from '../telemetry/requestContext.js';

type ToolRegistryEntry = {
  tool: { name: string };
  handler: SignalAwareToolHandler;
};

// Re-export for compatibility with existing server.ts type import paths.
export type ToolHandler = RuntimeToolHandler;

type SignalAwareToolHandler = (args: unknown, signal?: AbortSignal) => Promise<string>;

export type ServerCapabilityOptions = {
  resources?: boolean;
  prompts?: boolean;
};

const TOOL_MANIFEST_RESOURCE_URI = 'context-engine://tool-manifest';
const PLAN_RESOURCE_URI_PREFIX = 'context-engine://plans/';
const PLAN_HISTORY_RESOURCE_URI_PREFIX = 'context-engine://plan-history/';
const RESOURCE_NOT_FOUND_MESSAGE = 'Resource not found';

type PromptArgumentsMap = Record<string, string>;

type PromptDescriptor = Prompt & {
  name: string;
};

export const PROMPT_DEFINITIONS: PromptDescriptor[] = [
  applyPromptDiscoverability({
    name: 'create-plan',
    description: 'Build a planning request using the repo planning templates.',
    arguments: getCreatePlanPromptArguments(),
  }),
  applyPromptDiscoverability({
    name: 'refine-plan',
    description: 'Build a plan-refinement request using the repo refinement templates.',
    arguments: [
      { name: 'current_plan', description: 'Existing plan JSON string.', required: true },
      { name: 'feedback', description: 'Optional refinement feedback text.' },
      { name: 'clarifications', description: 'Optional JSON object string of clarification answers.' },
    ],
  }),
  applyPromptDiscoverability({
    name: 'review-diff',
    description: 'Build a code-review request for a diff using the repo review templates.',
    arguments: [
      { name: 'diff', description: 'Unified diff to review.', required: true },
      { name: 'categories', description: 'Optional comma-separated category list.' },
      { name: 'custom_instructions', description: 'Optional extra review instructions.' },
    ],
  }),
  applyPromptDiscoverability({
    name: 'enhance-request',
    description: 'Build a request-enhancement prompt using the repo prompt-enhancement templates.',
    arguments: getEnhanceRequestPromptArguments(),
  }),
];

export function createServerCapabilities(options?: ServerCapabilityOptions): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    tools: { listChanged: true },
  };

  if (options?.resources) {
    capabilities.resources = { subscribe: false, listChanged: true };
  }
  if (options?.prompts) {
    capabilities.prompts = { listChanged: true };
  }

  return capabilities;
}

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

  log(`${formatRequestLogPrefix()} [${new Date().toISOString()}] Tool: ${name}`);

  try {
    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = await handler(args, signal);
    const elapsedMs = now() - startTime;
    log(`${formatRequestLogPrefix()} [${new Date().toISOString()}] Tool ${name} completed in ${elapsedMs}ms`);

    return {
      response: formatToolExecutionResponse(result).response,
      result: 'success',
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    log(`${formatRequestLogPrefix()} [${new Date().toISOString()}] Tool ${name} failed after ${elapsedMs}ms: ${errorMessage}`);

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

function buildPlanResourceUri(planId: string): string {
  return `${PLAN_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;
}

function buildPlanHistoryResourceUri(planId: string): string {
  return `${PLAN_HISTORY_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;
}

function buildTextResourceContents(uri: string, text: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text,
      },
    ],
  };
}

function buildPromptTextMessage(role: 'assistant' | 'user', text: string): PromptMessage {
  return {
    role,
    content: {
      type: 'text',
      text,
    },
  };
}

function buildPromptResult(description: string, messages: PromptMessage[]): GetPromptResult {
  return {
    description,
    messages,
  };
}

function parseRequiredPromptString(args: PromptArgumentsMap, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" is required`);
  }
  return value.trim();
}

function parseOptionalBooleanPromptString(args: PromptArgumentsMap, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" must be "true" or "false"`);
}

function parseOptionalPositiveIntegerPromptString(
  args: PromptArgumentsMap,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "${key}" must be a positive integer`);
  }

  return parsed;
}

function parseOptionalClarifications(args: PromptArgumentsMap): Record<string, string> | undefined {
  const raw = args.clarifications;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Clarifications must be a JSON object');
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InvalidParams, `Prompt argument "clarifications" must be valid JSON: ${message}`);
  }
}

function parseOptionalPromptPathList(args: PromptArgumentsMap, key: 'include_paths' | 'exclude_paths'): string[] | undefined {
  const raw = args[key];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = raw
    .split(/[\r\n,]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return validatePathScopeGlobs(parsed, key);
}

function parseOptionalPromptExternalSources(args: PromptArgumentsMap) {
  const raw = args.external_sources;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateExternalSources(parsed, 'external_sources');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Prompt argument "external_sources" must be valid JSON: ${message}`
    );
  }
}

function parseOptionalReviewCategories(args: PromptArgumentsMap): string[] | undefined {
  const raw = args.categories;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

function resourceNotFoundError(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `${RESOURCE_NOT_FOUND_MESSAGE}: ${uri}`);
}

function decodePlanIdFromResourceUri(uri: string, prefix: string): string {
  if (!uri.startsWith(prefix)) {
    throw resourceNotFoundError(uri);
  }

  const encodedPlanId = uri.slice(prefix.length);
  if (!encodedPlanId) {
    throw resourceNotFoundError(uri);
  }

  try {
    const planId = decodeURIComponent(encodedPlanId);
    if (!planId.trim()) {
      throw new Error('empty plan id');
    }
    return planId;
  } catch {
    throw resourceNotFoundError(uri);
  }
}

export async function buildResourceList(): Promise<Resource[]> {
  const persistenceService = getPlanPersistenceService();
  const knownPlans = await persistenceService.listPlans({
    sort_by: 'name',
    sort_order: 'asc',
  });

  const resources: Resource[] = [
    applyResourceDiscoverability({
      uri: TOOL_MANIFEST_RESOURCE_URI,
      name: 'tool-manifest',
      title: getDefaultDiscoverabilityTitle('tool-manifest'),
      description: 'JSON tool manifest for the current Context Engine server.',
      mimeType: 'application/json',
    }),
  ];

  for (const plan of knownPlans) {
    resources.push(
      applyResourceDiscoverability({
        uri: buildPlanResourceUri(plan.id),
        name: `plan:${plan.id}`,
        title: getDefaultDiscoverabilityTitle('saved-plan'),
        description: `Saved plan ${plan.id}.`,
        mimeType: 'application/json',
      }),
      applyResourceDiscoverability({
        uri: buildPlanHistoryResourceUri(plan.id),
        name: `plan-history:${plan.id}`,
        title: getDefaultDiscoverabilityTitle('plan-history'),
        description: `Version history for saved plan ${plan.id}.`,
        mimeType: 'application/json',
      })
    );
  }

  return resources;
}

export async function readResourceByUri(uri: string): Promise<ReadResourceResult> {
  if (uri === TOOL_MANIFEST_RESOURCE_URI) {
    return buildTextResourceContents(uri, JSON.stringify(getToolManifest(), null, 2));
  }

  if (uri.startsWith(PLAN_RESOURCE_URI_PREFIX)) {
    const planId = decodePlanIdFromResourceUri(uri, PLAN_RESOURCE_URI_PREFIX);
    const persistenceService = getPlanPersistenceService();
    const plan = await persistenceService.loadPlan(planId);
    if (!plan) {
      throw resourceNotFoundError(uri);
    }
    return buildTextResourceContents(uri, JSON.stringify(plan, null, 2));
  }

  if (uri.startsWith(PLAN_HISTORY_RESOURCE_URI_PREFIX)) {
    const planId = decodePlanIdFromResourceUri(uri, PLAN_HISTORY_RESOURCE_URI_PREFIX);
    const persistenceService = getPlanPersistenceService();
    const planExists = await persistenceService.planExists(planId);
    if (!planExists) {
      throw resourceNotFoundError(uri);
    }

    const historyService = getPlanHistoryService();
    const history = historyService.getHistory(planId, { include_plans: true });
    if (!history) {
      throw resourceNotFoundError(uri);
    }
    return buildTextResourceContents(uri, JSON.stringify(history, null, 2));
  }

  throw resourceNotFoundError(uri);
}

function getPromptByName(name: string): PromptDescriptor {
  const prompt = PROMPT_DEFINITIONS.find((entry) => entry.name === name);
  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  return prompt;
}

export function buildPromptByName(name: string, rawArgs: PromptArgumentsMap = {}): GetPromptResult {
  switch (name) {
    case 'create-plan': {
      const task = parseRequiredPromptString(rawArgs, 'task');
      const autoScope = parseOptionalBooleanPromptString(rawArgs, 'auto_scope');
      const mvpOnly = parseOptionalBooleanPromptString(rawArgs, 'mvp_only');
      const maxContextFiles = parseOptionalPositiveIntegerPromptString(rawArgs, 'max_context_files');
      const contextTokenBudget = parseOptionalPositiveIntegerPromptString(rawArgs, 'context_token_budget');
      const includePaths = parseOptionalPromptPathList(rawArgs, 'include_paths');
      const excludePaths = parseOptionalPromptPathList(rawArgs, 'exclude_paths');
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', PLANNING_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildCreatePlanPromptRequest({
            task,
            auto_scope: autoScope,
            mvp_only: mvpOnly,
            max_context_files: maxContextFiles,
            context_token_budget: contextTokenBudget,
            include_paths: includePaths,
            exclude_paths: excludePaths,
            profile: mvpOnly ? 'compact' : 'deep',
          })
        ),
      ]);
    }
    case 'refine-plan': {
      const currentPlan = parseRequiredPromptString(rawArgs, 'current_plan');
      const feedback = rawArgs.feedback?.trim();
      const clarifications = parseOptionalClarifications(rawArgs);
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', REFINEMENT_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildRefinePlanPromptRequest({
            currentPlan,
            feedback,
            clarifications,
            profile: 'deep',
          })
        ),
      ]);
    }
    case 'review-diff': {
      const diff = parseRequiredPromptString(rawArgs, 'diff');
      const categories = parseOptionalReviewCategories(rawArgs);
      const customInstructions = rawArgs.custom_instructions?.trim();
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', CODE_REVIEW_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildCodeReviewPrompt(diff, {}, {
            categories: categories as any,
            custom_instructions: customInstructions,
          })
        ),
      ]);
    }
    case 'enhance-request': {
      const requestPrompt = parseRequiredPromptString(rawArgs, 'prompt');
      const autoScope = parseOptionalBooleanPromptString(rawArgs, 'auto_scope');
      const includePaths = parseOptionalPromptPathList(rawArgs, 'include_paths');
      const excludePaths = parseOptionalPromptPathList(rawArgs, 'exclude_paths');
      const externalSources = parseOptionalPromptExternalSources(rawArgs);
      const prompt = getPromptByName(name);
      return buildPromptResult(prompt.description ?? '', [
        buildPromptTextMessage('assistant', ENHANCE_REQUEST_SYSTEM_PROMPT),
        buildPromptTextMessage(
          'user',
          buildEnhanceRequestPrompt(requestPrompt, {
            autoScope,
            includePaths,
            excludePaths,
            externalSourcesJson: externalSources
              ? JSON.stringify(
                  externalSources.map((source) => ({
                    type: source.type,
                    url: source.url,
                    ...(source.label ? { label: source.label } : {}),
                  })),
                  null,
                  2
                )
              : undefined,
          })
        ),
      ]);
    }
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}

function findToolByName(tools: Array<{ name: string }>, name: string): { name: string } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool definition not found: ${name}`);
  }
  return tool;
}

export function buildToolRegistryEntries(serviceClient: ContextServiceClient): ToolRegistryEntry[] {
  return [
    { tool: applyToolDiscoverability(indexWorkspaceTool), handler: (args) => handleIndexWorkspace(args as any, serviceClient) },
    { tool: applyToolDiscoverability(codebaseRetrievalTool), handler: (args) => handleCodebaseRetrieval(args as any, serviceClient) },
    { tool: applyToolDiscoverability(semanticSearchTool), handler: (args) => handleSemanticSearch(args as any, serviceClient) },
    { tool: applyToolDiscoverability(getFileTool), handler: (args) => handleGetFile(args as any, serviceClient) },
    { tool: applyToolDiscoverability(getContextTool), handler: (args) => handleGetContext(args as any, serviceClient) },
    { tool: applyToolDiscoverability(enhancePromptTool), handler: (args, signal) => handleEnhancePrompt(args as any, serviceClient, signal) },
    { tool: applyToolDiscoverability(indexStatusTool), handler: (args) => handleIndexStatus(args as any, serviceClient) },
    { tool: applyToolDiscoverability(reindexWorkspaceTool), handler: (args) => handleReindexWorkspace(args as any, serviceClient) },
    { tool: applyToolDiscoverability(clearIndexTool), handler: (args) => handleClearIndex(args as any, serviceClient) },
    { tool: applyToolDiscoverability(toolManifestTool), handler: (args) => handleToolManifest(args as any, serviceClient) },
    { tool: applyToolDiscoverability(addMemoryTool), handler: (args) => handleAddMemory(args as any, serviceClient) },
    { tool: applyToolDiscoverability(listMemoriesTool), handler: (args) => handleListMemories(args as any, serviceClient) },
    { tool: applyToolDiscoverability(createPlanTool), handler: (args, signal) => handleCreatePlan(args as any, serviceClient, signal) },
    { tool: applyToolDiscoverability(refinePlanTool), handler: (args, signal) => handleRefinePlan(args as any, serviceClient, signal) },
    { tool: applyToolDiscoverability(visualizePlanTool), handler: (args) => handleVisualizePlan(args as any, serviceClient) },
    { tool: applyToolDiscoverability(executePlanTool), handler: (args, signal) => handleExecutePlan(args as any, serviceClient, signal) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'save_plan')), handler: (args) => handleSavePlan(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'load_plan')), handler: (args) => handleLoadPlan(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'list_plans')), handler: (args) => handleListPlans(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'delete_plan')), handler: (args) => handleDeletePlan(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'request_approval')), handler: (args) => handleRequestApproval(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'respond_approval')), handler: (args) => handleRespondApproval(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'start_step')), handler: (args) => handleStartStep(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'complete_step')), handler: (args) => handleCompleteStep(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'fail_step')), handler: (args) => handleFailStep(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'view_progress')), handler: (args) => handleViewProgress(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'view_history')), handler: (args) => handleViewHistory(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'compare_plan_versions')), handler: (args) => handleComparePlanVersions(args as Record<string, unknown>) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'rollback_plan')), handler: (args) => handleRollbackPlan(args as Record<string, unknown>) },
    {
      tool: applyToolDiscoverability(reviewChangesTool),
      handler: (args, signal) =>
        (handleReviewChanges as unknown as (
          args: unknown,
          serviceClient: ContextServiceClient,
          signal?: AbortSignal
        ) => Promise<string>)(args as any, serviceClient, signal),
    },
    {
      tool: applyToolDiscoverability(reviewGitDiffTool),
      handler: (args, signal) =>
        (handleReviewGitDiff as unknown as (
          args: unknown,
          serviceClient: ContextServiceClient,
          signal?: AbortSignal
        ) => Promise<string>)(args as any, serviceClient, signal),
    },
    {
      tool: applyToolDiscoverability(reviewDiffTool),
      handler: (args, signal) =>
        (handleReviewDiff as unknown as (
          args: unknown,
          serviceClient: ContextServiceClient,
          signal?: AbortSignal
        ) => Promise<string>)(args as any, serviceClient, signal),
    },
    {
      tool: applyToolDiscoverability(reviewAutoTool),
      handler: (args, signal) =>
        (handleReviewAuto as unknown as (
          args: unknown,
          serviceClient: ContextServiceClient,
          signal?: AbortSignal
        ) => Promise<string>)(args as any, serviceClient, signal),
    },
    { tool: applyToolDiscoverability(checkInvariantsTool), handler: (args) => handleCheckInvariants(args as any, serviceClient) },
    { tool: applyToolDiscoverability(runStaticAnalysisTool), handler: (args) => handleRunStaticAnalysis(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'reactive_review_pr')), handler: (args) => handleReactiveReviewPR(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'get_review_status')), handler: (args) => handleGetReviewStatus(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'pause_review')), handler: (args) => handlePauseReview(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'resume_review')), handler: (args) => handleResumeReview(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'get_review_telemetry')), handler: (args) => handleGetReviewTelemetry(args as any, serviceClient) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'scrub_secrets')), handler: (args) => handleScrubSecrets(args as any) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'validate_content')), handler: (args) => handleValidateContent(args as any) },
  ];
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
        capabilities: createServerCapabilities({ resources: true, prompts: true }),
      }
    );

    this.setupHandlers();
    this.setupGracefulShutdown();

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
    const toolRegistryEntries = buildToolRegistryEntries(this.serviceClient);

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

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: await buildResourceList(),
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await readResourceByUri(request.params.uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: PROMPT_DEFINITIONS,
      };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return buildPromptByName(request.params.name, request.params.arguments ?? {});
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
