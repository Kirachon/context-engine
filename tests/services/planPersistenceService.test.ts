/**
 * Unit tests for PlanPersistenceService
 *
 * Tests save, load, list, delete operations for plan persistence.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanPersistenceService } from '../../src/mcp/services/planPersistenceService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

describe('PlanPersistenceService', () => {
  let service: PlanPersistenceService;
  let tempDir: string;

  // Helper to create a test plan
  const createTestPlan = (id: string = 'plan_test', goal: string = 'Test goal'): EnhancedPlanOutput => ({
    id,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    goal,
    scope: { included: ['feature A'], excluded: ['feature B'], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: 'Test notes', patterns_used: [], diagrams: [] },
    risks: [],
    milestones: [],
    steps: [
      {
        step_number: 1, id: 'step_1', title: 'Step 1', description: 'First step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [], blocks: [], can_parallel_with: [],
        priority: 'high', estimated_effort: '1h', acceptance_criteria: []
      }
    ],
    dependency_graph: { nodes: [], edges: [], critical_path: [], parallel_groups: [], execution_order: [] },
    testing_strategy: { unit: '', integration: '', coverage_target: '80%' },
    acceptance_criteria: [],
    confidence_score: 0.8,
    questions_for_clarification: [],
    context_files: [],
    codebase_insights: []
  });

  beforeEach(() => {
    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
    service = new PlanPersistenceService(tempDir);
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('savePlan', () => {
    it('should save a plan successfully', async () => {
      const plan = createTestPlan();
      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan_id).toBe(plan.id);
      expect(result.file_path).toBeDefined();
    });

    it('should reject duplicate plan without overwrite flag', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan);
      
      const result = await service.savePlan(plan);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should allow overwrite with flag', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan);
      
      plan.goal = 'Updated goal';
      const result = await service.savePlan(plan, { overwrite: true });
      
      expect(result.success).toBe(true);
    });

    it('should save with custom name', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan, { name: 'My Custom Plan' });

      const metadata = await service.getPlanMetadata(plan.id);
      expect(metadata?.name).toBe('My Custom Plan');
    });

    it('should save with tags', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan, { tags: ['backend', 'api'] });

      const metadata = await service.getPlanMetadata(plan.id);
      expect(metadata?.tags).toContain('backend');
      expect(metadata?.tags).toContain('api');
    });

    it('should handle plan with undefined goal', async () => {
      const plan = createTestPlan('plan_no_goal');
      // @ts-expect-error - Testing undefined goal scenario
      plan.goal = undefined;

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan_id).toBe('plan_no_goal');

      const metadata = await service.getPlanMetadata('plan_no_goal');
      expect(metadata?.goal).toBe('No goal specified');
      expect(metadata?.name).toMatch(/^Plan \d{4}-\d{2}-\d{2}$/); // Generated name from date
    });

    it('should handle plan with undefined id', async () => {
      const plan = createTestPlan();
      // @ts-expect-error - Testing undefined id scenario
      plan.id = undefined;

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan_id).toMatch(/^plan_\d+$/); // Generated ID
    });

    it('should handle plan with null goal', async () => {
      const plan = createTestPlan('plan_null_goal');
      // @ts-expect-error - Testing null goal scenario
      plan.goal = null;

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      const metadata = await service.getPlanMetadata('plan_null_goal');
      expect(metadata?.goal).toBe('No goal specified');
    });

    it('should handle plan with empty goal string', async () => {
      const plan = createTestPlan('plan_empty_goal');
      plan.goal = '';

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      const metadata = await service.getPlanMetadata('plan_empty_goal');
      expect(metadata?.goal).toBe('No goal specified');
    });

    it('should handle plan with undefined steps', async () => {
      const plan = createTestPlan('plan_no_steps');
      // @ts-expect-error - Testing undefined steps scenario
      plan.steps = undefined;

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      const metadata = await service.getPlanMetadata('plan_no_steps');
      expect(metadata?.step_count).toBe(0);
    });

    it('should handle plan with steps containing undefined file arrays', async () => {
      const plan = createTestPlan('plan_undefined_files');
      plan.steps = [
        {
          step_number: 1, id: 'step_1', title: 'Step 1', description: 'Test step',
          // @ts-expect-error - Testing undefined file arrays
          files_to_modify: undefined,
          // @ts-expect-error - Testing undefined file arrays
          files_to_create: undefined,
          // @ts-expect-error - Testing undefined file arrays
          files_to_delete: undefined,
          depends_on: [], blocks: [], can_parallel_with: [],
          priority: 'high', estimated_effort: '1h', acceptance_criteria: []
        }
      ];

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan_id).toBe('plan_undefined_files');
    });

    it('should handle goal with special characters only', async () => {
      const plan = createTestPlan('plan_special_chars');
      plan.goal = '!@#$%^&*()';

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      const metadata = await service.getPlanMetadata('plan_special_chars');
      // Name should be generated from date since special chars are stripped
      expect(metadata?.name).toMatch(/^Plan \d{4}-\d{2}-\d{2}$/);
    });

    it('should handle completely empty plan object', async () => {
      // @ts-expect-error - Testing empty plan object
      const plan: EnhancedPlanOutput = {};

      const result = await service.savePlan(plan);

      expect(result.success).toBe(true);
      expect(result.plan_id).toMatch(/^plan_\d+$/); // Generated ID
    });
  });

  describe('loadPlan', () => {
    it('should load a saved plan', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan);

      const loaded = await service.loadPlan(plan.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(plan.id);
      expect(loaded?.goal).toBe(plan.goal);
    });

    it('should return null for non-existent plan', async () => {
      const loaded = await service.loadPlan('non_existent');
      expect(loaded).toBeNull();
    });
  });

  describe('loadPlanByName', () => {
    it('should load plan by name (case insensitive)', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan, { name: 'My Test Plan' });

      const loaded = await service.loadPlanByName('my test plan');
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(plan.id);
    });
  });

  describe('deletePlan', () => {
    it('should delete a plan', async () => {
      const plan = createTestPlan();
      await service.savePlan(plan);

      const result = await service.deletePlan(plan.id);
      expect(result.success).toBe(true);

      const loaded = await service.loadPlan(plan.id);
      expect(loaded).toBeNull();
    });

    it('should return error for non-existent plan', async () => {
      const result = await service.deletePlan('non_existent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('listPlans', () => {
    it('should list all saved plans', async () => {
      await service.savePlan(createTestPlan('plan_1', 'Goal 1'));
      await service.savePlan(createTestPlan('plan_2', 'Goal 2'));

      const plans = await service.listPlans();
      expect(plans.length).toBe(2);
    });

    it('should filter by tags', async () => {
      await service.savePlan(createTestPlan('plan_1'), { tags: ['backend'] });
      await service.savePlan(createTestPlan('plan_2'), { tags: ['frontend'] });

      const plans = await service.listPlans({ tags: ['backend'] });
      expect(plans.length).toBe(1);
      expect(plans[0].id).toBe('plan_1');
    });

    it('should respect limit', async () => {
      await service.savePlan(createTestPlan('plan_1'));
      await service.savePlan(createTestPlan('plan_2'));
      await service.savePlan(createTestPlan('plan_3'));

      const plans = await service.listPlans({ limit: 2 });
      expect(plans.length).toBe(2);
    });
  });
});

