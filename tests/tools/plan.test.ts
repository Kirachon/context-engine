/**
 * Unit tests for Planning MCP Tools
 *
 * Tests the Layer 3 - MCP Interface for planning tools.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleCreatePlan,
  handleRefinePlan,
  handleVisualizePlan,
  createPlanTool,
  refinePlanTool,
  visualizePlanTool,
} from '../../src/mcp/tools/plan.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

describe('Planning MCP Tools', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      getContextForPrompt: jest.fn(),
      searchAndAsk: jest.fn(),
    };
  });

  describe('create_plan Tool', () => {
    describe('Input Validation', () => {
      it('should reject empty task', async () => {
        await expect(
          handleCreatePlan({ task: '' }, mockServiceClient)
        ).rejects.toThrow(/task is required/i);
      });

      it('should reject null task', async () => {
        await expect(
          handleCreatePlan({ task: null as any }, mockServiceClient)
        ).rejects.toThrow(/task is required/i);
      });

      it('should reject undefined task', async () => {
        await expect(
          handleCreatePlan({ task: undefined as any }, mockServiceClient)
        ).rejects.toThrow(/task is required/i);
      });

      it('should reject whitespace-only task', async () => {
        await expect(
          handleCreatePlan({ task: '   ' }, mockServiceClient)
        ).rejects.toThrow(/task is required/i);
      });
    });

    describe('Tool Schema', () => {
      it('should have correct name', () => {
        expect(createPlanTool.name).toBe('create_plan');
      });

      it('should have description', () => {
        expect(createPlanTool.description).toBeDefined();
        expect(createPlanTool.description.length).toBeGreaterThan(50);
      });

      it('should require task parameter', () => {
        expect(createPlanTool.inputSchema.required).toContain('task');
      });

      it('should define optional parameters', () => {
        const props = createPlanTool.inputSchema.properties;
        expect(props.max_context_files).toBeDefined();
        expect(props.generate_diagrams).toBeDefined();
        expect(props.mvp_only).toBeDefined();
      });
    });
  });

  describe('refine_plan Tool', () => {
    describe('Input Validation', () => {
      it('should reject missing current_plan', async () => {
        await expect(
          handleRefinePlan({ current_plan: '' }, mockServiceClient)
        ).rejects.toThrow(/current_plan is required/i);
      });

      it('should reject invalid JSON in current_plan', async () => {
        await expect(
          handleRefinePlan({ current_plan: 'not json' }, mockServiceClient)
        ).rejects.toThrow(/valid JSON/i);
      });

      it('should reject invalid JSON in clarifications', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1 });
        await expect(
          handleRefinePlan(
            { current_plan: validPlan, clarifications: 'not json' },
            mockServiceClient
          )
        ).rejects.toThrow(/valid JSON/i);
      });
    });

    describe('Tool Schema', () => {
      it('should have correct name', () => {
        expect(refinePlanTool.name).toBe('refine_plan');
      });

      it('should require current_plan parameter', () => {
        expect(refinePlanTool.inputSchema.required).toContain('current_plan');
      });
    });
  });

  describe('visualize_plan Tool', () => {
    const createMockPlan = (): EnhancedPlanOutput => ({
      id: 'plan_test',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      goal: 'Test plan',
      scope: { included: [], excluded: [], assumptions: [], constraints: [] },
      mvp_features: [],
      nice_to_have_features: [],
      architecture: { notes: '', patterns_used: [], diagrams: [] },
      risks: [],
      milestones: [],
      steps: [
        {
          step_number: 1, id: 'step_1', title: 'Step 1',
          description: 'First step', files_to_modify: [], files_to_create: [],
          files_to_delete: [], depends_on: [], blocks: [2], can_parallel_with: [],
          priority: 'high', estimated_effort: '1h', acceptance_criteria: []
        },
        {
          step_number: 2, id: 'step_2', title: 'Step 2',
          description: 'Second step', files_to_modify: [], files_to_create: [],
          files_to_delete: [], depends_on: [1], blocks: [], can_parallel_with: [],
          priority: 'medium', estimated_effort: '1h', acceptance_criteria: []
        }
      ],
      dependency_graph: {
        nodes: [{ id: 'step_1', step_number: 1 }, { id: 'step_2', step_number: 2 }],
        edges: [{ from: 'step_1', to: 'step_2', type: 'blocks' }],
        critical_path: [1, 2],
        parallel_groups: [],
        execution_order: [1, 2]
      },
      testing_strategy: { unit: '', integration: '', coverage_target: '80%' },
      acceptance_criteria: [],
      confidence_score: 0.8,
      questions_for_clarification: [],
      context_files: [],
      codebase_insights: []
    });

    it('should generate dependency diagram', async () => {
      const plan = createMockPlan();
      const result = await handleVisualizePlan(
        { plan: JSON.stringify(plan), diagram_type: 'dependencies' },
        mockServiceClient
      );

      const parsed = JSON.parse(result);
      expect(parsed.diagram_type).toBe('dependencies');
      expect(parsed.mermaid).toContain('graph TD');
      expect(parsed.mermaid).toContain('step_1');
      expect(parsed.mermaid).toContain('step_2');
    });

    it('should generate gantt diagram', async () => {
      const plan = createMockPlan();
      const result = await handleVisualizePlan(
        { plan: JSON.stringify(plan), diagram_type: 'gantt' },
        mockServiceClient
      );

      const parsed = JSON.parse(result);
      expect(parsed.diagram_type).toBe('gantt');
      expect(parsed.mermaid).toContain('gantt');
    });

    describe('Tool Schema', () => {
      it('should have correct name', () => {
        expect(visualizePlanTool.name).toBe('visualize_plan');
      });

      it('should require plan parameter', () => {
        expect(visualizePlanTool.inputSchema.required).toContain('plan');
      });

      it('should define diagram_type enum', () => {
        const diagramType = visualizePlanTool.inputSchema.properties.diagram_type;
        expect(diagramType.enum).toContain('dependencies');
        expect(diagramType.enum).toContain('architecture');
        expect(diagramType.enum).toContain('gantt');
      });
    });
  });
});

