/**
 * Unit tests for index_status tool
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  buildIndexStatusStructuredContent,
  handleIndexStatus,
  indexStatusTool,
} from '../../src/mcp/tools/status.js';
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

    expect(result.content[0].text).toContain('# 🩺 Index Status');
    expect(result.content[0].text).toContain('**Workspace**');
    expect(result.content[0].text).toContain('**Status**');
    expect(result.content[0].text).toContain('42');
    expect(result.content[0].text).toContain('**Freshness**');
    expect(result.structuredContent).toEqual(buildIndexStatusStructuredContent(mockServiceClient.getIndexStatus()));
  });

  it('should build structured content for healthy status', () => {
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
    };

    expect(buildIndexStatusStructuredContent(status)).toEqual({
      schema_version: 1,
      status: {
        workspace: '/tmp/workspace',
        state: 'idle',
        lastIndexed: '2025-01-11T00:00:00.000Z',
        fileCount: 42,
        isStale: false,
        lastError: null,
      },
      freshness: {
        code: 'healthy',
        severity: 'ok',
        summary: 'Index is healthy and up to date.',
      },
      guidance: [],
      embeddingRuntime: null,
    });
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

    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('## Freshness Guidance');
    expect(result.content[0].text).toContain('index_workspace');

    const structured = buildIndexStatusStructuredContent(staleStatus);
    expect(structured.freshness.code).toBe('stale');
    expect(structured.guidance).toEqual(expect.arrayContaining([expect.stringContaining('index_workspace')]));
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

    expect(result.content[0].text).toContain('unindexed');
    expect(result.content[0].text).toContain('Index has not been built yet');
    expect(result.content[0].text).toContain('index_workspace');

    const structured = buildIndexStatusStructuredContent(unindexedStatus);
    expect(structured.status.lastIndexed).toBeNull();
    expect(structured.freshness.code).toBe('unindexed');
    expect(structured.guidance).toEqual(expect.arrayContaining([expect.stringContaining('index_workspace')]));
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

    expect(result.content[0].text).toContain('⚠️ error');
    expect(result.content[0].text).toContain('Index is unhealthy due to an indexing error.');
    expect(result.content[0].text).toContain('reindex_workspace');
    expect(result.content[0].text).toContain('Index worker exited with code 1');

    const structured = buildIndexStatusStructuredContent(errorStatus);
    expect(structured.status.lastError).toBe('Index worker exited with code 1');
    expect(structured.freshness.code).toBe('error');
    expect(structured.guidance).toEqual(expect.arrayContaining([expect.stringContaining('reindex_workspace')]));
  });

  it('should surface degraded embedding runtime details', async () => {
    const degradedStatus: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
      embeddingRuntime: {
        state: 'degraded',
        configured: {
          id: 'transformers:Xenova/all-MiniLM-L6-v2',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          vectorDimension: 384,
        },
        active: {
          id: 'hash-32',
          modelId: 'hash-32',
          vectorDimension: 32,
        },
        fallback: {
          id: 'hash-32',
          modelId: 'hash-32',
          vectorDimension: 32,
        },
        loadFailures: 2,
        lastFailure: 'model unavailable',
        nextRetryAt: '2025-01-11T00:01:00.000Z',
        hashFallbackActive: true,
        downgrade: {
          reason: 'active runtime "hash-32" differs from configured "transformers:Xenova/all-MiniLM-L6-v2"',
          since: null,
        },
      },
    };
    mockServiceClient.getIndexStatus.mockReturnValue(degradedStatus);

    const result = await handleIndexStatus({}, mockServiceClient as any);

    expect(result.content[0].text).toContain('**Embedding Runtime**');
    expect(result.content[0].text).toContain('degraded');
    expect(result.content[0].text).toContain('hash-32');
    expect(result.content[0].text).toContain('model unavailable');
    expect(result.content[0].text).toContain('2025-01-11T00:01:00.000Z');
    expect(result.content[0].text).toContain('Embedding Load Failures');

    const structured = buildIndexStatusStructuredContent(degradedStatus);
    expect(structured.embeddingRuntime).toEqual(
      expect.objectContaining({
        state: 'degraded',
        active: expect.objectContaining({ id: 'hash-32' }),
        configured: expect.objectContaining({ id: 'transformers:Xenova/all-MiniLM-L6-v2' }),
        fallback: expect.objectContaining({ id: 'hash-32' }),
        lastFailure: 'model unavailable',
        nextRetryAt: '2025-01-11T00:01:00.000Z',
        loadFailures: 2,
        hashFallbackActive: true,
      })
    );
  });

  it('should omit uninitialized embedding runtime from structured content', () => {
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
      embeddingRuntime: {
        state: 'uninitialized',
        configured: {
          id: 'transformers:Xenova/all-MiniLM-L6-v2',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          vectorDimension: 384,
        },
        active: {
          id: 'transformers:Xenova/all-MiniLM-L6-v2',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          vectorDimension: 384,
        },
      } as IndexStatus['embeddingRuntime'],
    };

    expect(buildIndexStatusStructuredContent(status).embeddingRuntime).toBeNull();
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

    expect(result.content[0].text).toContain('| **Freshness** | ✅ healthy |');
    expect(result.content[0].text).not.toContain('unindexed');
    expect(result.content[0].text).not.toContain('Index has not been built yet');
  });

  it('should expose tool schema', () => {
    expect(indexStatusTool.name).toBe('index_status');
    expect(indexStatusTool.inputSchema).toBeDefined();
  });
});
