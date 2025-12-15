#!/usr/bin/env tsx
/**
 * Test: Defensive Array Checks
 *
 * Validates that the "step.files_to_modify is not iterable" error
 * has been fixed by testing with undefined/null array properties.
 */

import { PlanningService } from '../src/mcp/services/planningService.js';
import { PlanPersistenceService } from '../src/mcp/services/planPersistenceService.js';
import { EnhancedPlanOutput, EnhancedPlanStep } from '../src/mcp/types/planning.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function log(status: 'pass' | 'fail' | 'info', message: string) {
  const prefix = status === 'pass' ? `${GREEN}✓${RESET}` :
                 status === 'fail' ? `${RED}✗${RESET}` :
                 `${YELLOW}ℹ${RESET}`;
  console.log(`${prefix} ${message}`);
}

// Create a minimal plan with UNDEFINED array properties
function createPlanWithUndefinedArrays(): EnhancedPlanOutput {
  return {
    id: 'test-plan-' + Date.now(),
    version: 1,
    goal: 'Test defensive array checks',
    scope: {
      included: undefined as unknown as string[],
      excluded: undefined as unknown as string[],
    },
    steps: [
      {
        step_number: 1,
        id: 'step_1',
        title: 'Test Step with undefined arrays',
        description: 'This step has undefined file arrays',
        files_to_modify: undefined as unknown as any[],
        files_to_create: undefined as unknown as any[],
        files_to_delete: undefined as unknown as string[],
        depends_on: undefined as unknown as number[],
        blocks: undefined as unknown as number[],
        can_parallel_with: undefined as unknown as number[],
        priority: 'high',
        estimated_effort: '1 hour',
        acceptance_criteria: undefined as unknown as string[],
      } as EnhancedPlanStep,
    ],
    risks: undefined as unknown as any[],
    milestones: [],
    questions_for_clarification: undefined as unknown as string[],
    confidence_score: 0.8,
    dependency_graph: {
      nodes: [],
      edges: [],
      critical_path: undefined as unknown as number[],
      parallel_groups: undefined as unknown as number[][],
      execution_order: [],
    },
  };
}

async function testAnalyzeDependenciesWithUndefined() {
  console.log('\n--- Test: analyzeDependencies with undefined arrays ---');
  
  const mockClient = {} as any;
  const planningService = new PlanningService(mockClient);
  
  // Create steps with undefined depends_on and blocks
  const stepsWithUndefined = [
    {
      step_number: 1,
      id: 'step_1',
      title: 'Test',
      description: 'Test',
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      depends_on: undefined as unknown as number[],
      blocks: undefined as unknown as number[],
      can_parallel_with: [],
      priority: 'high' as const,
      estimated_effort: '1h',
      acceptance_criteria: [],
    },
  ];

  try {
    const graph = planningService.analyzeDependencies(stepsWithUndefined as EnhancedPlanStep[]);
    log('pass', 'analyzeDependencies handled undefined arrays without error');
    log('info', `Result: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
    return true;
  } catch (error) {
    log('fail', `analyzeDependencies failed: ${error}`);
    return false;
  }
}

async function testPlanPersistenceWithUndefined() {
  console.log('\n--- Test: Plan Persistence with undefined arrays ---');
  
  const tempDir = path.join(os.tmpdir(), 'context-engine-test-' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    const persistService = new PlanPersistenceService(tempDir);
    const planWithUndefined = createPlanWithUndefinedArrays();
    
    // Try to save the plan
    const saveResult = await persistService.savePlan(planWithUndefined, { tags: ['test'] });
    log('pass', `Plan saved successfully: ${saveResult.plan_id}`);
    
    // Try to load it back
    const loadedPlan = await persistService.loadPlan(saveResult.plan_id);
    if (loadedPlan) {
      log('pass', 'Plan loaded successfully');
    } else {
      log('fail', 'Plan not found after save');
      return false;
    }
    
    // List plans
    const plans = await persistService.listPlans();
    log('pass', `Listed ${plans.length} plan(s)`);
    
    return true;
  } catch (error) {
    log('fail', `Plan persistence failed: ${error}`);
    return false;
  } finally {
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('🔍 Defensive Array Checks Test\n');
  console.log('='.repeat(50));
  console.log('Testing fix for "step.files_to_modify is not iterable" error\n');

  let passed = 0;
  let failed = 0;

  if (await testAnalyzeDependenciesWithUndefined()) passed++; else failed++;
  if (await testPlanPersistenceWithUndefined()) passed++; else failed++;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}`);

  if (failed === 0) {
    console.log(`\n${GREEN}SUCCESS: All defensive array checks are working!${RESET}`);
    console.log('The "is not iterable" errors should no longer occur.\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);

