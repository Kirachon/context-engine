import { describe, expect, it } from '@jest/globals';
import {
  evaluateIndexFreshness,
  evaluateStartupAutoIndex,
} from '../../src/mcp/tooling/indexFreshness.js';
import type { IndexStatus } from '../../src/mcp/serviceClient.js';

function createStatus(partial?: Partial<IndexStatus>): IndexStatus {
  return {
    workspace: '/tmp/workspace',
    status: 'idle',
    lastIndexed: '2026-03-22T00:00:00.000Z',
    fileCount: 10,
    isStale: false,
    ...partial,
  };
}

describe('indexFreshness helpers', () => {
  it('classifies healthy status correctly', () => {
    const freshness = evaluateIndexFreshness(createStatus());

    expect(freshness.code).toBe('healthy');
    expect(freshness.severity).toBe('ok');
  });

  it('classifies unindexed status correctly', () => {
    const freshness = evaluateIndexFreshness(createStatus({
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    }));

    expect(freshness.code).toBe('unindexed');
  });

  it('classifies stale status correctly', () => {
    const freshness = evaluateIndexFreshness(createStatus({
      isStale: true,
    }));

    expect(freshness.code).toBe('stale');
  });

  it('classifies indexing status correctly', () => {
    const freshness = evaluateIndexFreshness(createStatus({
      status: 'indexing',
    }));

    expect(freshness.code).toBe('indexing');
  });

  it('classifies error status correctly', () => {
    const freshness = evaluateIndexFreshness(createStatus({
      status: 'error',
      isStale: true,
      lastError: 'worker failed',
    }));

    expect(freshness.code).toBe('error');
  });

  it('starts startup auto-index for unindexed workspaces', () => {
    const decision = evaluateStartupAutoIndex(createStatus({
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    }));

    expect(decision.shouldAutoIndex).toBe(true);
    expect(decision.freshness.code).toBe('unindexed');
  });

  it('starts startup auto-index for stale workspaces', () => {
    const decision = evaluateStartupAutoIndex(createStatus({
      isStale: true,
    }));

    expect(decision.shouldAutoIndex).toBe(true);
    expect(decision.freshness.code).toBe('stale');
  });

  it('skips startup auto-index for healthy, indexing, and error states', () => {
    const healthy = evaluateStartupAutoIndex(createStatus());
    const indexing = evaluateStartupAutoIndex(createStatus({ status: 'indexing' }));
    const error = evaluateStartupAutoIndex(createStatus({ status: 'error', lastError: 'boom' }));

    expect(healthy.shouldAutoIndex).toBe(false);
    expect(indexing.shouldAutoIndex).toBe(false);
    expect(error.shouldAutoIndex).toBe(false);
  });
});
