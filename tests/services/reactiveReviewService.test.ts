/**
 * Unit tests for ReactiveReviewService
 *
 * Tests session management, cleanup functionality, memory management, and plan persistence.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { ReactiveReviewService } from '../../src/reactive/ReactiveReviewService.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import { PlanningService } from '../../src/mcp/services/planningService.js';
import { ExecutionTrackingService } from '../../src/mcp/services/executionTrackingService.js';
import { PlanPersistenceService } from '../../src/mcp/services/planPersistenceService.js';
import { PRMetadata, ReviewSession } from '../../src/reactive/index.js';

describe('ReactiveReviewService', () => {
  let service: ReactiveReviewService;
  let mockContextClient: jest.Mocked<ContextServiceClient>;
  let mockPlanningService: jest.Mocked<PlanningService>;
  let mockExecutionService: jest.Mocked<ExecutionTrackingService>;
  let mockPersistenceService: jest.Mocked<PlanPersistenceService>;

  // Default TTL from config is 1 hour (3600000ms), max_sessions is 100
  // For testing, we'll manipulate the timestamps directly

  // Helper to create mock PR metadata
  const createMockPRMetadata = (commitHash: string = 'abc123'): PRMetadata => ({
    commit_hash: commitHash,
    base_ref: 'main',
    changed_files: ['src/file1.ts', 'src/file2.ts'],
    lines_added: 100,
    lines_removed: 50,
  });

  // Helper to create a complete mock session
  // Valid ReviewSessionStatus values: 'initializing' | 'analyzing' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled'
  const createMockSession = (sessionId: string, status: 'executing' | 'completed' | 'failed' | 'cancelled', commitHash?: string): ReviewSession => ({
    session_id: sessionId,
    plan_id: `plan-${sessionId}`,
    status,
    pr_metadata: createMockPRMetadata(commitHash || `commit-${sessionId}`),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  beforeEach(() => {
    // Create minimal mocks - we only need to test cleanup logic
    mockContextClient = {
      getWorkspaceRoot: jest.fn(() => '/test/workspace'),
      getWorkspacePath: jest.fn(() => '/test/workspace'),
      disableCommitCache: jest.fn(),
      getCacheStats: jest.fn(() => ({ hitRate: 0.5, size: 10, commitKeyed: false, currentCommit: null })),
      searchAndAsk: jest.fn(async () =>
        JSON.stringify({
          findings: [],
          overall_correctness: 'correct',
          overall_explanation: 'No issues found.',
          overall_confidence_score: 0.9,
        })
      ),
    } as unknown as jest.Mocked<ContextServiceClient>;

    mockPlanningService = {} as unknown as jest.Mocked<PlanningService>;
    mockExecutionService = {
      getExecutionState: jest.fn(() => ({ status: 'running' })), // Return a valid execution state
      getProgress: jest.fn(() => ({ completed_steps: 0, total_steps: 5, percentage: 0 })), // Return mock progress
      abortPlanExecution: jest.fn(),
    } as unknown as jest.Mocked<ExecutionTrackingService>;

    // Mock persistence service for plan recovery tests
    mockPersistenceService = {
      savePlan: jest.fn(() => Promise.resolve({ success: true, plan_id: 'test-plan' })),
      loadPlan: jest.fn(() => Promise.resolve(null)), // Default: plan not found on disk
      listPlans: jest.fn(() => Promise.resolve([])),
      deletePlan: jest.fn(() => Promise.resolve({ success: true })),
    } as unknown as jest.Mocked<PlanPersistenceService>;

    service = new ReactiveReviewService(
      mockContextClient,
      mockPlanningService,
      mockExecutionService,
      mockPersistenceService
    );
  });

  afterEach(() => {
    // Clean up timers
    service.stopCleanupTimer();
  });

  // ==========================================================================
  // Memory Management & Cleanup Tests
  // ==========================================================================

  describe('Memory Management - Session Cleanup', () => {
    describe('getSessionCount', () => {
      it('should return 0 total initially', () => {
        // getSessionCount returns {total, active, terminal}
        expect(service.getSessionCount().total).toBe(0);
      });
    });

    describe('stopCleanupTimer', () => {
      it('should stop the cleanup timer without errors', () => {
        expect(() => service.stopCleanupTimer()).not.toThrow();
      });

      it('should be safe to call multiple times', () => {
        service.stopCleanupTimer();
        service.stopCleanupTimer();
        service.stopCleanupTimer();
        expect(true).toBe(true); // No errors
      });
    });

    describe('cleanupExpiredSessions', () => {
      it('should return 0 when no sessions exist', () => {
        const cleaned = service.cleanupExpiredSessions();
        expect(cleaned).toBe(0);
      });

      it('should not clean up active (non-terminal) sessions', () => {
        // Manually add a session in 'executing' state (active, non-terminal)
        const serviceAny = service as any;
        const sessionId = 'test-session-1';
        const mockSession = createMockSession(sessionId, 'executing');
        serviceAny.sessions.set(sessionId, mockSession);
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - 1000000); // Old session
        serviceAny.sessionLastActivity.set(sessionId, Date.now()); // Recent activity (not a zombie)
        // Set up the plan to prevent zombie detection
        serviceAny.sessionPlans.set(sessionId, { id: mockSession.plan_id, steps: [] });

        expect(service.getSessionCount().total).toBe(1);
        const cleaned = service.cleanupExpiredSessions();
        expect(cleaned).toBe(0); // Should not clean active sessions
        expect(service.getSessionCount().total).toBe(1);
      });

      it('should clean up completed sessions older than TTL', () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-completed';

        // Add a completed session with timestamp older than TTL (1 hour = 3600000ms)
        serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'completed'));
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - (2 * 60 * 60 * 1000)); // 2 hours ago

        const cleaned = service.cleanupExpiredSessions();
        expect(cleaned).toBe(1);
        expect(service.getSessionCount().total).toBe(0);
      });

      it('should clean up failed sessions older than TTL', () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-failed';

        // Set timestamp older than TTL (1 hour)
        serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'failed'));
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - (2 * 60 * 60 * 1000)); // 2 hours ago

        const cleaned = service.cleanupExpiredSessions();
        expect(cleaned).toBe(1);
      });

      it('should clean up cancelled sessions older than TTL', () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-cancelled';

        // Set timestamp older than TTL (1 hour)
        serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'cancelled'));
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - (2 * 60 * 60 * 1000)); // 2 hours ago

        const cleaned = service.cleanupExpiredSessions();
        expect(cleaned).toBe(1);
      });

      it('should enforce max_sessions limit with LRU eviction', () => {
        const serviceAny = service as any;
        const MAX_SESSIONS = 100; // Actual config value

        // Create more sessions than max_sessions
        for (let i = 0; i < MAX_SESSIONS + 3; i++) {
          const sessionId = `session-${i}`;
          serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'completed', `commit-${i}`));
          // Stagger start times so we know which are oldest
          serviceAny.sessionStartTimes.set(sessionId, Date.now() - (MAX_SESSIONS + 3 - i) * 1000);
        }

        expect(service.getSessionCount().total).toBe(MAX_SESSIONS + 3);

        // Trigger cleanup
        const cleaned = service.cleanupExpiredSessions();

        // Should have evicted sessions to get under max
        expect(cleaned).toBeGreaterThan(0);
        expect(service.getSessionCount().total).toBeLessThanOrEqual(MAX_SESSIONS);
      });

      it('should evict oldest terminal sessions first', () => {
        const serviceAny = service as any;
        const MAX_SESSIONS = 100; // Actual config value
        const now = Date.now();

        // Create sessions with known timestamps - all within TTL (less than 1 hour old)
        // but staggered so we can verify LRU eviction order
        for (let i = 0; i < MAX_SESSIONS + 2; i++) {
          const sessionId = `session-${i}`;
          serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'completed', `commit-${i}`));
          // Older sessions have smaller timestamps, but all within TTL
          // Session 0 is oldest (30 min ago), session 101 is newest (just now)
          serviceAny.sessionStartTimes.set(sessionId, now - (30 * 60 * 1000) + (i * 1000));
        }

        service.cleanupExpiredSessions();

        // Since all sessions are within TTL, only max_sessions limit applies
        // Should have evicted 2 oldest sessions to get to 100
        const remainingSessions = Array.from(serviceAny.sessions.keys());
        expect(remainingSessions.length).toBe(MAX_SESSIONS);

        // Newest sessions should remain
        expect(remainingSessions).toContain(`session-${MAX_SESSIONS + 1}`);
        expect(remainingSessions).toContain(`session-${MAX_SESSIONS}`);

        // Oldest sessions should be evicted
        expect(remainingSessions).not.toContain('session-0');
        expect(remainingSessions).not.toContain('session-1');
      });

      it('should clean up all associated data when removing sessions', () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-data';

        // Set up session with all associated data, with timestamp older than TTL
        serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'completed'));
        serviceAny.sessionPlans.set(sessionId, { id: 'plan-1' });
        serviceAny.sessionFindings.set(sessionId, 5);
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - (2 * 60 * 60 * 1000)); // 2 hours ago
        serviceAny.sessionTokensUsed.set(sessionId, 1000);
        serviceAny.sessionLastActivity.set(sessionId, Date.now() - (2 * 60 * 60 * 1000)); // 2 hours ago

        service.cleanupExpiredSessions();

        // All associated data should be cleaned
        expect(serviceAny.sessions.has(sessionId)).toBe(false);
        expect(serviceAny.sessionPlans.has(sessionId)).toBe(false);
        expect(serviceAny.sessionFindings.has(sessionId)).toBe(false);
        expect(serviceAny.sessionStartTimes.has(sessionId)).toBe(false);
        expect(serviceAny.sessionTokensUsed.has(sessionId)).toBe(false);
        expect(serviceAny.sessionLastActivity.has(sessionId)).toBe(false);
      });

      it('should preserve active sessions when evicting for max_sessions', () => {
        const serviceAny = service as any;
        const MAX_SESSIONS = 100; // Actual config value

        // Create some active (non-terminal) sessions using 'executing' status
        for (let i = 0; i < 3; i++) {
          const sessionId = `active-session-${i}`;
          const mockSession = createMockSession(sessionId, 'executing', `active-commit-${i}`);
          serviceAny.sessions.set(sessionId, mockSession);
          serviceAny.sessionStartTimes.set(sessionId, 1000 + i);
          serviceAny.sessionLastActivity.set(sessionId, Date.now()); // Recent activity (not a zombie)
          // Set up the plan to prevent zombie detection
          serviceAny.sessionPlans.set(sessionId, { id: mockSession.plan_id, steps: [] });
        }

        // Create terminal sessions to exceed max
        for (let i = 0; i < MAX_SESSIONS; i++) {
          const sessionId = `terminal-session-${i}`;
          serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'completed', `terminal-commit-${i}`));
          serviceAny.sessionStartTimes.set(sessionId, 2000 + i);
        }

        expect(service.getSessionCount().total).toBe(103); // 3 active + 100 terminal

        service.cleanupExpiredSessions();

        // Active sessions should be preserved
        expect(serviceAny.sessions.has('active-session-0')).toBe(true);
        expect(serviceAny.sessions.has('active-session-1')).toBe(true);
        expect(serviceAny.sessions.has('active-session-2')).toBe(true);
      });
    });

    describe('Plan Persistence and Recovery', () => {
      it('should not mark session as zombie when persistence service can recover plan', () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-recoverable';
        const mockSession = createMockSession(sessionId, 'executing');

        // Session has plan_id but NO plan in sessionPlans (simulating memory eviction)
        serviceAny.sessions.set(sessionId, mockSession);
        serviceAny.sessionStartTimes.set(sessionId, Date.now());
        serviceAny.sessionLastActivity.set(sessionId, Date.now());
        // Intentionally NOT setting sessionPlans - plan is "missing" from memory

        // With persistence service available, isZombieSession should return false
        // (it defers to async recovery)
        const isZombie = serviceAny.isZombieSession(sessionId, mockSession);
        expect(isZombie).toBe(false); // Should not be zombie - persistence service can try recovery
      });

      it('should recover plan from disk in getReviewStatusAsync', async () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-async-recovery';
        const mockSession = createMockSession(sessionId, 'executing');
        const mockPlan = { id: mockSession.plan_id, steps: [], goal: 'Test goal' };

        // Session exists but plan is not in memory
        serviceAny.sessions.set(sessionId, mockSession);
        serviceAny.sessionStartTimes.set(sessionId, Date.now());
        serviceAny.sessionLastActivity.set(sessionId, Date.now());

        // Mock persistence service to return the plan
        mockPersistenceService.loadPlan.mockResolvedValueOnce(mockPlan as any);

        // Call getReviewStatusAsync - should recover plan from disk
        const status = await service.getReviewStatusAsync(sessionId);

        // Verify loadPlan was called
        expect(mockPersistenceService.loadPlan).toHaveBeenCalledWith(mockSession.plan_id);

        // Session should NOT be marked as failed (plan was recovered)
        expect(status?.session.status).toBe('executing');

        // Plan should now be in memory
        expect(serviceAny.sessionPlans.has(sessionId)).toBe(true);
        expect(serviceAny.sessionPlans.get(sessionId)).toEqual(mockPlan);
      });

      it('should mark session as zombie in getReviewStatusAsync when plan not recoverable', async () => {
        const serviceAny = service as any;
        const sessionId = 'test-session-not-recoverable';
        const mockSession = createMockSession(sessionId, 'executing');

        // Session exists but plan is not in memory
        serviceAny.sessions.set(sessionId, mockSession);
        serviceAny.sessionStartTimes.set(sessionId, Date.now());
        serviceAny.sessionLastActivity.set(sessionId, Date.now());

        // Mock persistence service to return null (plan not found on disk)
        mockPersistenceService.loadPlan.mockResolvedValueOnce(null);

        // Call getReviewStatusAsync
        const status = await service.getReviewStatusAsync(sessionId);

        // Verify loadPlan was called
        expect(mockPersistenceService.loadPlan).toHaveBeenCalledWith(mockSession.plan_id);

        // Session should be marked as failed (zombie)
        expect(status?.session.status).toBe('failed');
        expect(status?.session.error).toContain('orphaned');
      });

      it('should set persistence service via setPersistenceService', () => {
        const serviceAny = service as any;

        // Create service without persistence
        const serviceNoPersistence = new ReactiveReviewService(
          mockContextClient,
          mockPlanningService,
          mockExecutionService
        );

        // Verify no persistence service
        expect((serviceNoPersistence as any).persistenceService).toBeNull();

        // Set persistence service
        serviceNoPersistence.setPersistenceService(mockPersistenceService);

        // Verify persistence service is set
        expect((serviceNoPersistence as any).persistenceService).toBe(mockPersistenceService);

        // Cleanup
        serviceNoPersistence.stopCleanupTimer();
      });
    });

    describe('Step diff generation', () => {
      it('uses a real git diff for review steps instead of placeholder content', async () => {
        const serviceAny = service as any;
        const sessionId = 'step-diff-session';
        const planId = 'plan-step-diff';
        const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reactive-review-step-'));
        const trackedFile = path.join(tempRepo, 'src', 'file1.ts');
        fs.mkdirSync(path.dirname(trackedFile), { recursive: true });

        execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: tempRepo, stdio: 'ignore' });

        fs.writeFileSync(trackedFile, 'export const value = "old";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempRepo, stdio: 'ignore' });
        const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        fs.writeFileSync(trackedFile, 'export const value = "new";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'update'], { cwd: tempRepo, stdio: 'ignore' });
        const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        mockContextClient.getWorkspacePath.mockReturnValue(tempRepo);
        const prMetadata: PRMetadata = {
          ...createMockPRMetadata(headCommit),
          base_ref: baseCommit,
          changed_files: ['src/file1.ts'],
        };

        serviceAny.sessionPlans.set(sessionId, {
          id: planId,
          steps: [
            {
              step_number: 1,
              files_to_modify: [{ path: 'src/file1.ts' }],
            },
          ],
        });

        const executor = serviceAny.createDefaultStepExecutor(sessionId, prMetadata);
        const result = await executor(planId, 1);

        expect(result).toEqual({ success: true, files_modified: ['src/file1.ts'] });
        expect(mockContextClient.searchAndAsk).toHaveBeenCalled();
        expect(mockContextClient.searchAndAsk.mock.calls[0]?.[1]).toContain('diff --git a/src/file1.ts b/src/file1.ts');
        expect(mockContextClient.searchAndAsk.mock.calls[0]?.[1]).toContain('-export const value = "old";');
        expect(mockContextClient.searchAndAsk.mock.calls[0]?.[1]).toContain('+export const value = "new";');
        expect(mockContextClient.searchAndAsk.mock.calls[0]?.[1]).not.toContain('Placeholder for actual file content');

        fs.rmSync(tempRepo, { recursive: true, force: true });
      });

      it('fails closed when step file scope excludes all diff content', async () => {
        const serviceAny = service as any;
        const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reactive-review-step-empty-'));
        const trackedFile = path.join(tempRepo, 'src', 'file1.ts');
        fs.mkdirSync(path.dirname(trackedFile), { recursive: true });

        execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: tempRepo, stdio: 'ignore' });

        fs.writeFileSync(trackedFile, 'export const value = "old";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempRepo, stdio: 'ignore' });
        const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        fs.writeFileSync(trackedFile, 'export const value = "new";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'update'], { cwd: tempRepo, stdio: 'ignore' });
        const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        mockContextClient.getWorkspacePath.mockReturnValue(tempRepo);
        const prMetadata: PRMetadata = {
          ...createMockPRMetadata(headCommit),
          base_ref: baseCommit,
          changed_files: ['src/file1.ts'],
        };

        const result = await serviceAny.buildStepDiff(['tests/file1.test.ts'], prMetadata);

        expect(result.diff).toBe('');
        expect(result.changed_files).toEqual([]);
        expect(result.scope_empty_reason).toBe('path_scope_excluded_all_changes');
        expect(mockContextClient.searchAndAsk).not.toHaveBeenCalled();

        fs.rmSync(tempRepo, { recursive: true, force: true });
      });

      it('builds step diffs against the full PR range instead of only the head commit', async () => {
        const serviceAny = service as any;
        const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reactive-review-step-range-'));
        const fileOne = path.join(tempRepo, 'src', 'file1.ts');
        const fileTwo = path.join(tempRepo, 'src', 'file2.ts');
        fs.mkdirSync(path.dirname(fileOne), { recursive: true });

        execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: tempRepo, stdio: 'ignore' });

        fs.writeFileSync(fileOne, 'export const value1 = "old";\n');
        fs.writeFileSync(fileTwo, 'export const value2 = "old";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempRepo, stdio: 'ignore' });
        const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        fs.writeFileSync(fileOne, 'export const value1 = "mid";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'update file1'], { cwd: tempRepo, stdio: 'ignore' });

        fs.writeFileSync(fileTwo, 'export const value2 = "new";\n');
        execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'update file2'], { cwd: tempRepo, stdio: 'ignore' });
        const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tempRepo,
          encoding: 'utf8',
        }).trim();

        mockContextClient.getWorkspacePath.mockReturnValue(tempRepo);
        const prMetadata: PRMetadata = {
          ...createMockPRMetadata(headCommit),
          base_ref: baseCommit,
          changed_files: ['src/file1.ts', 'src/file2.ts'],
        };

        const result = await serviceAny.buildStepDiff(['src/file1.ts'], prMetadata);

        expect(result.changed_files).toEqual(['src/file1.ts']);
        expect(result.diff).toContain('diff --git a/src/file1.ts b/src/file1.ts');
        expect(result.diff).toContain('-export const value1 = "old";');
        expect(result.diff).toContain('+export const value1 = "mid";');
        expect(result.diff).not.toContain('file2.ts');

        fs.rmSync(tempRepo, { recursive: true, force: true });
      });
    });
  });
});
