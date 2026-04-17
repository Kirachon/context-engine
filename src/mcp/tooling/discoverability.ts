import type { Prompt, Resource, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

type RelatedSurfaceMetadata = {
  tools?: string[];
  prompts?: string[];
  resources?: string[];
};

type BaseDiscoverabilityMetadata = {
  title: string;
  usageHint?: string;
  examples?: string[];
  safetyHints?: string[];
  related?: RelatedSurfaceMetadata;
};

type ToolDiscoverabilityMetadata = BaseDiscoverabilityMetadata & {
  annotations?: ToolAnnotations;
};

export type PromptDiscoverabilityMetadata = BaseDiscoverabilityMetadata;
export type ResourceDiscoverabilityMetadata = BaseDiscoverabilityMetadata & {
  uriPattern: string;
};

export type ManifestDiscoverabilityEntry = {
  id: string;
  title: string;
  usage_hint?: string;
  examples?: string[];
  safety_hints?: string[];
  related_surfaces?: RelatedSurfaceMetadata;
};

export type ManifestResourceDiscoverabilityEntry = ManifestDiscoverabilityEntry & {
  uri_pattern: string;
};

function titleCaseIdentifier(identifier: string): string {
  return identifier
    .split(/[-_]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.length <= 2) {
        return segment.toUpperCase();
      }
      return segment[0]!.toUpperCase() + segment.slice(1);
    })
    .join(' ');
}

function cloneRelated(related?: RelatedSurfaceMetadata): RelatedSurfaceMetadata | undefined {
  if (!related) {
    return undefined;
  }

  return {
    ...(related.tools ? { tools: [...related.tools] } : {}),
    ...(related.prompts ? { prompts: [...related.prompts] } : {}),
    ...(related.resources ? { resources: [...related.resources] } : {}),
  };
}

function toManifestEntry(
  id: string,
  metadata: BaseDiscoverabilityMetadata
): ManifestDiscoverabilityEntry {
  return {
    id,
    title: metadata.title,
    ...(metadata.usageHint ? { usage_hint: metadata.usageHint } : {}),
    ...(metadata.examples ? { examples: [...metadata.examples] } : {}),
    ...(metadata.safetyHints ? { safety_hints: [...metadata.safetyHints] } : {}),
    ...(metadata.related ? { related_surfaces: cloneRelated(metadata.related) } : {}),
  };
}

function toolMetadata(
  title: string,
  overrides: Omit<ToolDiscoverabilityMetadata, 'title'> = {}
): ToolDiscoverabilityMetadata {
  return { title, ...overrides };
}

