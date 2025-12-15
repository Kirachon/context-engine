/**
 * Layer 3: MCP Interface Layer - Planning Tools
 *
 * Exposes planning mode capabilities as MCP tools.
 * These tools enable AI-powered software planning and architecture design.
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to PlanningService layer
 * - Format plan output for optimal consumption
 *
 * Tools:
 * - create_plan: Generate a new implementation plan
 * - refine_plan: Refine an existing plan based on feedback
 * - visualize_plan: Generate diagrams from a plan
 */

import { ContextServiceClient } from '../serviceClient.js';
import { PlanningService } from '../services/planningService.js';
import {
  EnhancedPlanOutput,
  PlanGenerationOptions,
  PlanRefinementOptions,
  PlanResult,
} from '../types/planning.js';

// ============================================================================
// Tool Argument Types
// ============================================================================

export interface CreatePlanArgs {
  /** The task or goal to plan for */
  task: string;
  /** Maximum files to include in context (default: 10) */
  max_context_files?: number;
  /** Token budget for context retrieval (default: 12000) */
  context_token_budget?: number;
  /** Generate architecture diagrams (default: true) */
  generate_diagrams?: boolean;
  /** Focus on MVP only (default: false) */
  mvp_only?: boolean;
}

export interface RefinePlanArgs {
  /** The current plan (JSON string) */
  current_plan: string;
  /** User feedback on the current plan */
  feedback?: string;
  /** Clarification answers as JSON object */
  clarifications?: string;
  /** Specific step numbers to focus on */
  focus_steps?: number[];
}

export interface VisualizePlanArgs {
  /** The plan to visualize (JSON string) */
  plan: string;
  /** Type of diagram: 'dependencies', 'architecture', 'gantt' */
  diagram_type?: 'dependencies' | 'architecture' | 'gantt';
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Handle the create_plan tool call
 */
export async function handleCreatePlan(
  args: CreatePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { task, max_context_files, context_token_budget, generate_diagrams, mvp_only } = args;

  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    throw new Error('Task is required and must be a non-empty string');
  }

  const planningService = new PlanningService(serviceClient);

  const options: PlanGenerationOptions = {
    max_context_files,
    context_token_budget,
    generate_diagrams,
    mvp_only,
  };

  console.error(`[create_plan] Generating plan for: "${task.substring(0, 100)}..."`);

  const result = await planningService.generatePlan(task, options);

  if (!result.success) {
    throw new Error(`Failed to generate plan: ${result.error}`);
  }

  // Format the result for output
  return formatPlanResult(result);
}

/**
 * Handle the refine_plan tool call
 */
export async function handleRefinePlan(
  args: RefinePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { current_plan, feedback, clarifications, focus_steps } = args;

  if (!current_plan || typeof current_plan !== 'string') {
    throw new Error('current_plan is required and must be a valid JSON string');
  }

  let plan: EnhancedPlanOutput;
  try {
    plan = JSON.parse(current_plan);
  } catch {
    throw new Error('current_plan must be valid JSON');
  }

  let parsedClarifications: Record<string, string> | undefined;
  if (clarifications) {
    try {
      parsedClarifications = JSON.parse(clarifications);
    } catch {
      throw new Error('clarifications must be valid JSON');
    }
  }

  const planningService = new PlanningService(serviceClient);

  const options: PlanRefinementOptions = {
    feedback,
    clarifications: parsedClarifications,
    focus_steps,
  };

  console.error(`[refine_plan] Refining plan v${plan.version}`);

  const result = await planningService.refinePlan(plan, options);

  if (!result.success) {
    throw new Error(`Failed to refine plan: ${result.error}`);
  }

  return formatPlanResult(result);
}

/**
 * Handle the visualize_plan tool call
 */
