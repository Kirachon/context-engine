/**
 * Unit tests for PlanningService
 *
 * Tests the Layer 2 - Service Layer for planning mode.
 * Focus on DAG analysis algorithms which are pure functions.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PlanningService } from '../../src/mcp/services/planningService.js';
import { EnhancedPlanStep, DependencyGraph } from '../../src/mcp/types/planning.js';

describe('PlanningService', () => {
  let planningService: PlanningService;
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceClient = {
      getContextForPrompt: jest.fn(),
      searchAndAsk: jest.fn(),
    };
    planningService = new PlanningService(mockServiceClient);
  });

  // Helper to create minimal step
  function createStep(
    stepNumber: number,
    dependsOn: number[] = [],
    blocks: number[] = []
  ): EnhancedPlanStep {
    return {
      step_number: stepNumber,
      id: `step_${stepNumber}`,
      title: `Step ${stepNumber}`,
      description: `Description for step ${stepNumber}`,
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      depends_on: dependsOn,
      blocks: blocks,
      can_parallel_with: [],
      priority: 'medium',
      estimated_effort: '1h',
      acceptance_criteria: [],
    };
  }

  describe('analyzeDependencies', () => {
    describe('Linear Chain', () => {
      it('should handle linear dependency chain (1→2→3→4)', () => {
        const steps = [
          createStep(1, [], [2]),
          createStep(2, [1], [3]),
          createStep(3, [2], [4]),
          createStep(4, [3], []),
        ];

        const graph = planningService.analyzeDependencies(steps);

        // Execution order must be sequential
        expect(graph.execution_order).toEqual([1, 2, 3, 4]);

        // Critical path is the entire chain
        expect(graph.critical_path).toEqual([1, 2, 3, 4]);

        // No parallel groups in a linear chain
        expect(graph.parallel_groups).toEqual([]);
      });
    });

    describe('Diamond Pattern', () => {
      it('should handle diamond dependencies (1→[2,3]→4)', () => {
        //     1
        //    / \
        //   2   3
        //    \ /
        //     4
        const steps = [
          createStep(1, [], [2, 3]),
          createStep(2, [1], [4]),
          createStep(3, [1], [4]),
          createStep(4, [2, 3], []),
        ];

        const graph = planningService.analyzeDependencies(steps);

        // Step 1 must be first, step 4 must be last
        expect(graph.execution_order[0]).toBe(1);
        expect(graph.execution_order[graph.execution_order.length - 1]).toBe(4);

        // Steps 2 and 3 should be in parallel group
        const hasParallelGroup = graph.parallel_groups.some(
          group => group.includes(2) && group.includes(3)
        );
        expect(hasParallelGroup).toBe(true);
      });
    });

    describe('Independent Steps', () => {
      it('should handle completely independent steps', () => {
        const steps = [
          createStep(1, [], []),
          createStep(2, [], []),
          createStep(3, [], []),
        ];

        const graph = planningService.analyzeDependencies(steps);

        // All steps should be in same parallel group (or at level 0)
        expect(graph.parallel_groups.length).toBe(1);
        expect(graph.parallel_groups[0].sort()).toEqual([1, 2, 3]);
      });
    });

    describe('Complex DAG', () => {
      it('should handle complex multi-level dependencies', () => {
        //     1
        //    /|\
        //   2 3 4
        //   |\ /|
        //   5  6
        //    \/
        //     7
        const steps = [
          createStep(1, [], [2, 3, 4]),
          createStep(2, [1], [5, 6]),
          createStep(3, [1], [6]),
          createStep(4, [1], [6]),
          createStep(5, [2], [7]),
          createStep(6, [2, 3, 4], [7]),
          createStep(7, [5, 6], []),
        ];

        const graph = planningService.analyzeDependencies(steps);

        // Verify topological order constraints
        const indexOf = (n: number) => graph.execution_order.indexOf(n);
        expect(indexOf(1)).toBeLessThan(indexOf(2));
        expect(indexOf(1)).toBeLessThan(indexOf(3));
        expect(indexOf(1)).toBeLessThan(indexOf(4));
        expect(indexOf(2)).toBeLessThan(indexOf(5));
        expect(indexOf(2)).toBeLessThan(indexOf(6));
        expect(indexOf(5)).toBeLessThan(indexOf(7));
        expect(indexOf(6)).toBeLessThan(indexOf(7));

        // Steps 2, 3, 4 can run in parallel
        const level1Group = graph.parallel_groups.find(
          g => g.includes(2) && g.includes(3) && g.includes(4)
        );
        expect(level1Group).toBeDefined();
      });
    });

    describe('Edge Cases', () => {
      it('should handle single step', () => {
        const steps = [createStep(1, [], [])];

        const graph = planningService.analyzeDependencies(steps);

        expect(graph.nodes.length).toBe(1);
        expect(graph.edges.length).toBe(0);
        expect(graph.execution_order).toEqual([1]);
        expect(graph.critical_path).toEqual([1]);
      });

      it('should handle empty steps array', () => {
        const graph = planningService.analyzeDependencies([]);

        expect(graph.nodes).toEqual([]);
        expect(graph.edges).toEqual([]);
        expect(graph.execution_order).toEqual([]);
        expect(graph.critical_path).toEqual([]);
      });
    });
  });
});

