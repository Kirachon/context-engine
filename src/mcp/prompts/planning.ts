/**
 * Planning Mode System Prompts
 *
 * System prompts for AI-powered software planning and architecture design.
 * These prompts guide the LLM to generate structured, actionable plans
 * that follow best practices for software development.
 */

// ============================================================================
// Main Planning System Prompt
// ============================================================================

/**
 * System prompt for generating implementation plans
 */
export const PLANNING_SYSTEM_PROMPT = `You are an expert software architect in strict Planning Mode.

Analyze the provided codebase context and return ONLY valid JSON matching the exact schema below.
Do not write code, suggest file edits, or add any text outside the JSON.

Focus on:
- clear scope boundaries
- essential MVP steps first
- dependencies, risks, and parallel work
- concrete validation

Required JSON shape:

{
  "goal": "Clear restatement of the task with scope boundaries",
  "scope": {
    "included": ["What is explicitly in scope"],
    "excluded": ["What is explicitly out of scope"],
    "assumptions": ["Assumptions the plan relies on"],
    "constraints": ["Technical or time constraints"]
  },
  "mvp_features": [
    {"name": "Feature name", "description": "Feature description", "steps": [1, 2]}
  ],
  "nice_to_have_features": [
    {"name": "Feature name", "description": "Feature description", "steps": [5, 6]}
  ],
  "architecture": {
    "notes": "High-level design decisions and data flows",
    "patterns_used": ["Pattern names used, e.g., Repository, Factory"],
    "diagrams": [
      {"type": "architecture|sequence|flowchart", "title": "Diagram title", "mermaid": "graph TD..."}
    ]
  },
  "risks": [
    {"issue": "Risk description", "mitigation": "How to mitigate", "likelihood": "low|medium|high", "impact": "Impact if realized"}
  ],
  "milestones": [
    {"name": "Milestone name", "steps_included": [1, 2, 3], "estimated_time": "2-3 days", "deliverables": ["What's delivered"]}
  ],
  "steps": [
    {
      "step_number": 1,
      "id": "step_1",
      "title": "Short title",
      "description": "Detailed action description",
      "files_to_modify": [
        {"path": "src/file.ts", "change_type": "modify", "estimated_loc": 50, "complexity": "moderate", "reason": "Why this change"}
      ],
      "files_to_create": [
        {"path": "src/new.ts", "change_type": "create", "estimated_loc": 100, "complexity": "simple", "reason": "Purpose of new file"}
      ],
      "files_to_delete": [],
      "depends_on": [],
      "blocks": [2, 3],
      "can_parallel_with": [],
      "priority": "critical|high|medium|low",
      "estimated_effort": "2-3 hours",
      "acceptance_criteria": ["Criteria to verify step is complete"],
      "rollback_strategy": "How to undo if needed"
    }
  ],
  "testing_strategy": {
    "unit": "Unit testing approach",
    "integration": "Integration testing approach",
    "e2e": "End-to-end testing approach (optional)",
    "coverage_target": "80%",
    "test_files": ["paths to test files"]
  },
  "acceptance_criteria": [
    {"description": "Overall criterion", "verification": "How to verify"}
  ],
  "confidence_score": 0.85,
  "questions_for_clarification": ["Specific questions if anything is unclear"],
  "context_files": ["Files analyzed from the codebase"],
  "codebase_insights": ["Key findings about existing code patterns"]
}

## Best Practices
1. Start with MVP scope and concrete validation.
2. Call out parallel work, risks, and rollback early.
3. Reference actual files and exact reasons for change.
4. Keep diagrams concise and only when they help.

## Diagram Guidelines
Use Mermaid syntax for diagrams:
- Architecture: \`graph TD\` or \`graph LR\`
- Sequences: \`sequenceDiagram\`
- Flowcharts: \`flowchart TD\`
Keep diagrams focused and readable.`;

/**
 * Shorter system prompt for compact planning runs.
 * Keeps the contract and output shape requirements, but trims the guidance
 * to reduce prompt size for interactive create_plan requests.
 */
