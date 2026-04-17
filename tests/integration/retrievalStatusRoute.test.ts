import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';

type MockServiceClient = {
  getIndexStatus: ReturnType<typeof jest.fn>;
  indexWorkspace: ReturnType<typeof jest.fn>;
  semanticSearch: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
  getFile: ReturnType<typeof jest.fn>;
  clearCache: ReturnType<typeof jest.fn>;
  getWorkspacePath: ReturnType<typeof jest.fn>;
};

function createMockServiceClient(): MockServiceClient {
  return {
    getIndexStatus: jest.fn(() => ({
      workspace: process.cwd(),
      lastIndexed: '2026-04-10T00:00:00.000Z',
      fileCount: 1,
      isStale: false,
    })),
    indexWorkspace: jest.fn(async () => ({ filesIndexed: 0, chunksCreated: 0 })),
    semanticSearch: jest.fn(async () => []),
    getContextForPrompt: jest.fn(async () => ({ query: '', files: [], metadata: {} })),
    getFile: jest.fn(async () => ''),
    clearCache: jest.fn(),
    getWorkspacePath: jest.fn(() => process.cwd()),
  };
}

describe('GET /api/v1/retrieval/status', () => {
  it('returns 200 with the expected JSON shape including hashFallbackActive and downgrade', async () => {
    const server = new ContextEngineHttpServer(createMockServiceClient() as never, {
      port: 0,
      version: '9.9.9',
    });
    const app = server.getApp();

    const response = await request(app).get('/api/v1/retrieval/status');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: expect.any(String),
        configured: expect.objectContaining({
          id: expect.any(String),
          modelId: expect.any(String),
          vectorDimension: expect.any(Number),
        }),
        active: expect.objectContaining({
          id: expect.any(String),
          modelId: expect.any(String),
          vectorDimension: expect.any(Number),
        }),
        hashFallbackActive: expect.any(Boolean),
        loadFailures: expect.any(Number),
      }),
    );
    expect(response.body).toHaveProperty('downgrade');
    expect(response.body).toHaveProperty('lastFailure');
    expect(response.body).toHaveProperty('lastFailureAt');
    expect(response.body).toHaveProperty('nextRetryAt');
    // downgrade is either null or { reason, since }
    if (response.body.downgrade !== null) {
      expect(response.body.downgrade).toEqual(
        expect.objectContaining({
          reason: expect.any(String),
          since: expect.anything(),
        }),
      );
      // Reason must be a stable category code, not a raw internal message.
      expect(response.body.downgrade.reason).toMatch(
        /^(active_runtime_mismatch|runtime_unavailable|awaiting_retry|runtime_degraded)$/,
      );
    }
    // lastFailure must never echo raw error text over HTTP.
    if (response.body.lastFailure !== null) {
      expect(response.body.lastFailure).toBe('runtime_error');
    }
  });
});
