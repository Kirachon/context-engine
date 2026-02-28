import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  handleCreatePlan,
  handleExecutePlan,
  handleRefinePlan,
  handleVisualizePlan,
} from '../../src/mcp/tools/plan.js';
import { PlanningService } from '../../src/mcp/services/planningService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

function createContractPlan(version = 1): EnhancedPlanOutput {
  return {
    id: 'plan_contract',
    version,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    goal: 'Contract lifecycle plan',
    scope: { included: ['contract coverage'], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [{ name: 'Coverage', description: 'Expand test contracts', steps: [1, 2] }],
    nice_to_have_features: [],
    architecture: { notes: 'Simple deterministic fixture', patterns_used: ['Adapter'], diagrams: [] },
    risks: [{ issue: 'Snapshot drift', mitigation: 'Normalize dynamic fields', likelihood: 'low', impact: 'Low' }],
    milestones: [],
    steps: [
      {
        step_number: 1,
        id: 'step_1',
        title: 'Add tests',
        description: 'Add lifecycle contract tests',
        files_to_modify: [{ path: 'tests/tools/planLifecycle.contract.test.ts', change_type: 'modify', estimated_loc: 40, complexity: 'simple', reason: 'Contract coverage' }],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [],
        blocks: [2],
        can_parallel_with: [],
        priority: 'high',
        estimated_effort: '1h',
        acceptance_criteria: ['Snapshot captures stable contract output'],
      },
      {
        step_number: 2,
        id: 'step_2',
        title: 'Run checks',
        description: 'Run focused tests and tsc',
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [1],
        blocks: [],
        can_parallel_with: [],
        priority: 'medium',
        estimated_effort: '30m',
        acceptance_criteria: ['All checks pass'],
      },
    ],
    dependency_graph: {
      nodes: [{ id: 'step_1', step_number: 1 }, { id: 'step_2', step_number: 2 }],
      edges: [{ from: 'step_1', to: 'step_2', type: 'blocks' }],
      critical_path: [1, 2],
      parallel_groups: [],
      execution_order: [1, 2],
    },
    testing_strategy: { unit: 'Jest contract tests', integration: 'N/A', coverage_target: '80%' },
    acceptance_criteria: [{ description: 'Contracts remain stable', verification: 'Snapshot assertions' }],
    confidence_score: 0.85,
    questions_for_clarification: [],
    context_files: ['tests/tools/planLifecycle.contract.test.ts'],
    codebase_insights: ['Lifecycle outputs include markdown + JSON sections'],
  };
}

function normalizeLifecycleText(output: string): string {
  return output
    .replace(/Generated in:\s*\d+ms/g, 'Generated in: <duration>')
    .replace(/Duration:\s*\d+ms/g, 'Duration: <duration>')
    .replace(/"duration_ms":\s*\d+/g, '"duration_ms": 0');
}

describe('plan lifecycle contract snapshots', () => {
  const mockServiceClient = {
    getWorkspacePath: () => process.cwd(),
    getContextForPrompt: jest.fn(),
    searchAndAsk: jest.fn(),
  } as any;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('captures create/refine/visualize/execute external output contracts', async () => {
    const basePlan = createContractPlan(1);
    const refinedPlan = { ...createContractPlan(2), updated_at: '2025-01-02T00:00:00.000Z' };

    jest.spyOn(PlanningService.prototype, 'generatePlan').mockResolvedValue({
      success: true,
      plan: basePlan,
      status: 'ready',
      duration_ms: 12,
    });
    jest.spyOn(PlanningService.prototype, 'refinePlan').mockResolvedValue({
      success: true,
      plan: refinedPlan,
      status: 'ready',
      duration_ms: 17,
    });
    jest
      .spyOn(PlanningService.prototype, 'executeStep')
      .mockImplementation(async (_plan, stepNumber) => ({
        step_number: stepNumber,
        success: true,
        reasoning: `Executed step ${stepNumber}`,
        generated_code: [
          {
            path: `src/step-${stepNumber}.ts`,
            change_type: 'modify',
            content: `export const step${stepNumber} = true;\n`,
            explanation: 'Deterministic generated change',
          },
        ],
        duration_ms: stepNumber * 10,
      }));

    const createOutput = await handleCreatePlan(
      { task: 'Expand lifecycle contract coverage', auto_save: false },
      mockServiceClient
    );
    const refineOutput = await handleRefinePlan(
      { current_plan: JSON.stringify(basePlan), feedback: 'Refine for contract snapshots' },
      mockServiceClient
    );
    const visualizeOutput = await handleVisualizePlan(
      { plan: JSON.stringify(basePlan), diagram_type: 'dependencies' },
      mockServiceClient
    );
    const executeOutput = await handleExecutePlan(
      { plan: JSON.stringify(basePlan), mode: 'full_plan', max_steps: 2, stop_on_failure: true },
      mockServiceClient
    );

    expect({
      create_plan: normalizeLifecycleText(createOutput),
      refine_plan: normalizeLifecycleText(refineOutput),
      visualize_plan: JSON.parse(visualizeOutput),
      execute_plan: normalizeLifecycleText(executeOutput),
    }).toMatchSnapshot();
  });
});
