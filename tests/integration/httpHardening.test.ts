import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Server } from 'node:http';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';

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
      fileCount: 12,
      isStale: false,
    })),
    indexWorkspace: jest.fn(async () => ({
      filesIndexed: 12,
      chunksCreated: 34,
    })),
    semanticSearch: jest.fn(async () => []),
    getContextForPrompt: jest.fn(async () => ({
      query: 'placeholder',
      files: [],
      metadata: {},
    })),
    getFile: jest.fn(async () => 'contents'),
    clearCache: jest.fn(),
    getWorkspacePath: jest.fn(() => process.cwd()),
  };
}

function createServer(options: HttpServerOptions = {}) {
  return new ContextEngineHttpServer(createMockServiceClient() as never, {
    port: 0,
    version: '9.9.9',
    ...options,
  });
}

function createInitializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'http-test-client',
        version: '1.0.0',
      },
    },
  };
}

function getNodeServer(instance: ContextEngineHttpServer): Server {
  return (instance as unknown as { server: Server | null }).server as Server;
}

describe('ContextEngineHttpServer hardening', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts /api/v1 payloads well below the 1mb ceiling', async () => {
    const app = createServer().getApp();

    const response = await request(app)
      .post('/api/v1/search')
      .send({ query: 'x'.repeat(200_000) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [],
      metadata: {
        query: 'x'.repeat(200_000),
        top_k: 10,
        resultCount: 0,
      },
    });
  });

  it('allows large /mcp initialize payloads without applying the API body-size ceiling', async () => {
    const app = createServer().getApp();
    const payload = createInitializePayload();
    payload.params.clientInfo.name = `client-${'x'.repeat(150_000)}`;

    const response = await request(app)
      .post('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('accept', 'application/json, text/event-stream')
      .send(payload);

    expect(response.status).toBe(200);
  });

  it('rate limits /api/v1 requests with a retry hint', async () => {
    const app = createServer().getApp();

    for (let index = 0; index < 120; index += 1) {
      const response = await request(app).get('/api/v1/status');
      expect(response.status).toBe(200);
    }

    const limitedResponse = await request(app).get('/api/v1/status');

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBeDefined();
  });

  it('adds helmet defaults on /api/v1 responses', async () => {
    const app = createServer().getApp();

    const response = await request(app).get('/api/v1/status');

    expect(response.status).toBe(200);
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('keeps relaxed helmet settings on /mcp responses', async () => {
    const app = createServer().getApp();

    const response = await request(app)
      .post('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('accept', 'application/json, text/event-stream')
      .send(createInitializePayload());

    expect(response.status).toBe(200);
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(response.headers['cross-origin-resource-policy']).toBeUndefined();
  });

  it('defaults to loopback binding with SSE-safe server timeouts', async () => {
    const server = createServer();

    try {
      await server.start();
      const nodeServer = getNodeServer(server);
      const address = nodeServer.address();

      expect(address).toEqual(
        expect.objectContaining({
          address: '127.0.0.1',
        })
      );
      expect(nodeServer.requestTimeout).toBe(0);
      expect(nodeServer.keepAliveTimeout).toBeGreaterThanOrEqual(65_000);
      expect(nodeServer.headersTimeout).toBeGreaterThanOrEqual(70_000);
    } finally {
      await server.stop();
    }
  });

  it('warns loudly when binding HTTP to 0.0.0.0', async () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });

    try {
      await server.start();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0'));
    } finally {
      await server.stop();
    }
  });

  it('sanitizes parser-style status errors instead of echoing raw messages', async () => {
    const app = createServer().getApp();

    const response = await request(app)
      .post('/api/v1/search')
      .set('content-type', 'application/json')
      .send('{"query":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Request failed',
      statusCode: 400,
    });
  });

  it('rate limits MCP session initialization attempts separately from open streams', async () => {
    const app = createServer().getApp();

    for (let index = 0; index < 120; index += 1) {
      const response = await request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .send(createInitializePayload());

      expect(response.status).toBe(200);
    }

    const limitedResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send(createInitializePayload());

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBeDefined();
  });
});