export const COMPACT_PLANNING_SYSTEM_PROMPT = `You are an expert software architect in strict Planning Mode.

Return ONLY valid JSON matching the planning schema described below.
Do not write code, suggest file edits, or add any text outside the JSON.

Keep the plan:
- minimal and MVP-first
- grounded in the repository context
- focused on concrete steps, validation, and rollback
- free of diagrams unless explicitly needed

Required JSON keys:
goal, scope, mvp_features, nice_to_have_features, architecture, risks,
milestones, steps, testing_strategy, acceptance_criteria, confidence_score,
questions_for_clarification, context_files, codebase_insights`;

export function getPlanningSystemPrompt(profile: PlanningPromptProfile = 'compact'): string {
  return profile === 'deep' ? PLANNING_SYSTEM_PROMPT : COMPACT_PLANNING_SYSTEM_PROMPT;
}

// ============================================================================
// Refinement System Prompt
// ============================================================================

/**
 * System prompt for refining existing plans based on feedback
 */
export const REFINEMENT_SYSTEM_PROMPT = `You are an expert software architect refining an existing implementation plan.

Review the current plan and user feedback, then return ONLY the updated JSON plan.
Preserve the original structure, increment the version number, and only change sections affected by the feedback.

Input:
1. The current plan JSON
2. User feedback or clarifications
3. Optional extra codebase context

Output requirements:
- version incremented by 1
- updated_at set to current timestamp
- questions_for_clarification cleared when answered
- no extra text outside the JSON`;

// ============================================================================
// Diagram Generation Prompt
// ============================================================================

/**
 * Prompt for generating specific diagram types
 */
export const DIAGRAM_GENERATION_PROMPT = `Generate a Mermaid diagram for the following:

Type: {diagram_type}
Context: {context}
Focus: {focus_area}

Output ONLY the Mermaid diagram code, no explanations.
Use clean, readable syntax with proper indentation.
Keep node labels concise (max 3-4 words).
Use consistent styling throughout.`;

// ============================================================================
// Prompt Builder Functions
// ============================================================================

/**
 * Build the initial planning prompt with task and context
 */
export function buildPlanningPrompt(
  task: string,
  contextSummary: string,
  profile: PlanningPromptProfile = 'compact'
): string {
  const prompt = [
    '## Task',
    task.trim(),
    '',
    '## Context',
    contextSummary.trim() || 'No relevant codebase context was found.',
    '',
    '## Instructions',
    'Return ONLY valid JSON that matches the planning schema in the system prompt.',
    'Keep the plan actionable, minimal, and grounded in the repository context.',
  ];

  if (profile === 'deep') {
    prompt.push(
      '',
      '## Deep Planning Guidance',
      '- Include dependencies, parallel work, rollback notes, and validation details.',
      '- Favor concrete file references and milestones when the task is complex.'
    );
  }

  return prompt.join('\n');
}

export type CreatePlanPromptArgumentName =
  | 'task'
  | 'auto_scope'
  | 'mvp_only'
  | 'max_context_files'
  | 'context_token_budget'
  | 'include_paths'
  | 'exclude_paths';

export interface CreatePlanPromptArgumentDefinition {
  name: CreatePlanPromptArgumentName;
  promptDescription: string;
  toolDescription: string;
  required?: boolean;
}

export const CREATE_PLAN_PROMPT_ARGUMENT_DEFINITIONS = [
  {
    name: 'task',
    promptDescription: 'Implementation task to plan.',
    toolDescription: 'The task or goal to plan for. Be specific about what you want to accomplish.',
    required: true,
  },
  {
    name: 'auto_scope',
    promptDescription: 'Optional boolean string (`true`/`false`) to control automatic scope inference.',
    toolDescription: 'Automatically infer likely include paths when no explicit scope is provided (default: true)',
  },
  {
    name: 'mvp_only',
    promptDescription: 'Optional boolean string (`true`/`false`).',
    toolDescription: 'Focus on MVP features only, excluding nice-to-have (default: false)',
  },
  {
    name: 'max_context_files',
    promptDescription: 'Optional integer string for context file limit.',
    toolDescription: 'Maximum number of files to include in context analysis (default: 8)',
  },
  {
    name: 'context_token_budget',
    promptDescription: 'Optional integer string for prompt context budget.',
    toolDescription: 'Token budget for context retrieval (default: 8000)',
  },
  {
    name: 'include_paths',
    promptDescription: 'Optional comma/newline-separated workspace-relative glob list.',
    toolDescription: 'Optional workspace-relative glob filters to include matching paths only.',
  },
  {
    name: 'exclude_paths',
    promptDescription: 'Optional comma/newline-separated workspace-relative glob list.',
    toolDescription: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
  },
] as const satisfies readonly CreatePlanPromptArgumentDefinition[];

