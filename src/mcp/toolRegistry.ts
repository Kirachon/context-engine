import type { ContextServiceClient } from './serviceClient.js';
import {
  semanticSearchTool,
  symbolSearchTool,
  symbolReferencesTool,
  symbolDefinitionTool,
  callRelationshipsTool,
  handleSemanticSearch,
  handleSymbolSearch,
  handleSymbolReferencesSearch,
  handleSymbolDefinition,
  handleCallRelationships,
} from './tools/search.js';
import { findCallersTool, handleFindCallers } from './tools/findCallers.js';
import { findCalleesTool, handleFindCallees } from './tools/findCallees.js';
import { traceSymbolTool, handleTraceSymbol } from './tools/traceSymbol.js';
import { impactAnalysisTool, handleImpactAnalysis } from './tools/impactAnalysis.js';
import { whyThisContextTool, handleWhyThisContext } from './tools/whyThisContext.js';
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
  reviewMemorySuggestionsTool,
  handleReviewMemorySuggestions,
} from './tools/memoryReview.js';
import {
  planManagementTools,
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
import {
  type SignalAwareToolHandler,
  type ToolHandler as RuntimeToolHandler,
} from './executeTool.js';
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
import { applyToolDiscoverability } from './tooling/discoverability.js';
import {
  bindRecordTool,
  bindServiceClientTool,
  bindStandaloneTool,
  type ServiceClientToolHandler,
} from './toolRegistryBinders.js';
import type { JsonSchema } from './types/outputSchema.js';

export type ToolRegistryEntry = {
  tool: { name: string; inputSchema?: JsonSchema };
  handler: SignalAwareToolHandler;
};

// Re-export for compatibility with existing server.ts type import paths.
export type ToolHandler = RuntimeToolHandler;

function findToolByName(tools: Array<{ name: string }>, name: string): { name: string } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool definition not found: ${name}`);
  }
  return tool;
}

function bindClient<TArgs>(
  serviceClient: ContextServiceClient,
  handler: ServiceClientToolHandler<TArgs>
): SignalAwareToolHandler {
  return bindServiceClientTool(serviceClient, handler);
}

export function buildToolRegistryEntries(serviceClient: ContextServiceClient): ToolRegistryEntry[] {
  return [
    { tool: applyToolDiscoverability(indexWorkspaceTool), handler: bindClient(serviceClient, handleIndexWorkspace) },
    { tool: applyToolDiscoverability(codebaseRetrievalTool), handler: bindClient(serviceClient, handleCodebaseRetrieval) },
    { tool: applyToolDiscoverability(semanticSearchTool), handler: bindClient(serviceClient, handleSemanticSearch) },
    { tool: applyToolDiscoverability(symbolSearchTool), handler: bindClient(serviceClient, handleSymbolSearch) },
    { tool: applyToolDiscoverability(symbolReferencesTool), handler: bindClient(serviceClient, handleSymbolReferencesSearch) },
    { tool: applyToolDiscoverability(symbolDefinitionTool), handler: bindClient(serviceClient, handleSymbolDefinition) },
    { tool: applyToolDiscoverability(callRelationshipsTool), handler: bindClient(serviceClient, handleCallRelationships) },
    { tool: applyToolDiscoverability(findCallersTool), handler: bindClient(serviceClient, handleFindCallers) },
    { tool: applyToolDiscoverability(findCalleesTool), handler: bindClient(serviceClient, handleFindCallees) },
    { tool: applyToolDiscoverability(traceSymbolTool), handler: bindClient(serviceClient, handleTraceSymbol) },
    { tool: applyToolDiscoverability(impactAnalysisTool), handler: bindClient(serviceClient, handleImpactAnalysis) },
    { tool: applyToolDiscoverability(whyThisContextTool), handler: bindClient(serviceClient, handleWhyThisContext) },
    { tool: applyToolDiscoverability(getFileTool), handler: bindClient(serviceClient, handleGetFile) },
    { tool: applyToolDiscoverability(getContextTool), handler: bindClient(serviceClient, handleGetContext) },
    { tool: applyToolDiscoverability(enhancePromptTool), handler: bindClient(serviceClient, handleEnhancePrompt) },
    { tool: applyToolDiscoverability(indexStatusTool), handler: bindClient(serviceClient, handleIndexStatus) },
    { tool: applyToolDiscoverability(reindexWorkspaceTool), handler: bindClient(serviceClient, handleReindexWorkspace) },
    { tool: applyToolDiscoverability(clearIndexTool), handler: bindClient(serviceClient, handleClearIndex) },
    { tool: applyToolDiscoverability(toolManifestTool), handler: bindClient(serviceClient, handleToolManifest) },
    { tool: applyToolDiscoverability(addMemoryTool), handler: bindClient(serviceClient, handleAddMemory) },
    { tool: applyToolDiscoverability(listMemoriesTool), handler: bindClient(serviceClient, handleListMemories) },
    { tool: applyToolDiscoverability(reviewMemorySuggestionsTool), handler: bindClient(serviceClient, handleReviewMemorySuggestions) },
    { tool: applyToolDiscoverability(createPlanTool), handler: bindClient(serviceClient, handleCreatePlan) },
    { tool: applyToolDiscoverability(refinePlanTool), handler: bindClient(serviceClient, handleRefinePlan) },
    { tool: applyToolDiscoverability(visualizePlanTool), handler: bindClient(serviceClient, handleVisualizePlan) },
    { tool: applyToolDiscoverability(executePlanTool), handler: bindClient(serviceClient, handleExecutePlan) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'save_plan')), handler: bindRecordTool(handleSavePlan) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'load_plan')), handler: bindRecordTool(handleLoadPlan) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'list_plans')), handler: bindRecordTool(handleListPlans) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'delete_plan')), handler: bindRecordTool(handleDeletePlan) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'request_approval')), handler: bindRecordTool(handleRequestApproval) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'respond_approval')), handler: bindRecordTool(handleRespondApproval) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'start_step')), handler: bindRecordTool(handleStartStep) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'complete_step')), handler: bindRecordTool(handleCompleteStep) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'fail_step')), handler: bindRecordTool(handleFailStep) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'view_progress')), handler: bindRecordTool(handleViewProgress) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'view_history')), handler: bindRecordTool(handleViewHistory) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'compare_plan_versions')), handler: bindRecordTool(handleComparePlanVersions) },
    { tool: applyToolDiscoverability(findToolByName(planManagementTools, 'rollback_plan')), handler: bindRecordTool(handleRollbackPlan) },
    { tool: applyToolDiscoverability(reviewChangesTool), handler: bindClient(serviceClient, handleReviewChanges) },
    { tool: applyToolDiscoverability(reviewGitDiffTool), handler: bindClient(serviceClient, handleReviewGitDiff) },
    { tool: applyToolDiscoverability(reviewDiffTool), handler: bindClient(serviceClient, handleReviewDiff) },
    { tool: applyToolDiscoverability(reviewAutoTool), handler: bindClient(serviceClient, handleReviewAuto) },
    { tool: applyToolDiscoverability(checkInvariantsTool), handler: bindClient(serviceClient, handleCheckInvariants) },
    { tool: applyToolDiscoverability(runStaticAnalysisTool), handler: bindClient(serviceClient, handleRunStaticAnalysis) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'reactive_review_pr')), handler: bindClient(serviceClient, handleReactiveReviewPR) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'get_review_status')), handler: bindClient(serviceClient, handleGetReviewStatus) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'pause_review')), handler: bindClient(serviceClient, handlePauseReview) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'resume_review')), handler: bindClient(serviceClient, handleResumeReview) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'get_review_telemetry')), handler: bindClient(serviceClient, handleGetReviewTelemetry) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'scrub_secrets')), handler: bindStandaloneTool(handleScrubSecrets) },
    { tool: applyToolDiscoverability(findToolByName(reactiveReviewTools, 'validate_content')), handler: bindStandaloneTool(handleValidateContent) },
  ];
}
