#!/usr/bin/env tsx
/**
 * Smoke Test: Planning Service
 *
 * Quick validation that the planning service initializes correctly
 * and the DAG analysis algorithms work on sample data.
 */

import { PlanningService } from '../src/mcp/services/planningService.js';
import { EnhancedPlanStep } from '../src/mcp/types/planning.js';
import { extractJsonFromResponse } from '../src/mcp/prompts/planning.js';

// ANSI colors for output
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

// ============================================================================
// Test 1: DAG Analysis with sample steps
// ============================================================================
function testDagAnalysis() {
  console.log('\n--- Test: DAG Analysis ---');

  // Create sample steps with dependencies
  const steps: EnhancedPlanStep[] = [
    {
      step_number: 1, id: 'step_1', title: 'Setup types',
      description: 'Create type definitions', files_to_modify: [], files_to_create: [],
      files_to_delete: [], depends_on: [], blocks: [2, 3], can_parallel_with: [],
      priority: 'critical', estimated_effort: '1h', acceptance_criteria: []
    },
    {
      step_number: 2, id: 'step_2', title: 'Create service',
      description: 'Implement service layer', files_to_modify: [], files_to_create: [],
      files_to_delete: [], depends_on: [1], blocks: [4], can_parallel_with: [3],
      priority: 'high', estimated_effort: '2h', acceptance_criteria: []
    },
    {
      step_number: 3, id: 'step_3', title: 'Create tools',
      description: 'Implement MCP tools', files_to_modify: [], files_to_create: [],
      files_to_delete: [], depends_on: [1], blocks: [4], can_parallel_with: [2],
      priority: 'high', estimated_effort: '2h', acceptance_criteria: []
    },
    {
      step_number: 4, id: 'step_4', title: 'Integration',
      description: 'Wire everything together', files_to_modify: [], files_to_create: [],
      files_to_delete: [], depends_on: [2, 3], blocks: [], can_parallel_with: [],
      priority: 'medium', estimated_effort: '1h', acceptance_criteria: []
    },
  ];

  // Create a mock service client (we only need analyzeDependencies which doesn't use it)
  const mockClient = {} as any;
  const planningService = new PlanningService(mockClient);

  try {
    const graph = planningService.analyzeDependencies(steps);

    // Verify nodes
    if (graph.nodes.length !== 4) {
      throw new Error(`Expected 4 nodes, got ${graph.nodes.length}`);
    }
    log('pass', `Nodes: ${graph.nodes.length} (expected 4)`);

    // Verify edges
    if (graph.edges.length < 3) {
      throw new Error(`Expected at least 3 edges, got ${graph.edges.length}`);
    }
    log('pass', `Edges: ${graph.edges.length} (expected ≥3)`);

    // Verify execution order (step 1 must come first, step 4 must come last)
    const order = graph.execution_order;
    if (order[0] !== 1) {
      throw new Error(`Expected step 1 first, got step ${order[0]}`);
    }
    if (order[order.length - 1] !== 4) {
      throw new Error(`Expected step 4 last, got step ${order[order.length - 1]}`);
    }
    log('pass', `Execution order: [${order.join(' → ')}]`);

    // Verify critical path (should be 1 → 2 or 3 → 4)
    if (graph.critical_path.length !== 3) {
      log('info', `Critical path: [${graph.critical_path.join(' → ')}] (length ${graph.critical_path.length})`);
    } else {
      log('pass', `Critical path: [${graph.critical_path.join(' → ')}]`);
    }

    // Verify parallel groups
    const hasParallel = graph.parallel_groups.some(g => g.includes(2) && g.includes(3));
    if (!hasParallel) {
      log('info', `Parallel groups: ${JSON.stringify(graph.parallel_groups)} (expected [2,3] together)`);
    } else {
      log('pass', `Parallel groups found: Steps 2 and 3 can run together`);
    }

    return true;
  } catch (error) {
    log('fail', `DAG analysis failed: ${error}`);
    return false;
  }
}

// ============================================================================
// Test 2: JSON Extraction
// ============================================================================
function testJsonExtraction() {
  console.log('\n--- Test: JSON Extraction ---');

  // Test 1: Raw JSON
  const rawJson = '{"goal": "Test", "steps": []}';
  const result1 = extractJsonFromResponse(rawJson);
  if (result1 && JSON.parse(result1).goal === 'Test') {
    log('pass', 'Raw JSON extraction works');
  } else {
    log('fail', 'Raw JSON extraction failed');
    return false;
  }

  // Test 2: JSON in markdown code fence
  const markdownJson = 'Here is the plan:\n```json\n{"goal": "Markdown Test"}\n```\nDone!';
  const result2 = extractJsonFromResponse(markdownJson);
  if (result2 && JSON.parse(result2).goal === 'Markdown Test') {
    log('pass', 'Markdown code fence extraction works');
  } else {
    log('fail', 'Markdown code fence extraction failed');
    return false;
  }

  // Test 3: Invalid input
  const invalid = 'No JSON here at all';
  const result3 = extractJsonFromResponse(invalid);
  if (result3 === null) {
    log('pass', 'Invalid input correctly returns null');
  } else {
    log('fail', `Invalid input should return null, got: ${result3}`);
    return false;
  }

  return true;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log('🔍 Planning Service Smoke Test\n');
  console.log('=' .repeat(50));

  let passed = 0;
  let failed = 0;

  if (testDagAnalysis()) passed++; else failed++;
  if (testJsonExtraction()) passed++; else failed++;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);