export function getCreatePlanPromptArguments(): Array<{
  name: CreatePlanPromptArgumentName;
  description: string;
  required?: boolean;
}> {
  return CREATE_PLAN_PROMPT_ARGUMENT_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.promptDescription,
    ...('required' in definition ? { required: definition.required } : {}),
  }));
}

export function getCreatePlanToolFieldDescription(name: CreatePlanPromptArgumentName): string {
  const definition = CREATE_PLAN_PROMPT_ARGUMENT_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Unsupported create_plan field: ${name}`);
  }
  return definition.toolDescription;
}

export interface CreatePlanPromptRequestOptions {
  task: string;
  auto_scope?: boolean;
  mvp_only?: boolean;
  max_context_files?: number;
  context_token_budget?: number;
  include_paths?: string[];
  exclude_paths?: string[];
  profile?: PlanningPromptProfile;
}

export function buildCreatePlanPromptRequest(
  options: CreatePlanPromptRequestOptions
): string {
  const prompt = buildPlanningPrompt(
    options.task,
    'No additional codebase context was provided with this prompt request.',
    options.profile ?? 'compact'
  );

  const requestOptions: string[] = [];
  const optionalRequestOptionValues: Partial<
    Record<CreatePlanPromptArgumentName, boolean | number | string[]>
  > = {
    mvp_only: options.mvp_only,
    auto_scope: options.auto_scope,
    max_context_files: options.max_context_files,
    context_token_budget: options.context_token_budget,
    include_paths: options.include_paths,
    exclude_paths: options.exclude_paths,
  };

  for (const definition of CREATE_PLAN_PROMPT_ARGUMENT_DEFINITIONS) {
    if (definition.name === 'task') {
      continue;
    }
    const value = optionalRequestOptionValues[definition.name];
    if (typeof value === 'boolean' || typeof value === 'number') {
      requestOptions.push(`- ${definition.name}: ${value}`);
    } else if (Array.isArray(value) && value.length > 0) {
      requestOptions.push(`- ${definition.name}: ${value.join(', ')}`);
    }
  }

  if (requestOptions.length === 0) {
    return prompt;
  }

  return [
    prompt,
    '',
    '## Request Options',
    ...requestOptions,
  ].join('\n');
}

/**
 * Build a refinement prompt with feedback
 */
export function buildRefinementPrompt(
  currentPlan: string,
  feedback: string,
  clarifications?: Record<string, string>,
  profile: PlanningPromptProfile = 'compact'
): string {
  const prompt = [
    '## Current Plan',
    currentPlan.trim(),
    '',
    '## Feedback',
    feedback.trim(),
  ];

  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt.push('', '## Clarification Answers');
    for (const [question, answer] of Object.entries(clarifications)) {
      prompt.push(`- Q: ${question}`, `  A: ${answer}`);
    }
  }

  prompt.push(
    '',
    '## Instructions',
    'Update the plan to reflect the feedback and return the complete JSON plan only.'
  );

  if (profile === 'deep') {
    prompt.push(
      '',
      '## Deep Refinement Guidance',
      '- Preserve plan structure and versioning.',
      '- Re-evaluate scope, steps, and validation if the feedback changes the approach.'
    );
  }

  return prompt.join('\n');
}

export interface RefinePlanPromptRequestOptions {
  currentPlan: string;
  feedback?: string;
  clarifications?: Record<string, string>;
  profile?: PlanningPromptProfile;
}

export function buildRefinePlanPromptRequest(
  options: RefinePlanPromptRequestOptions
): string {
  const feedback =
    options.feedback?.trim() ||
    'No explicit feedback was provided. Review the current plan for consistency and apply any supplied clarifications.';

  return buildRefinementPrompt(
    options.currentPlan,
    feedback,
    options.clarifications,
    options.profile ?? 'compact'
  );
}

export const ENHANCE_REQUEST_SYSTEM_PROMPT = `You are an expert prompt enhancer preparing a coding request for the Context Engine workflow.

Turn the raw request into a sharper implementation brief that keeps the user's intent intact while making scope, codebase focus, and validation clearer.

Do not invent files, APIs, or requirements. Preserve any provided path filters and highlight them when they materially affect the work.`;

export type EnhanceRequestPromptArgumentName =
  | 'prompt'
  | 'auto_scope'
  | 'include_paths'
  | 'exclude_paths'
  | 'external_sources';

export interface EnhanceRequestPromptArgumentDefinition {
  name: EnhanceRequestPromptArgumentName;
  promptDescription: string;
  toolDescription: string;
  required?: boolean;
}

export const ENHANCE_REQUEST_PROMPT_ARGUMENT_DEFINITIONS = [
  {
    name: 'prompt',
    promptDescription: 'Raw request to sharpen.',
    toolDescription: 'The simple prompt to enhance (e.g., "fix the login bug")',
    required: true,
  },
  {
    name: 'auto_scope',
    promptDescription: 'Optional boolean string (`true`/`false`) to control automatic scope inference.',
    toolDescription: 'Automatically infer likely include paths when no explicit scope is provided (default: true)',
  },
  {
    name: 'include_paths',
    promptDescription: 'Optional comma/newline-separated workspace-relative glob list.',
    toolDescription: 'Optional workspace-relative glob filters to include matching paths only.',
  },
  {
    name: 'exclude_paths',
    promptDescription: 'Optional comma/newline-separated workspace-relative glob list.',
    toolDescription: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
  },
  {
    name: 'external_sources',
    promptDescription: 'Optional JSON string of external source objects for grounding.',
    toolDescription: 'Optional JSON array of external sources to ground the enhancement request.',
  },
] as const satisfies readonly EnhanceRequestPromptArgumentDefinition[];

export function getEnhanceRequestPromptArguments(): Array<{
  name: EnhanceRequestPromptArgumentName;
  description: string;
  required?: boolean;
}> {
  return ENHANCE_REQUEST_PROMPT_ARGUMENT_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.promptDescription,
    ...('required' in definition ? { required: definition.required } : {}),
  }));
}

export function getEnhanceRequestToolFieldDescription(name: EnhanceRequestPromptArgumentName): string {
  const definition = ENHANCE_REQUEST_PROMPT_ARGUMENT_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Unsupported enhance_prompt field: ${name}`);
  }
  return definition.toolDescription;
}

