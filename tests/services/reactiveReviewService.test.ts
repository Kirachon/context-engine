/**
 * Unit tests for ReactiveReviewService
 *
 * Tests session management, cleanup functionality, and memory management.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ReactiveReviewService } from '../../src/reactive/ReactiveReviewService.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import { PlanningService } from '../../src/mcp/services/planningService.js';
import { ExecutionTrackingService } from '../../src/mcp/services/executionTrackingService.js';
import { PRMetadata, ReviewSession } from '../../src/reactive/index.js';

describe('ReactiveReviewService', () => {
  let service: ReactiveReviewService;
  let mockContextClient: jest.Mocked<ContextServiceClient>;
  let mockPlanningService: jest.Mocked<PlanningService>;
  let mockExecutionService: jest.Mocked<ExecutionTrackingService>;

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
    } as unknown as jest.Mocked<ContextServiceClient>;

    mockPlanningService = {} as unknown as jest.Mocked<PlanningService>;
    mockExecutionService = {} as unknown as jest.Mocked<ExecutionTrackingService>;

    service = new ReactiveReviewService(
      mockContextClient,
      mockPlanningService,
      mockExecutionService
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
        serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'executing'));
        serviceAny.sessionStartTimes.set(sessionId, Date.now() - 1000000); // Old session

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

        service.cleanupExpiredSessions();

        // All associated data should be cleaned
        expect(serviceAny.sessions.has(sessionId)).toBe(false);
        expect(serviceAny.sessionPlans.has(sessionId)).toBe(false);
        expect(serviceAny.sessionFindings.has(sessionId)).toBe(false);
        expect(serviceAny.sessionStartTimes.has(sessionId)).toBe(false);
        expect(serviceAny.sessionTokensUsed.has(sessionId)).toBe(false);
      });

      it('should preserve active sessions when evicting for max_sessions', () => {
        const serviceAny = service as any;
        const MAX_SESSIONS = 100; // Actual config value

        // Create some active (non-terminal) sessions using 'executing' status
        for (let i = 0; i < 3; i++) {
          const sessionId = `active-session-${i}`;
          serviceAny.sessions.set(sessionId, createMockSession(sessionId, 'executing', `active-commit-${i}`));
          serviceAny.sessionStartTimes.set(sessionId, 1000 + i);
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
  });
});

