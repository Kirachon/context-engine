/**
 * Unit tests for lifecycle tools
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  handleReindexWorkspace,
  handleClearIndex,
  reindexWorkspaceTool,
  clearIndexTool,
} from '../../src/mcp/tools/lifecycle.js';
import { IndexResult, IndexStatus } from '../../src/mcp/serviceClient.js';

describe('lifecycle Tools', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const result: IndexResult = {
      indexed: 10,
      skipped: 1,
      errors: [],
      duration: 100,
    };
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
    };

    mockServiceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>().mockResolvedValue(result),
      getIndexStatus: jest.fn().mockReturnValue(status),
    };
  });

  it('should clear index', async () => {
    const result = await handleClearIndex({}, mockServiceClient as any);
    expect(mockServiceClient.clearIndex).toHaveBeenCalled();
    expect(result).toContain('Index cleared');
    expect(result).toContain('"freshness"');
  });

  it('should reindex workspace after clearing', async () => {
    const result = await handleReindexWorkspace({}, mockServiceClient as any);

    expect(mockServiceClient.clearIndex).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.indexWorkspace).toHaveBeenCalledTimes(1);
    expect(result).toContain('"indexed": 10');
    expect(result).toContain('"freshness"');
  });

  it('should return unindexed freshness metadata after clear_index', async () => {
    const unindexedStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    };
    mockServiceClient.getIndexStatus.mockReturnValue(unindexedStatus);

    const result = await handleClearIndex({}, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.freshness).toBe('unindexed');
    expect(payload.is_stale).toBe(true);
    expect(payload.last_indexed).toBeNull();
    expect(Array.isArray(payload.freshness_guidance)).toBe(true);
  });

  it('should report stale freshness metadata when index remains stale after reindex', async () => {
    const staleStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-01T00:00:00.000Z',
      fileCount: 42,
      isStale: true,
    };
    mockServiceClient.getIndexStatus.mockReturnValue(staleStatus);

    const result = await handleReindexWorkspace({}, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.freshness).toBe('stale');
    expect(payload.freshness_message).toContain('stale');
    expect(Array.isArray(payload.freshness_guidance)).toBe(true);
  });

  it('should report error freshness metadata when index status is unhealthy', async () => {
    const errorStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'error',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: true,
      lastError: 'Index worker exited with code 1',
    };
    mockServiceClient.getIndexStatus.mockReturnValue(errorStatus);

    const result = await handleReindexWorkspace({}, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.freshness).toBe('error');
    expect(payload.last_error).toBe('Index worker exited with code 1');
    expect(payload.freshness_guidance).toEqual(
      expect.arrayContaining([expect.stringContaining('reindex_workspace')])
    );
  });

  it('should expose tool schemas', () => {
    expect(reindexWorkspaceTool.name).toBe('reindex_workspace');
    expect(clearIndexTool.name).toBe('clear_index');
  });
});
