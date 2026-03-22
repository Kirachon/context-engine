/**
 * Unit tests for Planning MCP Tools
 *
 * Tests the Layer 3 - MCP Interface for planning tools.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  handleCreatePlan,
  handleRefinePlan,
  handleVisualizePlan,
  handleExecutePlan,
  createPlanTool,
  refinePlanTool,
  visualizePlanTool,
  executePlanTool,
} from '../../src/mcp/tools/plan.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';
import { PlanPersistenceService } from '../../src/mcp/services/planPersistenceService.js';
import { PlanningService } from '../../src/mcp/services/planningService.js';

describe('Planning MCP Tools', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      getContextForPrompt: jest.fn(),
      searchAndAsk: jest.fn(),
    };
  });

  function createPlanResponse(goal = 'Generated plan') {
    return JSON.stringify({
      goal,
      scope: { included: ['src/'], excluded: [], assumptions: [], constraints: [] },
      mvp_features: [],
      nice_to_have_features: [],
      architecture: { notes: 'notes', patterns_used: [], diagrams: [] },
      risks: [],
      milestones: [],
      steps: [
        {
          step_number: 1,
          id: 'step_1',
          title: 'Step 1',
          description: 'First step',
          files_to_modify: [],
          files_to_create: [],
          files_to_delete: [],
          depends_on: [],
          blocks: [],
          can_parallel_with: [],
          priority: 'medium',
          estimated_effort: '1h',
          acceptance_criteria: [],
        },
      ],
      dependency_graph: {
        nodes: [],
        edges: [],
        critical_path: [],
        parallel_groups: [],
        execution_order: [1],
      },
      testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
      acceptance_criteria: [],
      confidence_score: 0.8,
      questions_for_clarification: [],
      alternative_approaches: [],
      context_files: ['src/index.ts'],
      codebase_insights: ['insight'],
    });
  }

  function createExecutionResponse() {
    return JSON.stringify({
      success: true,
      reasoning: 'Implemented the step',
      changes: [],
    });
  }

  function extractJsonDetails(output: string): Record<string, unknown> {
    const match = output.match(/```json\n([\s\S]*?)\n```/);
    if (!match) {
      throw new Error('Expected output to include a JSON details block');
    }
    return JSON.parse(match[1]);
  }

  function createContextBundle(fileCount: number, totalTokens: number) {
    return {
      summary: 'Context summary',
      query: 'query',
      files: Array.from({ length: fileCount }, (_, index) => ({
        path: `src/file-${index + 1}.ts`,
        extension: '.ts',
        summary: `Summary for file ${index + 1}`,
        relevance: 0.8,
        tokenCount: 300,
        snippets: [
          {
            text: `export const value${index + 1} = ${index + 1};`,
            lines: '1-1',
            relevance: 0.8,
            tokenCount: 20,
            codeType: 'function',
          },
        ],
      })),
      hints: ['Use the existing service layer'],
      metadata: {
        totalFiles: fileCount,
        totalSnippets: fileCount,
        totalTokens,
        tokenBudget: totalTokens,
        truncated: false,
        searchTimeMs: 12,
      },
    };
  }

  describe('create_plan Tool', () => {
    describe('Input Validation', () => {
      it('should reject empty task', async () => {
        await expect(
          handleCreatePlan({ task: '' }, mockServiceClient)
        ).rejects.toThrow('Task is required and must be a non-empty string');
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

      it('should forward an abort signal to the planning service', async () => {
        const controller = new AbortController();
        mockServiceClient.getContextForPrompt.mockResolvedValue(createContextBundle(2, 1800));
        mockServiceClient.searchAndAsk.mockResolvedValue(createPlanResponse('Compact plan'));

      const result = await handleCreatePlan(
        { task: 'Implement a login form', auto_save: false },
        mockServiceClient,
        controller.signal
      );

      expect(result).toContain('Implementation Plan');
      expect(mockServiceClient.searchAndAsk).not.toHaveBeenCalled();
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
        ).rejects.toThrow('current_plan is required and must be a valid JSON string');
      });

      it('should reject invalid JSON in current_plan', async () => {
        await expect(
          handleRefinePlan({ current_plan: 'not json' }, mockServiceClient)
        ).rejects.toThrow('current_plan must be valid JSON');
      });

      it('should reject invalid JSON in clarifications', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1 });
        await expect(
          handleRefinePlan(
            { current_plan: validPlan, clarifications: 'not json' },
            mockServiceClient
          )
        ).rejects.toThrow('clarifications must be valid JSON');
      });

      it('should forward an abort signal to the refinement service', async () => {
        const controller = new AbortController();
        const currentPlan = JSON.stringify({
          id: 'plan_1',
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          goal: 'Refine me',
          scope: { included: [], excluded: [], assumptions: [], constraints: [] },
          mvp_features: [],
          nice_to_have_features: [],
          architecture: { notes: '', patterns_used: [], diagrams: [] },
          risks: [],
          milestones: [],
          steps: [],
          dependency_graph: { nodes: [], edges: [], critical_path: [], parallel_groups: [], execution_order: [] },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        mockServiceClient.searchAndAsk.mockResolvedValue(createPlanResponse('Refined plan'));

        const result = await handleRefinePlan(
          { current_plan: currentPlan, feedback: 'Make it shorter', clarifications: '{}' },
          mockServiceClient,
          controller.signal
        );

        expect(result).toContain('Implementation Plan');
        expect(mockServiceClient.searchAndAsk.mock.calls[0][2]).toEqual(
          expect.objectContaining({ signal: controller.signal })
        );
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
      expect(parsed._meta?.tool).toBe('visualize_plan');
      expect(typeof parsed._meta?.duration_ms).toBe('number');
    });

    it('should reject missing plan', async () => {
      await expect(
        handleVisualizePlan({ plan: '' }, mockServiceClient)
      ).rejects.toThrow('plan is required and must be a valid JSON string');
    });

    it('should reject invalid JSON in plan', async () => {
      await expect(
        handleVisualizePlan({ plan: 'not json' }, mockServiceClient)
      ).rejects.toThrow('plan must be valid JSON');
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
      expect(parsed._meta?.tool).toBe('visualize_plan');
      expect(typeof parsed._meta?.duration_ms).toBe('number');
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

  describe('execute_plan Tool', () => {
    describe('Input Validation', () => {
      it('should reject empty plan', async () => {
        await expect(
          handleExecutePlan({ plan: '' }, mockServiceClient)
        ).rejects.toThrow(/plan is required/i);
      });

      it('should reject null plan', async () => {
        await expect(
          handleExecutePlan({ plan: null as any }, mockServiceClient)
        ).rejects.toThrow(/plan is required/i);
      });

      it('should reject invalid JSON in plan', async () => {
        await expect(
          handleExecutePlan({ plan: 'not json' }, mockServiceClient)
        ).rejects.toThrow(/valid JSON/i);
      });

      it('should load plan by plan_id when JSON not provided', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-plan-'));
        const plan: EnhancedPlanOutput = {
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
          steps: [],
          dependency_graph: { nodes: [], edges: [], critical_path: [], parallel_groups: [], execution_order: [] },
          testing_strategy: { unit: '', integration: '', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.5,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        };
        const persistence = new PlanPersistenceService(tempDir);
        await persistence.savePlan(plan, { overwrite: true });

        const serviceClientWithWorkspace = {
          ...mockServiceClient,
          getWorkspacePath: () => tempDir,
        };

        const result = await handleExecutePlan(
          { plan: '', plan_id: plan.id, mode: 'full_plan' },
          serviceClientWithWorkspace
        );
        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.plan_id).toBe(plan.id);
        expect(parsed._meta?.tool).toBe('execute_plan');
        expect(parsed._meta?.status).toBe('completed');
        expect(typeof parsed._meta?.duration_ms).toBe('number');
      });

      it('should reject single_step mode without step_number', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan({ plan: validPlan, mode: 'single_step' }, mockServiceClient)
        ).rejects.toThrow(/step_number is required/i);
      });

      it('should reject non-number step_number in single_step mode', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan(
            { plan: validPlan, mode: 'single_step', step_number: '1' as unknown as number },
            mockServiceClient
          )
        ).rejects.toThrow('step_number is required when mode is "single_step"');
      });

      it('should reject invalid mode', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan(
            { plan: validPlan, mode: 'bad_mode' as any },
            mockServiceClient
          )
        ).rejects.toThrow('mode must be one of "single_step", "all_ready", or "full_plan"');
      });

      it('should reject empty plan_id when provided', async () => {
        await expect(
          handleExecutePlan({ plan: '', plan_id: '   ' }, mockServiceClient)
        ).rejects.toThrow('plan_id must be a non-empty string');
      });

      it('should reject max_steps less than 1', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan({ plan: validPlan, mode: 'all_ready', max_steps: 0 }, mockServiceClient)
        ).rejects.toThrow('max_steps must be a finite number greater than or equal to 1');
      });

      it('should reject non-finite max_steps', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan(
            { plan: validPlan, mode: 'all_ready', max_steps: Number.POSITIVE_INFINITY },
            mockServiceClient
          )
        ).rejects.toThrow('max_steps must be a finite number greater than or equal to 1');
      });

      it('should reject non-boolean apply_changes when provided', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan(
            { plan: validPlan, mode: 'all_ready', apply_changes: 'true' as any },
            mockServiceClient
          )
        ).rejects.toThrow('apply_changes must be a boolean');
      });

      it('should reject non-boolean stop_on_failure when provided', async () => {
        const validPlan = JSON.stringify({ id: 'test', version: 1, steps: [] });
        await expect(
          handleExecutePlan(
            { plan: validPlan, mode: 'all_ready', stop_on_failure: 'false' as any },
            mockServiceClient
          )
        ).rejects.toThrow('stop_on_failure must be a boolean');
      });

      it('should forward an abort signal to step execution', async () => {
        const controller = new AbortController();
        const plan = JSON.stringify({
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
              step_number: 1,
              id: 'step_1',
              title: 'Step 1',
              description: 'First step',
              files_to_modify: [],
              files_to_create: [],
              files_to_delete: [],
              depends_on: [],
              blocks: [],
              can_parallel_with: [],
              priority: 'medium',
              estimated_effort: '1h',
              acceptance_criteria: [],
            },
          ],
          dependency_graph: {
            nodes: [],
            edges: [],
            critical_path: [],
            parallel_groups: [],
            execution_order: [1],
          },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        mockServiceClient.getContextForPrompt.mockResolvedValue(createContextBundle(1, 1000));
        mockServiceClient.searchAndAsk.mockResolvedValue(createExecutionResponse());

        const result = await handleExecutePlan(
          { plan, mode: 'single_step', step_number: 1 },
          mockServiceClient,
          controller.signal
        );

        expect(result).toContain('Plan Execution Result');
        expect(mockServiceClient.searchAndAsk.mock.calls[0][2]).toEqual(
          expect.objectContaining({ signal: controller.signal })
        );
      });

      it('should apply diff-based modify changes and create a backup after validation', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-plan-diff-'));
        const workspaceFile = path.join(tempDir, 'src', 'example.ts');
        fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
        fs.writeFileSync(workspaceFile, 'export const answer = 1;\nexport const flag = false;\n', 'utf-8');

        const plan = JSON.stringify({
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
              step_number: 1,
              id: 'step_1',
              title: 'Update example',
              description: 'Modify the example file',
              files_to_modify: [{ path: 'src/example.ts', reason: 'Exercise diff application' }],
              files_to_create: [],
              files_to_delete: [],
              depends_on: [],
              blocks: [],
              can_parallel_with: [],
              priority: 'medium',
              estimated_effort: '1h',
              acceptance_criteria: [],
            },
          ],
          dependency_graph: {
            nodes: [],
            edges: [],
            critical_path: [],
            parallel_groups: [],
            execution_order: [1],
          },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        const diff = `--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
 export const answer = 1;
-export const flag = false;
+export const flag = true;`;

        const executeStepSpy = jest.spyOn(PlanningService.prototype, 'executeStep').mockResolvedValue({
          step_number: 1,
          success: true,
          reasoning: 'Applied diff-based update',
          generated_code: [
            {
              path: 'src/example.ts',
              change_type: 'modify',
              diff,
              explanation: 'Flip the example flag',
            },
          ],
          duration_ms: 12,
        } as any);

        const serviceClientWithWorkspace = {
          ...mockServiceClient,
          getWorkspacePath: () => tempDir,
        };

        try {
          const result = await handleExecutePlan(
            { plan, mode: 'single_step', step_number: 1, apply_changes: true },
            serviceClientWithWorkspace
          );
          const parsed = extractJsonDetails(result) as Record<string, unknown>;
          const backups = parsed.backups_created as string[] | undefined;

          expect(fs.readFileSync(workspaceFile, 'utf-8')).toContain('flag = true');
          expect(parsed.files_applied).toEqual(['src/example.ts']);
          expect(parsed.apply_errors).toEqual([]);
          expect(backups).toHaveLength(1);
          expect(backups?.[0]).toContain('.backup.');
          expect(fs.existsSync(backups![0])).toBe(true);
        } finally {
          executeStepSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('should preview diff-based modifications when apply_changes is false', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-plan-diff-preview-'));

        const plan = JSON.stringify({
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
              step_number: 1,
              id: 'step_1',
              title: 'Update example',
              description: 'Modify the example file',
              files_to_modify: [{ path: 'src/example.ts', reason: 'Exercise diff application' }],
              files_to_create: [],
              files_to_delete: [],
              depends_on: [],
              blocks: [],
              can_parallel_with: [],
              priority: 'medium',
              estimated_effort: '1h',
              acceptance_criteria: [],
            },
          ],
          dependency_graph: {
            nodes: [],
            edges: [],
            critical_path: [],
            parallel_groups: [],
            execution_order: [1],
          },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        const diff = `--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
 export const answer = 1;
-export const flag = false;
+export const flag = true;`;

        const executeStepSpy = jest.spyOn(PlanningService.prototype, 'executeStep').mockResolvedValue({
          step_number: 1,
          success: true,
          reasoning: 'Preview diff-only update',
          generated_code: [
            {
              path: 'src/example.ts',
              change_type: 'modify',
              diff,
              explanation: 'Flip the example flag',
            },
          ],
          duration_ms: 7,
        } as any);

        const serviceClientWithWorkspace = {
          ...mockServiceClient,
          getWorkspacePath: () => tempDir,
        };

        try {
          const result = await handleExecutePlan(
            { plan, mode: 'single_step', step_number: 1, apply_changes: false },
            serviceClientWithWorkspace
          );

          expect(result).toContain('Patch preview');
          expect(result).not.toContain('Content preview');
          expect(result).toContain('```\n--- a/src/example.ts');
        } finally {
          executeStepSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('should reject sibling-prefix paths and leave the workspace untouched', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-plan-path-'));
        const siblingWorkspace = `${tempDir}2`;
        fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

        const plan = JSON.stringify({
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
              step_number: 1,
              id: 'step_1',
              title: 'Update example',
              description: 'Modify the example file',
              files_to_modify: [{ path: `${siblingWorkspace}\\evil.ts`, reason: 'Exercise workspace fence' }],
              files_to_create: [],
              files_to_delete: [],
              depends_on: [],
              blocks: [],
              can_parallel_with: [],
              priority: 'medium',
              estimated_effort: '1h',
              acceptance_criteria: [],
            },
          ],
          dependency_graph: {
            nodes: [],
            edges: [],
            critical_path: [],
            parallel_groups: [],
            execution_order: [1],
          },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        const executeStepSpy = jest.spyOn(PlanningService.prototype, 'executeStep').mockResolvedValue({
          step_number: 1,
          success: true,
          reasoning: 'Attempted invalid write',
          generated_code: [
            {
              path: `${siblingWorkspace}\\evil.ts`,
              change_type: 'modify',
              content: 'export const evil = true;\n',
              explanation: 'Should be blocked',
            },
          ],
          duration_ms: 9,
        } as any);

        const serviceClientWithWorkspace = {
          ...mockServiceClient,
          getWorkspacePath: () => tempDir,
        };

        try {
          const result = await handleExecutePlan(
            { plan, mode: 'single_step', step_number: 1, apply_changes: true },
            serviceClientWithWorkspace
          );
          const parsed = extractJsonDetails(result) as Record<string, unknown>;

          expect(parsed.files_applied).toEqual([]);
          expect(parsed.backups_created).toEqual([]);
          expect(parsed.apply_errors).toEqual(
            expect.arrayContaining([expect.stringContaining('Path is outside workspace')])
          );
          expect(result).toContain('Apply Errors');
        } finally {
          executeStepSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('should fail clearly when a diff cannot be applied', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-plan-bad-diff-'));
        const workspaceFile = path.join(tempDir, 'src', 'example.ts');
        fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
        fs.writeFileSync(workspaceFile, 'export const answer = 1;\nexport const flag = false;\n', 'utf-8');

        const plan = JSON.stringify({
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
              step_number: 1,
              id: 'step_1',
              title: 'Update example',
              description: 'Modify the example file',
              files_to_modify: [{ path: 'src/example.ts', reason: 'Exercise diff application' }],
              files_to_create: [],
              files_to_delete: [],
              depends_on: [],
              blocks: [],
              can_parallel_with: [],
              priority: 'medium',
              estimated_effort: '1h',
              acceptance_criteria: [],
            },
          ],
          dependency_graph: {
            nodes: [],
            edges: [],
            critical_path: [],
            parallel_groups: [],
            execution_order: [1],
          },
          testing_strategy: { unit: 'unit', integration: 'integration', coverage_target: '80%' },
          acceptance_criteria: [],
          confidence_score: 0.8,
          questions_for_clarification: [],
          context_files: [],
          codebase_insights: [],
        });

        const executeStepSpy = jest.spyOn(PlanningService.prototype, 'executeStep').mockResolvedValue({
          step_number: 1,
          success: true,
          reasoning: 'Attempted malformed diff',
          generated_code: [
            {
              path: 'src/example.ts',
              change_type: 'modify',
              diff: 'not a unified diff',
              explanation: 'Should fail to apply',
            },
          ],
          duration_ms: 8,
        } as any);

        const serviceClientWithWorkspace = {
          ...mockServiceClient,
          getWorkspacePath: () => tempDir,
        };

        try {
          const result = await handleExecutePlan(
            { plan, mode: 'single_step', step_number: 1, apply_changes: true },
            serviceClientWithWorkspace
          );
          const parsed = extractJsonDetails(result) as Record<string, unknown>;

          expect(parsed.files_applied).toEqual([]);
          expect(parsed.backups_created).toEqual([]);
          expect(parsed.apply_errors).toEqual(
            expect.arrayContaining([expect.stringContaining('Unified diff does not contain any hunks')])
          );
          expect(fs.readFileSync(workspaceFile, 'utf-8')).toContain('flag = false');
          expect(result).toContain('Apply Errors');
        } finally {
          executeStepSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    describe('Tool Schema', () => {
      it('should have correct name', () => {
        expect(executePlanTool.name).toBe('execute_plan');
      });

      it('should have description', () => {
        expect(executePlanTool.description).toBeDefined();
        expect(executePlanTool.description.length).toBeGreaterThan(50);
      });

      it('should require plan parameter', () => {
        expect(executePlanTool.inputSchema.required).not.toContain('plan');
      });

      it('should define mode enum', () => {
        const mode = executePlanTool.inputSchema.properties.mode;
        expect(mode.enum).toContain('single_step');
        expect(mode.enum).toContain('all_ready');
        expect(mode.enum).toContain('full_plan');
      });

      it('should define optional parameters', () => {
        const props = executePlanTool.inputSchema.properties;
        expect(props.plan_id).toBeDefined();
        expect(props.step_number).toBeDefined();
        expect(props.apply_changes).toBeDefined();
        expect(props.max_steps).toBeDefined();
        expect(props.stop_on_failure).toBeDefined();
        expect(props.additional_context).toBeDefined();
      });
    });
  });
});