export async function handleVisualizePlan(
  args: VisualizePlanArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { plan: planJson, diagram_type = 'dependencies' } = args;

  if (!planJson || typeof planJson !== 'string') {
    throw new Error('plan is required and must be a valid JSON string');
  }

  let plan: EnhancedPlanOutput;
  try {
    plan = JSON.parse(planJson);
  } catch {
    throw new Error('plan must be valid JSON');
  }

  const planningService = new PlanningService(serviceClient);

  let mermaid: string;

  switch (diagram_type) {
    case 'dependencies':
      mermaid = planningService.generateDependencyDiagram(plan);
      break;
    case 'architecture':
      // Find architecture diagram from plan or generate placeholder
      const archDiagram = plan.architecture.diagrams.find(d => d.type === 'architecture');
      mermaid = archDiagram?.mermaid || 'graph TD\n    A[No architecture diagram available]';
      break;
    case 'gantt':
      mermaid = generateGanttDiagram(plan);
      break;
    default:
      mermaid = planningService.generateDependencyDiagram(plan);
  }

  return JSON.stringify({
    diagram_type,
    mermaid,
    plan_id: plan.id,
    plan_version: plan.version,
  }, null, 2);
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format a plan result for output
 */
function formatPlanResult(result: PlanResult): string {
  if (!result.plan) {
    return JSON.stringify({
      success: result.success,
      status: result.status,
      error: result.error,
      duration_ms: result.duration_ms,
    }, null, 2);
  }

  const plan = result.plan;

  // Build a formatted output with both summary and full JSON
  let output = `# Implementation Plan\n\n`;
  output += `**ID:** ${plan.id}\n`;
  output += `**Version:** ${plan.version}\n`;
  output += `**Status:** ${result.status}\n`;
  output += `**Confidence:** ${(plan.confidence_score * 100).toFixed(0)}%\n`;
  output += `**Generated in:** ${result.duration_ms}ms\n\n`;

  output += `## Goal\n${plan.goal}\n\n`;

  // Scope
  if (plan.scope.included.length > 0) {
    output += `## Scope\n`;
    output += `### Included\n`;
    for (const item of plan.scope.included) {
      output += `- ${item}\n`;
    }
    if (plan.scope.excluded.length > 0) {
      output += `### Excluded\n`;
      for (const item of plan.scope.excluded) {
        output += `- ${item}\n`;
      }
    }
    output += '\n';
  }

  // Steps summary
  output += `## Steps (${plan.steps.length} total)\n\n`;
  for (const step of plan.steps) {
    const priority = step.priority === 'critical' ? '🔴' :
                     step.priority === 'high' ? '🟠' :
                     step.priority === 'medium' ? '🟡' : '🟢';
    output += `### ${step.step_number}. ${step.title} ${priority}\n`;
    output += `${step.description}\n`;
    if (step.files_to_modify.length > 0) {
      output += `- **Modify:** ${step.files_to_modify.map(f => f.path).join(', ')}\n`;
    }
    if (step.files_to_create.length > 0) {
      output += `- **Create:** ${step.files_to_create.map(f => f.path).join(', ')}\n`;
    }
    if (step.depends_on.length > 0) {
      output += `- **Depends on:** Step(s) ${step.depends_on.join(', ')}\n`;
    }
    output += `- **Effort:** ${step.estimated_effort}\n\n`;
  }

  // Parallel execution opportunities
  if (plan.dependency_graph.parallel_groups.length > 0) {
    output += `## Parallel Execution Opportunities\n`;
    for (const group of plan.dependency_graph.parallel_groups) {
      output += `- Steps ${group.join(', ')} can run in parallel\n`;
    }
    output += '\n';
  }

  // Critical path
  if (plan.dependency_graph.critical_path.length > 0) {
    output += `## Critical Path\n`;
    output += `Steps ${plan.dependency_graph.critical_path.join(' → ')}\n\n`;
  }

  // Risks
  if (plan.risks.length > 0) {
    output += `## Risks\n`;
    for (const risk of plan.risks) {
      const likelihood = risk.likelihood === 'high' ? '🔴' :
                         risk.likelihood === 'medium' ? '🟠' : '🟢';
      output += `- ${likelihood} **${risk.issue}**\n`;
      output += `  - Mitigation: ${risk.mitigation}\n`;
    }
    output += '\n';
  }

  // Questions needing clarification
  if (plan.questions_for_clarification.length > 0) {
    output += `## ⚠️ Questions Needing Clarification\n`;
    for (const q of plan.questions_for_clarification) {
      output += `- ${q}\n`;
    }
    output += '\n';
  }

  // Full JSON at the end for programmatic use
  output += `---\n\n`;
  output += `<details>\n<summary>Full Plan JSON</summary>\n\n`;
  output += '```json\n';
  output += JSON.stringify(plan, null, 2);
  output += '\n```\n</details>\n';

  return output;
}

/**
 * Generate a Gantt diagram from a plan
 */
function generateGanttDiagram(plan: EnhancedPlanOutput): string {
  let mermaid = 'gantt\n';
  mermaid += '    title Implementation Plan\n';
  mermaid += '    dateFormat YYYY-MM-DD\n';
  mermaid += '    excludes weekends\n\n';

  // Safely handle undefined arrays
  const milestones = plan.milestones || [];
  const steps = plan.steps || [];

  // Helper to get safe title
  const getSafeTitle = (step: EnhancedPlanOutput['steps'][0]): string => {
    const title = step.title || `Step ${step.step_number || 'unknown'}`;
    return title.substring(0, 20);
  };

  // Group by milestones if available
  if (milestones.length > 0) {
    for (const milestone of milestones) {
      const milestoneName = milestone.name || 'Milestone';
      mermaid += `    section ${milestoneName}\n`;
      const stepsIncluded = milestone.steps_included || [];
      for (const stepNum of stepsIncluded) {
        const step = steps.find(s => s.step_number === stepNum);
        if (step) {
          const dependsOn = step.depends_on || [];
          const deps = dependsOn.length > 0
            ? `after step${dependsOn[0]}`
            : '';
          mermaid += `    ${getSafeTitle(step)} :step${step.step_number}, ${deps || 'a1'}, 1d\n`;
        }
      }
    }
  } else {
    mermaid += '    section All Steps\n';
    for (const step of steps) {
      const dependsOn = step.depends_on || [];
      const deps = dependsOn.length > 0
        ? `after step${dependsOn[0]}`
        : '';
      mermaid += `    ${getSafeTitle(step)} :step${step.step_number}, ${deps || 'a1'}, 1d\n`;
    }
  }

  return mermaid;
}

// ============================================================================
// Tool Schema Definitions
// ============================================================================

/**
 * Tool schema for create_plan
 */
export const createPlanTool = {
  name: 'create_plan',
  description: `Generate a detailed implementation plan for a software development task.

This tool enters Planning Mode, where it:
1. Analyzes the codebase context relevant to your task
2. Generates a structured, actionable implementation plan
3. Identifies dependencies, risks, and parallelization opportunities
4. Creates architecture diagrams when helpful

**When to use this tool:**
- Before starting a complex feature or refactoring task
- When you need to understand the scope and approach
- To identify potential risks and dependencies upfront
- When coordinating work that touches multiple files

**What you get:**
- Clear goal with scope boundaries
- MVP vs nice-to-have feature breakdown
- Step-by-step implementation guide
- Dependency graph showing what can run in parallel
- Risk assessment with mitigations
- Testing strategy recommendations
- Confidence score and clarifying questions

The plan output includes both a human-readable summary and full JSON for programmatic use.`,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task or goal to plan for. Be specific about what you want to accomplish.',
      },
      max_context_files: {
        type: 'number',
        description: 'Maximum number of files to include in context analysis (default: 10)',
        default: 10,
      },
      context_token_budget: {
        type: 'number',
        description: 'Token budget for context retrieval (default: 12000)',
        default: 12000,
      },
      generate_diagrams: {
        type: 'boolean',
        description: 'Generate architecture diagrams in the plan (default: true)',
        default: true,
      },
      mvp_only: {
        type: 'boolean',
        description: 'Focus on MVP features only, excluding nice-to-have (default: false)',
        default: false,
      },
    },
    required: ['task'],
  },
};

