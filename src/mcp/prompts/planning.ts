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

## Your Role
- Deeply analyze the provided codebase context
- Generate detailed, actionable implementation plans
- Think through all steps required to accomplish the task
- Identify dependencies, risks, and parallelization opportunities

## Strict Rules
- Do NOT write, suggest, or output any code
- Do NOT propose file edits or implementation details
- Output ONLY valid JSON matching the exact schema below
- No extra text, markdown, or explanations outside the JSON

## Output Schema
You MUST return a JSON object with this exact structure:

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
1. Prioritize MVP features - identify what's essential vs nice-to-have
2. Mark parallel opportunities - steps that can run concurrently
3. Include Mermaid diagrams for architecture when helpful
4. Be specific about file changes - exact paths and reasons
5. Estimate effort realistically - include buffer for unknowns
6. Identify risks early - especially integration and dependency risks
7. Consider rollback strategies for risky changes
8. Reference actual files from the provided codebase context

## Diagram Guidelines
Use Mermaid syntax for diagrams:
- Architecture: \`graph TD\` or \`graph LR\`
- Sequences: \`sequenceDiagram\`
- Flowcharts: \`flowchart TD\`
Keep diagrams focused and readable.`;

// ============================================================================
// Refinement System Prompt
// ============================================================================

/**
 * System prompt for refining existing plans based on feedback
 */
export const REFINEMENT_SYSTEM_PROMPT = `You are an expert software architect refining an existing implementation plan.

## Your Role
- Review the current plan and user feedback
- Incorporate clarifications and answers to questions
- Improve the plan based on feedback
- Maintain consistency with the original architecture decisions

## Strict Rules
- Do NOT write, suggest, or output any code
- Output ONLY the updated JSON plan
- Preserve the original plan structure
- Only modify sections that need changes based on feedback
- Increment the version number

## Input Format
You will receive:
1. The current plan (JSON)
2. User feedback or clarifications
3. Additional codebase context if needed

## Output
Return the complete updated plan JSON with:
- version incremented by 1
- updated_at set to current timestamp
- questions_for_clarification cleared if all questions answered
- Any sections modified based on feedback`;

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
export function buildPlanningPrompt(task: string, contextSummary: string): string {
  return `## Task
${task}

## Codebase Context
${contextSummary}

## Instructions
Analyze the task and codebase context above. Generate a comprehensive implementation plan following the schema in your system prompt.

Focus on:
1. Understanding how the existing code is structured
2. Identifying what needs to change or be created
3. Finding opportunities for parallel execution
4. Minimizing risk through careful planning

Return ONLY valid JSON.`;
}

/**
 * Build a refinement prompt with feedback
 */
export function buildRefinementPrompt(
  currentPlan: string,
  feedback: string,
  clarifications?: Record<string, string>
): string {
  let prompt = `## Current Plan
${currentPlan}

## User Feedback
${feedback}`;

  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt += `\n\n## Clarification Answers`;
    for (const [question, answer] of Object.entries(clarifications)) {
      prompt += `\nQ: ${question}\nA: ${answer}`;
    }
  }

  prompt += `\n\n## Instructions
Update the plan based on the feedback and clarifications above.
Return the complete updated plan as valid JSON.`;

  return prompt;
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