export interface EnhanceRequestPromptOptions {
  autoScope?: boolean;
  includePaths?: string[];
  excludePaths?: string[];
  externalSourcesJson?: string;
}

export function buildEnhanceRequestPrompt(
  prompt: string,
  options: EnhanceRequestPromptOptions = {}
): string {
  const sections = [
    '## Raw Request',
    prompt.trim(),
  ];

  if (typeof options.autoScope === 'boolean') {
    sections.push('', '## Auto Scope', `- ${options.autoScope}`);
  }

  if (options.includePaths && options.includePaths.length > 0) {
    sections.push('', '## Include Paths', ...options.includePaths.map((value) => `- ${value}`));
  }

  if (options.excludePaths && options.excludePaths.length > 0) {
    sections.push('', '## Exclude Paths', ...options.excludePaths.map((value) => `- ${value}`));
  }

  if (options.externalSourcesJson && options.externalSourcesJson.trim().length > 0) {
    sections.push('', '## External Sources', options.externalSourcesJson.trim());
  }

  sections.push(
    '',
    '## Instructions',
    '- Rewrite the request into a concrete implementation brief.',
    '- Keep the request grounded in the existing codebase.',
    '- Preserve any include/exclude path constraints exactly as provided.',
    '- Treat any external_sources content as additive reference material, not local codebase truth.',
    '- End with a short validation checklist.'
  );

  return sections.join('\n');
}

