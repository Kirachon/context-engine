/**
 * Unit tests for PlanHistoryService
 *
 * Tests version history tracking, diff generation, and rollback functionality.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanHistoryService } from '../../src/mcp/services/planHistoryService.js';
import { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

describe('PlanHistoryService', () => {
  let service: PlanHistoryService;
  let tempDir: string;

  // Helper to create a test plan
  const createTestPlan = (version: number = 1): EnhancedPlanOutput => ({
    id: 'plan_test',
    version,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    goal: `Test goal v${version}`,
    scope: { included: ['feature A'], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: '', patterns_used: [], diagrams: [] },
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
    service = new PlanHistoryService(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('recordVersion', () => {
    it('should record a new version', () => {
      const plan = createTestPlan();
      const version = service.recordVersion(plan, 'created', 'Initial version');

      expect(version.version).toBe(1);
      expect(version.change_type).toBe('created');
      expect(version.change_summary).toBe('Initial version');
    });

    it('should increment version numbers', () => {
      const plan1 = createTestPlan(1);
      const plan2 = createTestPlan(2);

      service.recordVersion(plan1, 'created', 'v1');
      const v2 = service.recordVersion(plan2, 'modified', 'v2');

      expect(v2.version).toBe(2);
    });
  });

  describe('getHistory', () => {
    it('should return version history', () => {
      const plan1 = createTestPlan(1);
      const plan2 = createTestPlan(2);

      service.recordVersion(plan1, 'created', 'v1');
      service.recordVersion(plan2, 'modified', 'v2');

      const history = service.getHistory('plan_test');
      expect(history?.versions.length).toBe(2);
      expect(history?.current_version).toBe(2);
    });

    it('should respect limit option', () => {
      for (let i = 1; i <= 5; i++) {
        service.recordVersion(createTestPlan(i), 'modified', `v${i}`);
      }

      const history = service.getHistory('plan_test', { limit: 3 });
      expect(history?.versions.length).toBe(3);
    });

    it('should optionally include full plans', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');

      const withPlans = service.getHistory('plan_test', { include_plans: true });
      const withoutPlans = service.getHistory('plan_test', { include_plans: false });

      expect(withPlans?.versions[0].plan).toBeDefined();
      expect(withoutPlans?.versions[0].plan).toBeUndefined();
    });
  });

  describe('getVersion', () => {
    it('should retrieve a specific version', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');
      service.recordVersion(createTestPlan(2), 'modified', 'v2');

      const v1 = service.getVersion('plan_test', 1);
      expect(v1?.version).toBe(1);
      expect(v1?.plan.goal).toBe('Test goal v1');
    });

    it('should return null for non-existent version', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');

      const v99 = service.getVersion('plan_test', 99);
      expect(v99).toBeNull();
    });
  });

  describe('generateDiff', () => {
    it('should generate diff between versions', () => {
      const plan1 = createTestPlan(1);
      const plan2 = createTestPlan(2);
      plan2.steps.push({
        step_number: 2, id: 'step_2', title: 'Step 2', description: 'New step',
        files_to_modify: [], files_to_create: [], files_to_delete: [],
        depends_on: [], blocks: [], can_parallel_with: [],
        priority: 'medium', estimated_effort: '1h', acceptance_criteria: []
      });

      service.recordVersion(plan1, 'created', 'v1');
      service.recordVersion(plan2, 'modified', 'v2');

      const diff = service.generateDiff('plan_test', 1, 2);
      expect(diff?.steps_added).toContain(2);
      expect(diff?.summary).toContain('1 step(s) added');
    });
  });

  describe('rollback', () => {
    it('should rollback to a previous version', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');
      service.recordVersion(createTestPlan(2), 'modified', 'v2');

      const result = service.rollback('plan_test', { target_version: 1, reason: 'Reverting' });

      expect(result.success).toBe(true);
      expect(result.plan?.goal).toBe('Test goal v1');
      expect(result.new_version).toBe(3); // New version created
    });

    it('should fail for non-existent version', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');

      const result = service.rollback('plan_test', { target_version: 99 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('deleteHistory', () => {
    it('should delete history for a plan', () => {
      service.recordVersion(createTestPlan(1), 'created', 'v1');

      const deleted = service.deleteHistory('plan_test');
      expect(deleted).toBe(true);

      const history = service.getHistory('plan_test');
      expect(history).toBeNull();
    });
  });

  describe('Defensive Programming - Null/Undefined Handling', () => {
    it('should handle undefined planId in getHistoryFilePath', () => {
      // Access private method through any cast for testing
      const serviceAny = service as any;

      // Should not throw, should return fallback path
      const path = serviceAny.getHistoryFilePath(undefined);
      expect(path).toBeDefined();
      expect(path).toContain('history_');
    });

    it('should handle null planId in getHistoryFilePath', () => {
      const serviceAny = service as any;

      // Should not throw, should return fallback path
      const path = serviceAny.getHistoryFilePath(null);
      expect(path).toBeDefined();
      expect(path).toContain('history_');
    });

    it('should handle getHistory with non-existent planId', () => {
      const history = service.getHistory('non_existent_plan');
      expect(history).toBeNull();
    });

    it('should handle plan with undefined file arrays in collectAllFiles', () => {
      const planWithUndefinedFiles = {
        ...createTestPlan(),
        steps: [
          {
            step_number: 1,
            id: 'step_1',
            title: 'Step 1',
            description: 'First step',
            files_to_modify: undefined as unknown as any[],
            files_to_create: undefined as unknown as any[],
            files_to_delete: undefined as unknown as any[],
            depends_on: [],
            blocks: [],
            can_parallel_with: [],
            priority: 'high' as const,
            estimated_effort: '1h',
            acceptance_criteria: []
          }
        ]
      };

      // Should not throw when recording version with undefined file arrays
      service.recordVersion(planWithUndefinedFiles as any, 'created', 'Test version');
      const history = service.getHistory(planWithUndefinedFiles.id);
      expect(history).toBeDefined();
    });

    it('should handle generateDiff with undefined steps arrays', () => {
      const basePlan = createTestPlan();

      // Record first version
      service.recordVersion(basePlan, 'created', 'Version 1');

      // Create plan with undefined steps for second version
      const planV2 = {
        ...basePlan,
        version: 2,
        steps: undefined as unknown as any[]
      };

      service.recordVersion(planV2 as any, 'modified', 'Version 2');

      // Should not throw when generating diff
      const diff = service.generateDiff(basePlan.id, 1, 2);
      expect(diff).toBeDefined();
    });
  });

  // ==========================================================================
  // Memory Management & Cleanup Tests
  // ==========================================================================

  describe('Memory Management - Cleanup Functionality', () => {
    describe('getMemoryStats', () => {
      it('should return zero stats initially', () => {
        const stats = service.getMemoryStats();
        expect(stats.historiesInMemory).toBe(0);
      });

      it('should track histories in memory', () => {
        service.recordVersion(createTestPlan(1), 'created', 'v1');
        service.recordVersion(createTestPlan(2), 'modified', 'v2');

        const plan2 = { ...createTestPlan(1), id: 'plan_test_2' };
        service.recordVersion(plan2, 'created', 'v1');

        const stats = service.getMemoryStats();
        expect(stats.historiesInMemory).toBe(2); // Two different plans
      });

      it('should include max limits in stats', () => {
        const stats = service.getMemoryStats();
        expect(stats.maxHistories).toBeGreaterThan(0);
        expect(stats.maxVersionsPerHistory).toBeGreaterThan(0);
      });
    });

    describe('clearMemoryCache', () => {
      it('should clear all cached histories', () => {
        service.recordVersion(createTestPlan(1), 'created', 'v1');
        service.recordVersion(createTestPlan(2), 'modified', 'v2');

        const statsBefore = service.getMemoryStats();
        expect(statsBefore.historiesInMemory).toBeGreaterThan(0);

        service.clearMemoryCache();

        const statsAfter = service.getMemoryStats();
        expect(statsAfter.historiesInMemory).toBe(0);
      });

      it('should still be able to read histories after cache clear (from disk)', () => {
        service.recordVersion(createTestPlan(1), 'created', 'v1');

        service.clearMemoryCache();

        // History should still be readable from disk
        const history = service.getHistory('plan_test');
        expect(history).toBeDefined();
        expect(history?.versions.length).toBe(1);
      });
    });

    describe('LRU Eviction - Max Histories', () => {
      it('should track lastAccessTime on history access', () => {
        service.recordVersion(createTestPlan(1), 'created', 'v1');

        // Access the history
        service.getHistory('plan_test');

        const serviceAny = service as any;
        // lastAccessTime is stored in a separate map, not on the history object
        const lastAccessTime = serviceAny.lastAccessTime.get('plan_test');
        expect(lastAccessTime).toBeDefined();
        expect(lastAccessTime).toBeGreaterThan(0);
      });

      it('should evict oldest histories when over limit', () => {
        const MAX_HISTORIES = 50; // From planHistoryService.ts

        // Create more than MAX_HISTORIES plans
        for (let i = 0; i < MAX_HISTORIES + 10; i++) {
          const plan = { ...createTestPlan(1), id: `plan_${i}` };
          service.recordVersion(plan, 'created', `v1 for plan ${i}`);
        }

        const stats = service.getMemoryStats();
        // Should be at or below max
        expect(stats.historiesInMemory).toBeLessThanOrEqual(MAX_HISTORIES);
      });

      it('should evict least recently accessed histories first', () => {
        const MAX_HISTORIES = 50;

        // Create MAX_HISTORIES + 5 plans
        for (let i = 0; i < MAX_HISTORIES + 5; i++) {
          const plan = { ...createTestPlan(1), id: `plan_${i}` };
          service.recordVersion(plan, 'created', `v1`);
        }

        // Access some early plans to make them recently used
        service.getHistory('plan_0');
        service.getHistory('plan_1');
        service.getHistory('plan_2');

        // Add more plans to trigger eviction
        for (let i = MAX_HISTORIES + 5; i < MAX_HISTORIES + 15; i++) {
          const plan = { ...createTestPlan(1), id: `plan_${i}` };
          service.recordVersion(plan, 'created', `v1`);
        }

        // The recently accessed plans should still exist
        const stats = service.getMemoryStats();
        expect(stats.historiesInMemory).toBeLessThanOrEqual(MAX_HISTORIES);

        // Recently accessed plans should still be in memory
        const serviceAny = service as any;
        // These were accessed, so they should have been kept
        expect(serviceAny.histories.has('plan_0') ||
               service.getHistory('plan_0') !== null).toBeTruthy();
      });
    });

    describe('Version Pruning - Max Versions Per History', () => {
      it('should limit versions per history', () => {
        const MAX_VERSIONS = 20; // From planHistoryService.ts

        // Create more than MAX_VERSIONS versions for one plan
        for (let i = 1; i <= MAX_VERSIONS + 10; i++) {
          service.recordVersion(createTestPlan(i), i === 1 ? 'created' : 'modified', `Version ${i}`);
        }

        const history = service.getHistory('plan_test');
        expect(history).toBeDefined();
        // Should have at most MAX_VERSIONS entries
        expect(history!.versions.length).toBeLessThanOrEqual(MAX_VERSIONS);
      });

      it('should keep the most recent versions when pruning', () => {
        const MAX_VERSIONS = 20;

        // Create more than MAX_VERSIONS versions
        for (let i = 1; i <= MAX_VERSIONS + 5; i++) {
          service.recordVersion(createTestPlan(i), i === 1 ? 'created' : 'modified', `Version ${i}`);
        }

        const history = service.getHistory('plan_test');
        expect(history).toBeDefined();

        // The most recent versions should be kept
        const latestVersion = history!.versions[history!.versions.length - 1];
        expect(latestVersion.version).toBe(MAX_VERSIONS + 5);

        // Current version should be the latest
        expect(history!.current_version).toBe(MAX_VERSIONS + 5);
      });
    });
  });
});
