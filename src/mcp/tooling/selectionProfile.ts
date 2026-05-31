type SelectionProfileMetadata = {
  title: string;
  usageHint?: string;
  examples?: string[];
  safetyHints?: string[];
  annotations?: {
    readOnlyHint?: boolean;
  };
  sharedContract?: {
    latency_class: string;
    index_requirement: string;
    graph_requirement: string;
    git_requirement: string;
    provenance_availability: string;
    explainability_fields?: string[];
  };
};

export type ToolIntentTag =
  | 'index'
  | 'search'
  | 'context'
  | 'symbol'
  | 'file'
  | 'enhancement'
  | 'manifest'
  | 'memory'
  | 'planning'
  | 'approval'
  | 'execution_tracking'
  | 'review'
  | 'static_analysis'
  | 'security'
  | 'resource'
  | 'diagnostics';

export type ToolOperationRisk =
  | 'read_only'
  | 'writes_workspace_state'
  | 'destructive'
  | 'runs_local_process'
  | 'uses_git_state'
  | 'uses_external_sources'
  | 'may_send_to_llm'
  | 'secret_exposure_risk';

export type ToolSelectionProfile = {
  schema_version: 1;
  intent_tags: ToolIntentTag[];
  preferred_when: string[];
  avoid_when: string[];
  selection_signals: string[];
  operation_risk: ToolOperationRisk[];
};

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function buildIntentTags(id: string): ToolIntentTag[] {
  const tags: ToolIntentTag[] = [];
  if (id.includes('index')) tags.push('index');
  if (id.includes('search') || id === 'codebase_retrieval') tags.push('search');
  if (id.includes('context') || id === 'why_this_context') tags.push('context');
  if (id.includes('symbol') || id.includes('call') || id === 'find_callers' || id === 'find_callees') tags.push('symbol');
  if (id.includes('file')) tags.push('file');
  if (id.includes('enhance')) tags.push('enhancement');
  if (id.includes('manifest')) tags.push('manifest');
  if (id.includes('memor')) tags.push('memory');
  if (id.includes('plan') || id.includes('approval')) tags.push('planning');
  if (id.includes('approval')) tags.push('approval');
  if (id.includes('step') || id.includes('progress') || id.includes('history')) tags.push('execution_tracking');
  if (id.includes('review') || id.includes('diff')) tags.push('review');
  if (id.includes('static') || id.includes('invariant')) tags.push('static_analysis');
  if (id.includes('secret') || id.includes('validate')) tags.push('security');
  if (id.includes('status') || id.includes('telemetry') || id.includes('compare')) tags.push('diagnostics');
  return uniqueSorted(tags.length > 0 ? tags : ['diagnostics']);
}

function buildOperationRisk(id: string, metadata: SelectionProfileMetadata): ToolOperationRisk[] {
  const risks: ToolOperationRisk[] = [];
  if (metadata.annotations?.readOnlyHint) risks.push('read_only');
  if (
    id === 'index_workspace' ||
    id === 'reindex_workspace' ||
    id === 'add_memory' ||
    id === 'save_plan' ||
    id === 'request_approval' ||
    id === 'respond_approval' ||
    id === 'start_step' ||
    id === 'complete_step' ||
    id === 'fail_step' ||
    id === 'execute_plan' ||
    id === 'reactive_review_pr' ||
    id === 'pause_review' ||
    id === 'resume_review'
  ) {
    risks.push('writes_workspace_state');
  }
  if (id === 'clear_index' || id === 'delete_plan' || id === 'rollback_plan') risks.push('destructive');
  if (id === 'run_static_analysis') risks.push('runs_local_process');
  if (id === 'review_git_diff' || id === 'review_auto') risks.push('uses_git_state');
  if (id === 'enhance_prompt' || id === 'get_context_for_prompt') risks.push('uses_external_sources');
  if (id === 'enhance_prompt' || id === 'create_plan' || id === 'refine_plan' || id === 'execute_plan' || id.includes('review')) {
    risks.push('may_send_to_llm');
  }
  if (id === 'get_file' || id.includes('search') || id.includes('context') || id.includes('memory') || id === 'scrub_secrets') {
    risks.push('secret_exposure_risk');
  }
  return uniqueSorted(risks.length > 0 ? risks : ['read_only']);
}

function buildSelectionSignals(metadata: SelectionProfileMetadata): string[] {
  const signals = [
    metadata.sharedContract ? `latency:${metadata.sharedContract.latency_class}` : undefined,
    metadata.sharedContract ? `index:${metadata.sharedContract.index_requirement}` : undefined,
    metadata.sharedContract ? `graph:${metadata.sharedContract.graph_requirement}` : undefined,
    metadata.sharedContract ? `git:${metadata.sharedContract.git_requirement}` : undefined,
    metadata.sharedContract ? `provenance:${metadata.sharedContract.provenance_availability}` : undefined,
    ...(metadata.sharedContract?.explainability_fields ?? []).map((field) => `explainability:${field}`),
  ].filter((value): value is string => Boolean(value));
  return uniqueSorted(signals.length > 0 ? signals : ['metadata:title_usage_examples']);
}

export function buildSelectionProfile(id: string, metadata: SelectionProfileMetadata): ToolSelectionProfile {
  return {
    schema_version: 1,
    intent_tags: buildIntentTags(id),
    preferred_when: [
      metadata.usageHint ?? `Use ${metadata.title} for its documented MCP workflow.`,
      ...(metadata.examples ?? []).slice(0, 2),
    ],
    avoid_when: metadata.safetyHints ?? [],
    selection_signals: buildSelectionSignals(metadata),
    operation_risk: buildOperationRisk(id, metadata),
  };
}