/**
 * Build a diagram generation prompt
 */
export function buildDiagramPrompt(
  diagramType: string,
  context: string,
  focusArea: string
): string {
  return DIAGRAM_GENERATION_PROMPT
    .replace('{diagram_type}', diagramType)
    .replace('{context}', context)
    .replace('{focus_area}', focusArea);
}

/**
 * Extract JSON from a potentially messy LLM response
 */
export function extractJsonFromResponse(response: string): string | null {
  // Try to find JSON block in markdown code fence
  const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0].trim();
  }

  return null;
}

// ============================================================================
// Step Execution System Prompt
// ============================================================================

/**
 * System prompt for executing a single plan step
 */
export const STEP_EXECUTION_SYSTEM_PROMPT = `You are an expert software developer executing one step from an implementation plan.

Generate the exact code changes needed for that step and return ONLY valid JSON.
Follow the plan architecture, keep the changes minimal, and include all required imports and dependencies.

Required output:

{
  "success": true,
  "reasoning": "Brief explanation of the approach taken",
  "changes": [
    {
      "path": "src/path/to/file.ts",
      "change_type": "create|modify|delete",
      "content": "Full file content for create, or full replacement content for modify",
      "diff": "Unified diff format for modifications (optional, supported for modify)",
      "explanation": "Why this change is needed"
    }
  ]
}

## Guidelines
1. For new files: provide complete file content
2. For modifications: provide either the complete new file content or a unified diff that applies cleanly
3. For deletions: set content to null
4. Keep explanations concise but informative
5. Ensure code compiles and follows TypeScript/JavaScript best practices
 6. Include proper error handling
  7. Add JSDoc comments for public APIs`;

export type PlanningPromptProfile = 'compact' | 'deep';

/**
 * Build the step execution prompt with step details and context
 */
export function buildStepExecutionPrompt(
  step: {
    step_number: number;
    title: string;
    description: string;
    files_to_modify: Array<{ path: string; reason: string }>;
    files_to_create: Array<{ path: string; reason: string }>;
    files_to_delete: string[];
    acceptance_criteria: string[];
  },
  planGoal: string,
  contextSummary: string,
  additionalContext?: string,
  profile: PlanningPromptProfile = 'compact'
): string {
  const prompt = [
    '## Plan Goal',
    planGoal.trim(),
    '',
    `## Step ${step.step_number}: ${step.title.trim()}`,
    step.description.trim(),
    '',
    '## Files to Modify',
    step.files_to_modify.length > 0
      ? step.files_to_modify.map((f) => `- ${f.path}: ${f.reason}`).join('\n')
      : '- None',
    '',
    '## Files to Create',
    step.files_to_create.length > 0
      ? step.files_to_create.map((f) => `- ${f.path}: ${f.reason}`).join('\n')
      : '- None',
    '',
    '## Files to Delete',
    step.files_to_delete.length > 0
      ? step.files_to_delete.map((f) => `- ${f}`).join('\n')
      : '- None',
    '',
    '## Acceptance Criteria',
    step.acceptance_criteria.length > 0
      ? step.acceptance_criteria.map((c) => `- ${c}`).join('\n')
      : '- None',
    '',
    '## Context',
    contextSummary.trim() || 'No relevant codebase context was found.',
  ];

  if (additionalContext) {
    prompt.push('', '## Additional Context', additionalContext.trim());
  }

  prompt.push(
    '',
    '## Instructions',
    'Generate the code changes needed to complete this step and return only valid JSON.'
  );

  if (profile === 'deep') {
    prompt.push(
      '',
      '## Deep Execution Guidance',
      '- Include imports, dependencies, and safety checks.',
      '- Keep the patch minimal but complete.'
    );
  }

  return prompt.join('\n');
}
