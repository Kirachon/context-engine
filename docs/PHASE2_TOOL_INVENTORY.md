# Phase 2 Tool Inventory

Generated: 2025-12-19T00:24:28.781Z

Total tools discovered: 28

| Tool Name | Tool Symbol | Handler | Tool File | Handler File | In ListTools | In Manifest | Input Schema |
|---|---|---|---|---|---|---|---|
| add_memory | addMemoryTool | handleAddMemory | src/mcp/tools/memory.ts | src/mcp/tools/memory.ts | yes | no | inline |
| clear_index | clearIndexTool | handleClearIndex | src/mcp/tools/lifecycle.ts | src/mcp/tools/lifecycle.ts | yes | yes | inline |
| codebase_retrieval | codebaseRetrievalTool | handleCodebaseRetrieval | src/mcp/tools/codebaseRetrieval.ts | src/mcp/tools/codebaseRetrieval.ts | yes | yes | inline |
| compare_plan_versions | comparePlanVersionsTool | handleComparePlanVersions | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| complete_step | completeStepTool | handleCompleteStep | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| create_plan | createPlanTool | handleCreatePlan | src/mcp/tools/plan.ts | src/mcp/tools/plan.ts | yes | yes | inline |
| delete_plan | deletePlanTool | handleDeletePlan | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| enhance_prompt | enhancePromptTool | handleEnhancePrompt | src/mcp/tools/enhance.ts | src/mcp/tools/enhance.ts | yes | yes | inline |
| fail_step | failStepTool | handleFailStep | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| get_context_for_prompt | getContextTool | handleGetContext | src/mcp/tools/context.ts | src/mcp/tools/context.ts | yes | yes | inline |
| get_file | getFileTool | handleGetFile | src/mcp/tools/file.ts | src/mcp/tools/file.ts | yes | yes | inline |
| index_status | indexStatusTool | handleIndexStatus | src/mcp/tools/status.ts | src/mcp/tools/status.ts | yes | yes | inline |
| index_workspace | indexWorkspaceTool | handleIndexWorkspace | src/mcp/tools/index.ts | src/mcp/tools/index.ts | yes | yes | inline |
| list_memories | listMemoriesTool | handleListMemories | src/mcp/tools/memory.ts | src/mcp/tools/memory.ts | yes | no | inline |
| list_plans | listPlansTool | handleListPlans | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| load_plan | loadPlanTool | handleLoadPlan | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| refine_plan | refinePlanTool | handleRefinePlan | src/mcp/tools/plan.ts | src/mcp/tools/plan.ts | yes | yes | inline |
| reindex_workspace | reindexWorkspaceTool | handleReindexWorkspace | src/mcp/tools/lifecycle.ts | src/mcp/tools/lifecycle.ts | yes | yes | inline |
| request_approval | requestApprovalTool | handleRequestApproval | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| respond_approval | respondApprovalTool | handleRespondApproval | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| rollback_plan | rollbackPlanTool | handleRollbackPlan | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| save_plan | savePlanTool | handleSavePlan | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| semantic_search | semanticSearchTool | handleSemanticSearch | src/mcp/tools/search.ts | src/mcp/tools/search.ts | yes | yes | inline |
| start_step | startStepTool | handleStartStep | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| tool_manifest | toolManifestTool | handleToolManifest | src/mcp/tools/manifest.ts | src/mcp/tools/manifest.ts | yes | yes | inline |
| view_history | viewHistoryTool | handleViewHistory | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| view_progress | viewProgressTool | handleViewProgress | src/mcp/tools/planManagement.ts | src/mcp/tools/planManagement.ts | yes | yes | inline |
| visualize_plan | visualizePlanTool | handleVisualizePlan | src/mcp/tools/plan.ts | src/mcp/tools/plan.ts | yes | yes | inline |

Notes:
- Tool symbols and handlers are parsed from source and may require manual verification for edge cases.
- `planManagementTools` is expanded heuristically based on tool name patterns.
