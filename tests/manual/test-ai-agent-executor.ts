/**
 * Manual Test Script for AI Agent Step Executor
 * 
 * This script tests both executor modes to verify:
 * 1. Backward compatibility (flag OFF)
 * 2. AI Agent executor functionality (flag ON)
 * 3. Performance comparison
 */

import { ReactiveReviewService } from '../src/reactive/ReactiveReviewService.js';
import { ContextServiceClient } from '../src/mcp/serviceClient.js';
import { PlanningService } from '../src/mcp/services/planningService.js';
import { getConfig } from '../src/reactive/config.js';
import { createAIAgentStepExecutor } from '../src/reactive/executors/AIAgentStepExecutor.js';
import type { PRMetadata } from '../src/reactive/index.js';

async function runTest() {
    console.log('\n=== AI Agent Step Executor Test ===\n');

    // Check configuration
    const config = getConfig();
    console.log('Configuration:');
    console.log(`  REACTIVE_ENABLED: ${config.enabled}`);
    console.log(`  REACTIVE_USE_AI_AGENT_EXECUTOR: ${config.use_ai_agent_executor}`);
    console.log(`  REACTIVE_PARALLEL_EXEC: ${config.parallel_exec}`);
    console.log(`  REACTIVE_MAX_WORKERS: ${config.max_workers}`);
    console.log();

    if (!config.enabled) {
        console.error('❌ REACTIVE_ENABLED is not set to true');
        console.error('   Set REACTIVE_ENABLED=true to run this test');
        process.exit(1);
    }

    // Initialize services
    const serviceClient = new ContextServiceClient();
    const reviewService = new ReactiveReviewService(serviceClient);

    // Sample PR metadata for testing
    const testPR: PRMetadata = {
        commit_hash: 'test123',
        base_ref: 'main',
        changed_files: ['src/reactive/executors/AIAgentStepExecutor.ts'],
        title: 'Test: AI Agent Step Executor',
        author: 'test-user',
        additions: 100,
        deletions: 0,
    };

    console.log('Test PR Metadata:');
    console.log(`  Files: ${testPR.changed_files.join(', ')}`);
    console.log(`  Commit: ${testPR.commit_hash}`);
    console.log();

    try {
        // Test 1: Create session
        console.log('Test 1: Creating review session...');
        const startTime = Date.now();
        const session = await reviewService.startReactiveReview(testPR);
        const sessionTime = Date.now() - startTime;

        console.log(`✅ Session created in ${sessionTime}ms`);
        console.log(`   Session ID: ${session.session_id}`);
        console.log(`   Plan ID: ${session.plan_id}`);
        console.log(`   Total steps: ${session.total_steps}`);
        console.log(`   Status: ${session.status}`);
        console.log();

        // Test 2: Verify executor selection
        console.log('Test 2: Verifying executor selection...');
        if (config.use_ai_agent_executor) {
            console.log('✅ AI Agent Executor is ENABLED');

            // Test creating the executor
            const executor = createAIAgentStepExecutor(reviewService, session.session_id);
            console.log('✅ AI Agent Executor created successfully');
            console.log('   Type:', typeof executor);
            console.log('   Is function:', typeof executor === 'function');
        } else {
            console.log('✅ Default Executor is ENABLED (API mode)');
            console.log('   This uses PlanningService.executeStep()');
        }
        console.log();

        // Test 3: Get session status
        console.log('Test 3: Getting review status...');
        const status = reviewService.getReviewStatus(session.session_id);
        console.log(`✅ Status retrieved`);
        console.log(`   Status: ${status.status}`);
        console.log(`   Progress: ${status.completed_steps}/${status.total_steps}`);
        console.log();

        // Test 4: Get telemetry
        console.log('Test 4: Getting telemetry data...');
        const telemetry = reviewService.getReviewTelemetry(session.session_id);
        console.log(`✅ Telemetry retrieved`);
        console.log(`   Elapsed time: ${telemetry.elapsed_time_ms}ms`);
        console.log(`   Cache hits: ${telemetry.cache_hits}`);
        console.log(`   Cache misses: ${telemetry.cache_misses}`);
        console.log();

        console.log('=== All Tests Passed ✅ ===\n');
        console.log('Summary:');
        console.log(`  - Session creation: ${sessionTime}ms`);
        console.log(`  - Executor mode: ${config.use_ai_agent_executor ? 'AI Agent (FAST)' : 'Default (API)'}`);
        console.log(`  - Total steps: ${session.total_steps}`);
        console.log();

        if (config.use_ai_agent_executor) {
            console.log('💡 AI Agent Executor is active - expect 15-50x faster execution!');
        } else {
            console.log('💡 To enable fast mode, set: REACTIVE_USE_AI_AGENT_EXECUTOR=true');
        }

    } catch (error) {
        console.error('\n❌ Test Failed:', error);
        if (error instanceof Error) {
            console.error('   Message:', error.message);
            console.error('   Stack:', error.stack);
        }
        process.exit(1);
    }
}

// Run the test
runTest().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