/**
 * Tool schema for refine_plan
 */
export const refinePlanTool = {
  name: 'refine_plan',
  description: `Refine an existing implementation plan based on feedback or clarifications.

Use this tool to iterate on a plan after reviewing it or answering clarifying questions.

**When to use this tool:**
- After reviewing a plan and wanting adjustments
- To answer questions the plan raised
- To add more detail to specific steps
- To change the approach based on new information

**Input:**
- The current plan (JSON from a previous create_plan call)
- Your feedback or clarifications
- Optionally, specific steps to focus on`,
  inputSchema: {
    type: 'object',
    properties: {
      current_plan: {
        type: 'string',
        description: 'The current plan as a JSON string (from the Full Plan JSON output of create_plan)',
      },
      feedback: {
        type: 'string',
        description: 'Your feedback on the current plan - what to change, add, or remove',
      },
      clarifications: {
        type: 'string',
        description: 'Answers to clarifying questions as JSON object (e.g., {"question1": "answer1"})',
      },
      focus_steps: {
        type: 'array',
        items: { type: 'number' },
        description: 'Specific step numbers to focus refinement on',
      },
    },
    required: ['current_plan'],
  },
};

/**
 * Tool schema for visualize_plan
 */
export const visualizePlanTool = {
  name: 'visualize_plan',
  description: `Generate diagrams from an implementation plan.

Use this to visualize the plan's structure in different ways.

**Diagram types:**
- dependencies: Shows step dependencies as a DAG (who blocks whom)
- architecture: Shows the architecture diagram if one was generated
- gantt: Shows steps as a Gantt chart timeline

Returns Mermaid diagram code that can be rendered.`,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The plan as a JSON string',
      },
      diagram_type: {
        type: 'string',
        enum: ['dependencies', 'architecture', 'gantt'],
        description: 'Type of diagram to generate (default: dependencies)',
        default: 'dependencies',
      },
    },
    required: ['plan'],
  },
};

