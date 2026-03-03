/**
 * Unit tests for index_status tool
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { handleIndexStatus, indexStatusTool } from '../../src/mcp/tools/status.js';
import { IndexStatus } from '../../src/mcp/serviceClient.js';

describe('index_status Tool', () => {
  let mockServiceClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
    };

    mockServiceClient = {
      getIndexStatus: jest.fn().mockReturnValue(status),
    };
  });

  it('should render status markdown', async () => {
    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result).toContain('# 🩺 Index Status');
    expect(result).toContain('**Workspace**');
    expect(result).toContain('**Status**');
    expect(result).toContain('42');
    expect(result).toContain('**Freshness**');
  });

  it('should surface stale index guidance', async () => {
    const staleStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-10T00:00:00.000Z',
      fileCount: 42,
      isStale: true,
    };
    mockServiceClient.getIndexStatus.mockReturnValue(staleStatus);

    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result).toContain('stale');
    expect(result).toContain('## Freshness Guidance');
    expect(result).toContain('index_workspace');
  });

  it('should surface unindexed guidance when never indexed', async () => {
    const unindexedStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: null,
      fileCount: 0,
      isStale: true,
    };
    mockServiceClient.getIndexStatus.mockReturnValue(unindexedStatus);

    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result).toContain('unindexed');
    expect(result).toContain('Index has not been built yet');
    expect(result).toContain('index_workspace');
  });

  it('should surface error guidance for unhealthy index status', async () => {
    const errorStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'error',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: true,
      lastError: 'Index worker exited with code 1',
    };
    mockServiceClient.getIndexStatus.mockReturnValue(errorStatus);

    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result).toContain('⚠️ error');
    expect(result).toContain('Index is unhealthy due to an indexing error.');
    expect(result).toContain('reindex_workspace');
    expect(result).toContain('Index worker exited with code 1');
  });

  it('should not classify status as unindexed when lastIndexed exists but fileCount is 0', async () => {
    const restoredEmptyStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 0,
      isStale: false,
    };
    mockServiceClient.getIndexStatus.mockReturnValue(restoredEmptyStatus);

    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result).toContain('| **Freshness** | ✅ healthy |');
    expect(result).not.toContain('unindexed');
    expect(result).not.toContain('Index has not been built yet');
  });

  it('should expose tool schema', () => {
    expect(indexStatusTool.name).toBe('index_status');
    expect(indexStatusTool.inputSchema).toBeDefined();
  });
});
