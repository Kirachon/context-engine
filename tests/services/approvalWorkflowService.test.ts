/**
 * Unit tests for ApprovalWorkflowService
 *
 * Tests approval request creation, response handling, and workflow management.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ApprovalWorkflowService } from '../../src/mcp/services/approvalWorkflowService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

describe('ApprovalWorkflowService', () => {
  let service: ApprovalWorkflowService;

  // Helper to create a test plan
  const createTestPlan = (): EnhancedPlanOutput => ({
    id: 'plan_test',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    goal: 'Test goal',
    scope: { included: ['feature A'], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: '', patterns_used: [], diagrams: [] },
    risks: [{ issue: 'Risk 1', likelihood: 'medium', mitigation: 'Handle it' }],
    milestones: [],
    steps: [
      {
        step_number: 1, id: 'step_1', title: 'Step 1', description: 'First step',
        files_to_modify: [{ path: 'file.ts', change_type: 'modify', estimated_loc: 10, complexity: 'simple', reason: 'Add feature' }],
        files_to_create: [], files_to_delete: [],
        depends_on: [], blocks: [2], can_parallel_with: [],
        priority: 'high', estimated_effort: '1h', acceptance_criteria: []
      },
      {
        step_number: 2, id: 'step_2', title: 'Step 2', description: 'Second step',
        files_to_modify: [], files_to_create: [{ path: 'new.ts', change_type: 'create', estimated_loc: 50, complexity: 'moderate', reason: 'New file' }],
        files_to_delete: [],
        depends_on: [1], blocks: [], can_parallel_with: [],
        priority: 'medium', estimated_effort: '2h', acceptance_criteria: []
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
    service = new ApprovalWorkflowService();
  });

  describe('createPlanApprovalRequest', () => {
    it('should create a plan approval request', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);

      expect(request.id).toBeDefined();
      expect(request.plan_id).toBe(plan.id);
      expect(request.type).toBe('full_plan');
      expect(request.status).toBe('pending');
      expect(request.summary).toContain('Test goal');
    });

    it('should include risk summary', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);

      expect(request.summary).toContain('Test goal');
    });
  });

  describe('createStepApprovalRequest', () => {
    it('should create a step approval request', () => {
      const plan = createTestPlan();
      const request = service.createStepApprovalRequest(plan, 1);

      expect(request.type).toBe('step');
      expect(request.step_number).toBe(1);
      expect(request.summary).toContain('Step 1');
    });

    it('should throw for invalid step number', () => {
      const plan = createTestPlan();
      expect(() => service.createStepApprovalRequest(plan, 99)).toThrow();
    });
  });

  describe('createStepGroupApprovalRequest', () => {
    it('should create a group approval request', () => {
      const plan = createTestPlan();
      const request = service.createStepGroupApprovalRequest(plan, [1, 2]);

      expect(request.type).toBe('step_group');
      expect(request.summary).toContain('1, 2');
    });
  });

  describe('processApprovalResponse', () => {
    it('should approve a request', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);

      const result = service.processApprovalResponse({
        request_id: request.id,
        action: 'approve',
        comment: 'Looks good!'
      });

      expect(result.success).toBe(true);
      expect(result.request?.status).toBe('approved');
    });

    it('should reject a request', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);

      const result = service.processApprovalResponse({
        request_id: request.id,
        action: 'reject',
        comment: 'Needs more work'
      });

      expect(result.success).toBe(true);
      expect(result.request?.status).toBe('rejected');
    });

    it('should request modifications', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);

      const result = service.processApprovalResponse({
        request_id: request.id,
        action: 'request_modification',
        modifications: 'Please add error handling'
      });

      expect(result.success).toBe(true);
      expect(result.request?.status).toBe('modification_requested');
    });

    it('should fail for non-existent request', () => {
      const result = service.processApprovalResponse({
        request_id: 'non_existent',
        action: 'approve'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getPendingApprovalsForPlan', () => {
    it('should return pending requests for a plan', () => {
      const plan = createTestPlan();
      service.createPlanApprovalRequest(plan);
      service.createStepApprovalRequest(plan, 1);

      const pending = service.getPendingApprovalsForPlan(plan.id);
      expect(pending.length).toBe(2);
    });
  });

  describe('getApprovalHistory', () => {
    it('should return all requests for a plan', () => {
      const plan = createTestPlan();
      const request = service.createPlanApprovalRequest(plan);
      
      service.processApprovalResponse({
        request_id: request.id,
        action: 'approve'
      });

      const history = service.getApprovalHistory(plan.id);
      expect(history.length).toBe(1);
      expect(history[0].status).toBe('approved');
    });
  });
});