const TOOL_DISCOVERABILITY: Record<string, ToolDiscoverabilityMetadata> = {
  index_workspace: toolMetadata('Index Workspace', {
    usageHint: 'Build or refresh the semantic search index for the current workspace.',
    examples: ['Index the current workspace before running retrieval tools.'],
    safetyHints: ['Writes local index state and cache artifacts under the workspace.'],
    related: {
      resources: ['context-engine://tool-manifest'],
      tools: ['index_status', 'reindex_workspace'],
    },
    annotations: {
      title: 'Index Workspace',
    },
  }),
  codebase_retrieval: toolMetadata('Codebase Retrieval', {
    usageHint: 'Use when you need semantic codebase discovery before opening files or editing.',
    examples: ['Where is authentication handled?', 'What files shape the planning flow?'],
    safetyHints: ['Read-only retrieval over the indexed workspace.'],
    related: {
      prompts: ['enhance-request'],
      tools: ['semantic_search', 'get_context_for_prompt'],
    },
    annotations: {
      title: 'Codebase Retrieval',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  semantic_search: toolMetadata('Semantic Search', {
    usageHint: 'Search by intent or concept when you know what you need but not the exact symbol name.',
    examples: ['Find retry logic for HTTP calls.', 'Show ranking heuristics for retrieval.'],
    safetyHints: ['Read-only retrieval over indexed code chunks.'],
    related: {
      tools: ['codebase_retrieval', 'get_file'],
    },
    annotations: {
      title: 'Semantic Search',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  symbol_search: toolMetadata('Symbol Search', {
    usageHint: 'Search by identifier when you know the exact or near-exact symbol name.',
    examples: ['Find resolveAIProviderId.', 'Locate ContextServiceClientStrongTokenProof.'],
    safetyHints: ['Read-only deterministic local retrieval for identifier-style code navigation.'],
    related: {
      tools: ['semantic_search', 'get_file'],
    },
    annotations: {
      title: 'Symbol Search',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  symbol_references: toolMetadata('Symbol References', {
    usageHint: 'Find non-declaration usages when you already know the identifier name.',
    examples: ['Show usages of resolveAIProviderId.', 'Find where activeProvider is referenced.'],
    safetyHints: ['Read-only deterministic local retrieval for non-declaration symbol usages.'],
    related: {
      tools: ['symbol_search', 'get_file'],
    },
    annotations: {
      title: 'Symbol References',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  get_file: toolMetadata('Get File', {
    usageHint: 'Read the full contents of a known file or a targeted line range.',
    examples: ['Open src/mcp/server.ts.', 'Read package.json to confirm scripts.'],
    safetyHints: ['Read-only file access within the workspace.'],
    related: {
      tools: ['codebase_retrieval', 'semantic_search'],
    },
    annotations: {
      title: 'Get File',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  get_context_for_prompt: toolMetadata('Get Context For Prompt', {
    usageHint: 'Assemble multi-file context and summaries before writing or refining a prompt.',
    examples: ['Gather context for the MCP HTTP transport.', 'Show files relevant to plan execution.'],
    safetyHints: ['Read-only; may include external grounding only when explicitly requested.'],
    related: {
      prompts: ['enhance-request'],
      tools: ['enhance_prompt', 'codebase_retrieval'],
    },
    annotations: {
      title: 'Get Context For Prompt',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  enhance_prompt: toolMetadata('Enhance Prompt', {
    usageHint: 'Turn a vague request into an actionable repo-grounded prompt with optional scope control.',
    examples: ['Enhance a request to improve login UX.', 'Sharpen a refactor request with external docs.'],
    safetyHints: ['Read-only; enhancement may use external references only when provided explicitly.'],
    related: {
      prompts: ['enhance-request'],
      tools: ['get_context_for_prompt', 'create_plan'],
    },
    annotations: {
      title: 'Enhance Prompt',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  index_status: toolMetadata('Index Status', {
    usageHint: 'Check whether the semantic index is healthy or stale before running retrieval.',
    examples: ['Inspect index health before a large search.'],
    safetyHints: ['Read-only status check.'],
    related: {
      tools: ['index_workspace', 'reindex_workspace', 'clear_index'],
    },
    annotations: {
      title: 'Index Status',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  reindex_workspace: toolMetadata('Reindex Workspace', {
    usageHint: 'Force a full rebuild of the semantic index when incremental indexing is not enough.',
    examples: ['Rebuild the entire index after structural codebase changes.'],
    safetyHints: ['Writes local index state and may take longer than incremental indexing.'],
    related: {
      tools: ['index_workspace', 'index_status', 'clear_index'],
    },
    annotations: {
      title: 'Reindex Workspace',
    },
  }),
  clear_index: toolMetadata('Clear Index', {
    usageHint: 'Remove current index state so the next indexing pass starts fresh.',
    examples: ['Clear corrupted index state before reindexing.'],
    safetyHints: ['Destructive to local index/cache state; does not touch source files.'],
    related: {
      tools: ['index_status', 'reindex_workspace'],
    },
    annotations: {
      title: 'Clear Index',
      destructiveHint: true,
    },
  }),
  tool_manifest: toolMetadata('Tool Manifest', {
    usageHint: 'Inspect the server capability inventory and discoverability metadata.',
    examples: ['List tools, prompts, resources, and feature groups exposed by the server.'],
    safetyHints: ['Read-only manifest inspection.'],
    related: {
      resources: ['context-engine://tool-manifest'],
    },
    annotations: {
      title: 'Tool Manifest',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  add_memory: toolMetadata('Add Memory', {
    usageHint: 'Persist a durable project fact, preference, or decision for future sessions.',
    examples: ['Store a project convention about naming or architecture.'],
    safetyHints: ['Writes a memory entry to workspace-managed storage.'],
    related: {
      tools: ['list_memories'],
    },
    annotations: {
      title: 'Add Memory',
    },
  }),
  list_memories: toolMetadata('List Memories', {
    usageHint: 'Review saved facts, decisions, and preferences already captured for the project.',
    examples: ['Show saved project decisions before proposing a refactor.'],
    safetyHints: ['Read-only memory inspection.'],
    related: {
      tools: ['add_memory'],
    },
    annotations: {
      title: 'List Memories',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  review_memory_suggestions: toolMetadata('Review Memory Suggestions', {
    usageHint: 'Review isolated draft memory suggestions in small batches and promote approved entries through the durable memory path.',
    examples: ['List draft batches for the current session.', 'Approve a small batch of high-confidence memory suggestions.'],
    safetyHints: [
      'Writes draft review state and may persist approved memories through the existing add_memory pathway.',
      'Feature-flagged; enable CE_MEMORY_SUGGESTIONS_V1 before using in production workflows.',
    ],
    related: {
      tools: ['add_memory', 'list_memories', 'get_context_for_prompt'],
    },
    annotations: {
      title: 'Review Memory Suggestions',
    },
  }),
  create_plan: toolMetadata('Create Plan', {
    usageHint: 'Generate a scoped implementation plan with context gathering and validation guidance.',
    examples: ['Plan an auth refactor.', 'Plan a safe MCP transport upgrade.'],
    safetyHints: ['May persist a saved plan when auto-save is enabled.'],
    related: {
      prompts: ['create-plan'],
      resources: ['context-engine://plans/{planId}'],
      tools: ['refine_plan', 'visualize_plan', 'execute_plan'],
    },
    annotations: {
      title: 'Create Plan',
    },
  }),
  refine_plan: toolMetadata('Refine Plan', {
    usageHint: 'Adjust an existing plan using review feedback or clarification answers.',
    examples: ['Refine a plan after architecture feedback.'],
    safetyHints: ['May update plan artifacts when paired with persistence tools.'],
    related: {
      prompts: ['refine-plan'],
      resources: ['context-engine://plans/{planId}', 'context-engine://plan-history/{planId}'],
      tools: ['create_plan', 'view_history'],
    },
    annotations: {
      title: 'Refine Plan',
    },
  }),
  visualize_plan: toolMetadata('Visualize Plan', {
    usageHint: 'Render a saved or in-memory plan into diagrams for faster review.',
    examples: ['Show plan dependencies as a Mermaid graph.'],
    safetyHints: ['Read-only transformation of plan data.'],
    related: {
      tools: ['create_plan', 'refine_plan'],
    },
    annotations: {
      title: 'Visualize Plan',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  execute_plan: toolMetadata('Execute Plan', {
    usageHint: 'Generate or apply implementation work from a saved plan or JSON plan definition.',
    examples: ['Execute the next ready plan step.', 'Preview full-plan changes without applying them.'],
    safetyHints: ['Can write code changes when apply_changes is enabled.'],
    related: {
      tools: ['create_plan', 'save_plan', 'view_progress'],
    },
    annotations: {
      title: 'Execute Plan',
    },
  }),
  save_plan: toolMetadata('Save Plan', {
    usageHint: 'Persist a plan artifact for later execution, review, or versioning.',
    examples: ['Save a reviewed plan with a stable name and tags.'],
    safetyHints: ['Writes plan storage and may overwrite when explicitly requested.'],
    related: {
      resources: ['context-engine://plans/{planId}', 'context-engine://plan-history/{planId}'],
      tools: ['load_plan', 'list_plans', 'view_history'],
    },
    annotations: {
      title: 'Save Plan',
    },
  }),
  load_plan: toolMetadata('Load Plan', {
    usageHint: 'Fetch a persisted plan by ID or name before refinement or execution.',
    examples: ['Load a saved rollout plan to continue execution.'],
    safetyHints: ['Read-only plan retrieval.'],
    related: {
      resources: ['context-engine://plans/{planId}'],
      tools: ['save_plan', 'list_plans', 'execute_plan'],
    },
    annotations: {
      title: 'Load Plan',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  list_plans: toolMetadata('List Plans', {
    usageHint: 'Inspect persisted plans before loading, executing, or cleaning them up.',
    examples: ['List active plans tagged for the current release.'],
    safetyHints: ['Read-only plan inventory access.'],
    related: {
      resources: ['context-engine://plans/{planId}'],
      tools: ['load_plan', 'delete_plan'],
    },
    annotations: {
      title: 'List Plans',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  delete_plan: toolMetadata('Delete Plan', {
    usageHint: 'Remove an obsolete saved plan from persistence.',
    examples: ['Delete a superseded draft plan.'],
    safetyHints: ['Destructive to persisted plan data.'],
    related: {
      tools: ['list_plans', 'save_plan'],
    },
    annotations: {
      title: 'Delete Plan',
      destructiveHint: true,
    },
  }),
  request_approval: toolMetadata('Request Approval', {
    usageHint: 'Open an approval gate for a plan or specific plan steps.',
    examples: ['Request approval before executing a risky migration step.'],
    safetyHints: ['Writes approval workflow state.'],
    related: {
      tools: ['respond_approval', 'view_progress'],
    },
    annotations: {
      title: 'Request Approval',
    },
  }),
  respond_approval: toolMetadata('Respond Approval', {
    usageHint: 'Approve, reject, or request modifications for a pending plan approval.',
    examples: ['Approve the next deployment step.'],
    safetyHints: ['Writes approval workflow state.'],
    related: {
      tools: ['request_approval'],
    },
    annotations: {
      title: 'Respond Approval',
    },
  }),
  start_step: toolMetadata('Start Step', {
    usageHint: 'Mark a plan step as in progress before execution begins.',
    examples: ['Start the dependency update step.'],
    safetyHints: ['Writes execution tracking state.'],
    related: {
      tools: ['complete_step', 'fail_step', 'view_progress'],
    },
    annotations: {
      title: 'Start Step',
    },
  }),
  complete_step: toolMetadata('Complete Step', {
    usageHint: 'Record a step as finished with notes and modified files.',
    examples: ['Complete the schema migration step after validation.'],
    safetyHints: ['Writes execution tracking state.'],
    related: {
      tools: ['start_step', 'view_progress'],
    },
    annotations: {
      title: 'Complete Step',
    },
  }),
  fail_step: toolMetadata('Fail Step', {
    usageHint: 'Record a step failure and decide whether to retry or skip dependents.',
    examples: ['Fail a step after a blocked deployment dependency.'],
    safetyHints: ['Writes execution tracking state and may alter plan execution flow.'],
    related: {
      tools: ['start_step', 'view_progress'],
    },
    annotations: {
      title: 'Fail Step',
    },
  }),
  view_progress: toolMetadata('View Progress', {
    usageHint: 'Check how far a saved plan has progressed before continuing execution.',
    examples: ['Inspect plan completion after a worker run.'],
    safetyHints: ['Read-only progress inspection.'],
    related: {
      tools: ['start_step', 'complete_step', 'fail_step'],
    },
    annotations: {
      title: 'View Progress',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  view_history: toolMetadata('View History', {
    usageHint: 'Inspect plan version history before rollback or review.',
    examples: ['Show plan history after multiple refinement rounds.'],
    safetyHints: ['Read-only version history access.'],
    related: {
      resources: ['context-engine://plan-history/{planId}'],
      tools: ['compare_plan_versions', 'rollback_plan'],
    },
    annotations: {
      title: 'View History',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  compare_plan_versions: toolMetadata('Compare Plan Versions', {
    usageHint: 'Diff two versions of the same saved plan.',
    examples: ['Compare version 3 and 4 after a refinement round.'],
    safetyHints: ['Read-only version comparison.'],
    related: {
      tools: ['view_history', 'rollback_plan'],
    },
    annotations: {
      title: 'Compare Plan Versions',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  rollback_plan: toolMetadata('Rollback Plan', {
    usageHint: 'Restore a saved plan to a previous version when a later revision is no longer trusted.',
    examples: ['Rollback to the last approved plan version.'],
    safetyHints: ['Destructive to current persisted plan state.'],
    related: {
      tools: ['view_history', 'compare_plan_versions'],
    },
    annotations: {
      title: 'Rollback Plan',
      destructiveHint: true,
    },
  }),
  review_changes: toolMetadata('Review Changes', {
    usageHint: 'Review a provided diff with structured findings and confidence scores.',
    examples: ['Review a patch for correctness and maintainability.'],
    safetyHints: ['Read-only analysis of supplied diff content.'],
    related: {
      prompts: ['review-diff'],
      tools: ['review_git_diff', 'review_diff', 'review_auto'],
    },
    annotations: {
      title: 'Review Changes',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  review_git_diff: toolMetadata('Review Git Diff', {
    usageHint: 'Review git changes directly from the current workspace state.',
    examples: ['Review staged changes before commit.'],
    safetyHints: ['Read-only review; inspects local git state.'],
    related: {
      tools: ['review_changes', 'review_auto'],
    },
    annotations: {
      title: 'Review Git Diff',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  review_diff: toolMetadata('Review Diff', {
    usageHint: 'Run the deterministic diff-first review pipeline for CI-style review output.',
    examples: ['Review a PR diff with enterprise preflight checks.'],
    safetyHints: ['Read-only diff analysis; optional local analyzers may run.'],
    related: {
      prompts: ['review-diff'],
      tools: ['review_changes', 'review_auto', 'check_invariants', 'run_static_analysis'],
    },
    annotations: {
      title: 'Review Diff',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  review_auto: toolMetadata('Review Auto', {
    usageHint: 'Auto-select the best review mode based on a diff payload or current git state.',
    examples: ['Review the current staged diff without choosing a review path manually.'],
    safetyHints: ['Read-only review orchestration.'],
    related: {
      tools: ['review_changes', 'review_git_diff', 'review_diff'],
    },
    annotations: {
      title: 'Review Auto',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  check_invariants: toolMetadata('Check Invariants', {
    usageHint: 'Run deterministic invariant rules against a diff for CI gating.',
    examples: ['Check local invariants before opening a PR.'],
    safetyHints: ['Read-only deterministic analysis.'],
    related: {
      tools: ['review_diff', 'run_static_analysis'],
    },
    annotations: {
      title: 'Check Invariants',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  run_static_analysis: toolMetadata('Run Static Analysis', {
    usageHint: 'Execute local analyzers like TypeScript or Semgrep and return structured findings.',
    examples: ['Run type-checking on the files changed in a PR.'],
    safetyHints: ['Read-only code analysis; may be slower depending on analyzers.'],
    related: {
      tools: ['review_diff', 'check_invariants'],
    },
    annotations: {
      title: 'Run Static Analysis',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  reactive_review_pr: toolMetadata('Reactive Review PR', {
    usageHint: 'Start a session-based pull request review with pause/resume and telemetry.',
    examples: ['Launch a review session for a large PR.'],
    safetyHints: ['Creates review session state.'],
    related: {
      tools: ['get_review_status', 'pause_review', 'resume_review', 'get_review_telemetry'],
    },
    annotations: {
      title: 'Reactive Review PR',
    },
  }),
  get_review_status: toolMetadata('Get Review Status', {
    usageHint: 'Check progress for an active reactive review session.',
    examples: ['See how many review steps have completed.'],
    safetyHints: ['Read-only session status access.'],
    related: {
      tools: ['reactive_review_pr', 'pause_review', 'resume_review'],
    },
    annotations: {
      title: 'Get Review Status',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  pause_review: toolMetadata('Pause Review', {
    usageHint: 'Pause an active reactive review session without discarding progress.',
    examples: ['Pause a review to free worker capacity.'],
    safetyHints: ['Writes session state.'],
    related: {
      tools: ['reactive_review_pr', 'resume_review'],
    },
    annotations: {
      title: 'Pause Review',
    },
  }),
  resume_review: toolMetadata('Resume Review', {
    usageHint: 'Resume a paused reactive review session from its last checkpoint.',
    examples: ['Resume a paused review after resolving an external blocker.'],
    safetyHints: ['Writes session state.'],
    related: {
      tools: ['reactive_review_pr', 'pause_review'],
    },
    annotations: {
      title: 'Resume Review',
    },
  }),
  get_review_telemetry: toolMetadata('Get Review Telemetry', {
    usageHint: 'Inspect timing, cache, and token telemetry for a reactive review session.',
    examples: ['Check review cache hit rate after a long session.'],
    safetyHints: ['Read-only telemetry inspection.'],
    related: {
      tools: ['reactive_review_pr', 'get_review_status'],
    },
    annotations: {
      title: 'Get Review Telemetry',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  scrub_secrets: toolMetadata('Scrub Secrets', {
    usageHint: 'Mask secrets before logs or snippets are reused in prompts or saved artifacts.',
    examples: ['Scrub a config snippet before sending it to a model.'],
    safetyHints: ['Read-only transformation of provided content.'],
    related: {
      tools: ['validate_content'],
    },
    annotations: {
      title: 'Scrub Secrets',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
  validate_content: toolMetadata('Validate Content', {
    usageHint: 'Run deterministic validation checks for code or structured content before submission.',
    examples: ['Validate generated YAML before saving it.'],
    safetyHints: ['Read-only validation of supplied content.'],
    related: {
      tools: ['scrub_secrets'],
    },
    annotations: {
      title: 'Validate Content',
      readOnlyHint: true,
      idempotentHint: true,
    },
  }),
};

const PROMPT_DISCOVERABILITY: Record<string, PromptDiscoverabilityMetadata> = {
  'create-plan': {
    title: 'Create Plan',
    usageHint: 'Generate a planning request using the repo planning templates.',
    examples: ['Plan a feature rollout with mvp_only enabled.'],
    safetyHints: ['Prompt-only helper; it does not persist or execute plans by itself.'],
    related: {
      tools: ['create_plan', 'refine_plan'],
      resources: ['context-engine://plans/{planId}'],
    },
  },
  'refine-plan': {
    title: 'Refine Plan',
    usageHint: 'Generate a refinement request for an existing plan JSON payload.',
    examples: ['Refine a plan after architecture review feedback.'],
    safetyHints: ['Prompt-only helper; it does not modify stored plans directly.'],
    related: {
      tools: ['refine_plan', 'view_history'],
      resources: ['context-engine://plans/{planId}', 'context-engine://plan-history/{planId}'],
    },
  },
  'review-diff': {
    title: 'Review Diff',
    usageHint: 'Generate a repo-aligned code-review request for a unified diff.',
    examples: ['Prepare a review request focused on security and correctness.'],
    safetyHints: ['Prompt-only helper; it does not run the review tools by itself.'],
    related: {
      tools: ['review_changes', 'review_diff', 'review_auto'],
    },
  },
  'enhance-request': {
    title: 'Enhance Request',
    usageHint: 'Generate a repo-grounded prompt-enhancement request with optional scope and external references.',
    examples: ['Enhance a vague feature request before planning it.'],
    safetyHints: ['Prompt-only helper; enhancement uses external references only when explicitly supplied.'],
    related: {
      tools: ['enhance_prompt', 'get_context_for_prompt', 'create_plan'],
    },
  },
};

const RESOURCE_DISCOVERABILITY: ResourceDiscoverabilityMetadata[] = [
  {
    uriPattern: 'context-engine://tool-manifest',
    title: 'Tool Manifest',
    usageHint: 'Read the server manifest and discoverability metadata from a resource URI.',
    examples: ['Open the manifest resource in an MCP client inspector.'],
    safetyHints: ['Read-only JSON resource.'],
    related: {
      tools: ['tool_manifest'],
    },
  },
  {
    uriPattern: 'context-engine://plans/{planId}',
    title: 'Saved Plan',
    usageHint: 'Read a persisted plan as JSON through the MCP resources surface.',
    examples: ['Inspect a saved plan in a client without calling load_plan directly.'],
    safetyHints: ['Read-only JSON resource for an existing saved plan.'],
    related: {
      tools: ['load_plan', 'save_plan', 'create_plan'],
      prompts: ['create-plan', 'refine-plan'],
    },
  },
  {
    uriPattern: 'context-engine://plan-history/{planId}',
    title: 'Plan History',
    usageHint: 'Read a saved plan history as JSON through the MCP resources surface.',
    examples: ['Compare revisions of a saved plan in an MCP client.'],
    safetyHints: ['Read-only JSON resource for an existing plan history.'],
    related: {
      tools: ['view_history', 'compare_plan_versions', 'rollback_plan'],
      prompts: ['refine-plan'],
    },
  },
];

export function getToolDiscoverabilityMetadata(name: string): ToolDiscoverabilityMetadata | undefined {
  const metadata = TOOL_DISCOVERABILITY[name];
  if (!metadata) {
    return undefined;
  }

  return {
    title: metadata.title,
    ...(metadata.usageHint ? { usageHint: metadata.usageHint } : {}),
    ...(metadata.examples ? { examples: [...metadata.examples] } : {}),
    ...(metadata.safetyHints ? { safetyHints: [...metadata.safetyHints] } : {}),
    ...(metadata.related ? { related: cloneRelated(metadata.related) } : {}),
    ...(metadata.annotations ? { annotations: { ...metadata.annotations } } : {}),
  };
}

export function getPromptDiscoverabilityMetadata(name: string): PromptDiscoverabilityMetadata | undefined {
  const metadata = PROMPT_DISCOVERABILITY[name];
  if (!metadata) {
    return undefined;
  }

  return {
    title: metadata.title,
    ...(metadata.usageHint ? { usageHint: metadata.usageHint } : {}),
    ...(metadata.examples ? { examples: [...metadata.examples] } : {}),
    ...(metadata.safetyHints ? { safetyHints: [...metadata.safetyHints] } : {}),
    ...(metadata.related ? { related: cloneRelated(metadata.related) } : {}),
  };
}

export function getResourceDiscoverabilityMetadata(uri: string): ResourceDiscoverabilityMetadata | undefined {
  for (const metadata of RESOURCE_DISCOVERABILITY) {
    if (metadata.uriPattern === uri) {
      return {
        uriPattern: metadata.uriPattern,
        title: metadata.title,
        ...(metadata.usageHint ? { usageHint: metadata.usageHint } : {}),
        ...(metadata.examples ? { examples: [...metadata.examples] } : {}),
        ...(metadata.safetyHints ? { safetyHints: [...metadata.safetyHints] } : {}),
        ...(metadata.related ? { related: cloneRelated(metadata.related) } : {}),
      };
    }

    if (metadata.uriPattern.includes('{planId}')) {
      const prefix = metadata.uriPattern.split('{planId}')[0];
      if (prefix && uri.startsWith(prefix)) {
        return {
          uriPattern: metadata.uriPattern,
          title: metadata.title,
          ...(metadata.usageHint ? { usageHint: metadata.usageHint } : {}),
          ...(metadata.examples ? { examples: [...metadata.examples] } : {}),
          ...(metadata.safetyHints ? { safetyHints: [...metadata.safetyHints] } : {}),
          ...(metadata.related ? { related: cloneRelated(metadata.related) } : {}),
        };
      }
    }
  }

  return undefined;
}

export function applyToolDiscoverability<T extends { name: string; title?: string; annotations?: ToolAnnotations }>(
  tool: T
): T {
  const metadata = getToolDiscoverabilityMetadata(tool.name);
  if (!metadata) {
    return tool;
  }

  return {
    ...tool,
    title: metadata.title,
    annotations: {
      ...(tool.annotations ?? {}),
      ...(metadata.annotations ?? {}),
    },
  };
}

export function applyPromptDiscoverability<T extends Prompt>(prompt: T): T {
  const metadata = getPromptDiscoverabilityMetadata(prompt.name);
  if (!metadata) {
    return prompt;
  }

  return {
    ...prompt,
    title: metadata.title,
  };
}

export function applyResourceDiscoverability<T extends Resource>(resource: T): T {
  const metadata = getResourceDiscoverabilityMetadata(resource.uri);
  if (!metadata) {
    return resource;
  }

  return {
    ...resource,
    title: metadata.title,
  };
}

export function buildManifestDiscoverability() {
  return {
    tools: Object.entries(TOOL_DISCOVERABILITY).map(([name, metadata]) => toManifestEntry(name, metadata)),
    prompts: Object.entries(PROMPT_DISCOVERABILITY).map(([name, metadata]) => toManifestEntry(name, metadata)),
    resources: RESOURCE_DISCOVERABILITY.map((metadata) => ({
      ...toManifestEntry(metadata.uriPattern, metadata),
      uri_pattern: metadata.uriPattern,
    })) as ManifestResourceDiscoverabilityEntry[],
  };
}

export function getDefaultDiscoverabilityTitle(identifier: string): string {
  return titleCaseIdentifier(identifier);
}
