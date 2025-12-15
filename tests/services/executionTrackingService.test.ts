/**
 * Unit tests for ExecutionTrackingService
 *
 * Tests step execution tracking, progress calculation, and dependency management.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ExecutionTrackingService } from '../../src/mcp/services/executionTrackingService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

describe('ExecutionTrackingService', () => {
  let service: ExecutionTrackingService;

  // Helper to create a test plan with dependencies
  const createTestPlan = (): EnhancedPlanOutput => ({
    id: 'plan_test',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    goal: 'Test goal',
    scope: { included: [], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: '', patterns_used: [], diagrams: [] },
    risks: [],
    milestones: [],
    steps: [
      {
        step_number: 1, id: 'step_1', title: 'Step 1', description: 'First step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [], blocks: [2, 3], can_parallel_with: [],
        priority: 'high', estimated_effort: '1h', acceptance_criteria: []
      },
      {
        step_number: 2, id: 'step_2', title: 'Step 2', description: 'Second step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [1], blocks: [4], can_parallel_with: [3],
        priority: 'medium', estimated_effort: '2h', acceptance_criteria: []
      },
      {
        step_number: 3, id: 'step_3', title: 'Step 3', description: 'Third step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [1], blocks: [4], can_parallel_with: [2],
        priority: 'medium', estimated_effort: '1h', acceptance_criteria: []
      },
      {
        step_number: 4, id: 'step_4', title: 'Step 4', description: 'Fourth step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [2, 3], blocks: [], can_parallel_with: [],
        priority: 'low', estimated_effort: '30m', acceptance_criteria: []
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
    service = new ExecutionTrackingService();
  });

  describe('initializeExecution', () => {
    it('should initialize execution state', () => {
      const plan = createTestPlan();
      const state = service.initializeExecution(plan);

      expect(state.plan_id).toBe(plan.id);
      expect(state.steps.length).toBe(4);
      expect(state.ready_steps).toContain(1); // Step 1 has no dependencies
      expect(state.ready_steps).not.toContain(2); // Step 2 depends on 1
    });

    it('should set steps with no dependencies to ready', () => {
      const plan = createTestPlan();
      const state = service.initializeExecution(plan);

      // Step 1 has no dependencies, should be ready
      const step1 = state.steps.find(s => s.step_number === 1);
      expect(step1?.status).toBe('ready');

      // Steps with dependencies should be blocked
      const step2 = state.steps.find(s => s.step_number === 2);
      expect(step2?.status).toBe('pending');
    });
  });

  describe('startStep', () => {
    it('should start a ready step', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);

      const step = service.startStep(plan.id, 1);
      expect(step?.status).toBe('in_progress');
      expect(step?.started_at).toBeDefined();
    });

    it('should allow starting pending steps (dependency check is advisory)', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);

      // The service allows starting pending steps - dependency enforcement is advisory
      const step = service.startStep(plan.id, 2); // Depends on step 1 but can still be started
      expect(step?.status).toBe('in_progress');
    });

    it('should track current steps', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);
      service.startStep(plan.id, 1);

      const state = service.getExecutionState(plan.id);
      expect(state?.current_steps).toContain(1);
    });
  });

  describe('completeStep', () => {
    it('should complete a step', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);
      service.startStep(plan.id, 1);

      const step = service.completeStep(plan.id, 1, plan);
      expect(step?.status).toBe('completed');
      expect(step?.completed_at).toBeDefined();
    });

    it('should unlock dependent steps', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);
      service.startStep(plan.id, 1);
      service.completeStep(plan.id, 1, plan);

      const state = service.getExecutionState(plan.id);
      expect(state?.ready_steps).toContain(2);
      expect(state?.ready_steps).toContain(3);
    });
  });

  describe('failStep', () => {
    it('should mark step as failed', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);
      service.startStep(plan.id, 1);

      const step = service.failStep(plan.id, 1, plan, { error: 'Test error' });
      expect(step?.status).toBe('failed');
      expect(step?.error).toBe('Test error');
    });

    it('should skip dependent steps when skip_dependents is true', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);
      service.startStep(plan.id, 1);
      service.failStep(plan.id, 1, plan, { error: 'Error', skip_dependents: true });

      const state = service.getExecutionState(plan.id);
      const step2 = state?.steps.find(s => s.step_number === 2);
      const step3 = state?.steps.find(s => s.step_number === 3);
      expect(step2?.status).toBe('skipped');
      expect(step3?.status).toBe('skipped');
    });
  });

  describe('getProgress', () => {
    it('should calculate progress correctly', () => {
      const plan = createTestPlan();
      service.initializeExecution(plan);

      let progress = service.getProgress(plan.id);
      expect(progress?.percentage).toBe(0);

      service.startStep(plan.id, 1);
      service.completeStep(plan.id, 1, plan);

      progress = service.getProgress(plan.id);
      expect(progress?.percentage).toBe(25); // 1 of 4 steps
      expect(progress?.completed_steps).toBe(1);
      expect(progress?.total_steps).toBe(4);
    });
  });
});

