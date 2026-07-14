import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Server } from 'node:http';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';
import {
  assertBindTargetAuthReady,
  classifyBindHost,
  InsecureRemoteBindError,
} from '../../src/http/bindTarget.js';
import { isHttpAuthPolicyReady, parseHttpAuthTokenRegistry } from '../../src/http/authScopes.js';

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

  it('warns loudly when binding HTTP to 0.0.0.0 with a ready auth policy', async () => {
    const AUTH_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_ENABLED';
    const TOKENS_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_TOKENS';
    const previousAuthEnabled = process.env[AUTH_ENV];
    const previousTokens = process.env[TOKENS_ENV];
    process.env[AUTH_ENV] = 'true';
    process.env[TOKENS_ENV] = JSON.stringify({ 'valid-token': ['tools:read'] });

    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });

    try {
      await server.start();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0'));
    } finally {
      await server.stop();
      if (previousAuthEnabled === undefined) {
        delete process.env[AUTH_ENV];
      } else {
        process.env[AUTH_ENV] = previousAuthEnabled;
      }
      if (previousTokens === undefined) {
        delete process.env[TOKENS_ENV];
      } else {
        process.env[TOKENS_ENV] = previousTokens;
      }
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

describe('classifyBindHost', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.0.0.53', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['0.0.0.0', 'remote'],
    ['::', 'remote'],
    ['*', 'remote'],
    ['', 'remote'],
    ['   ', 'remote'],
    ['192.168.1.42', 'remote'],
    ['10.0.0.5', 'remote'],
    ['8.8.8.8', 'remote'],
    ['2001:db8::1', 'remote'],
    ['fe80::1', 'remote'],
    ['example.com', 'remote'],
    ['my-dev-machine', 'remote'],
  ] as const)('classifies %s as %s', (host, expected) => {
    expect(classifyBindHost(host)).toBe(expected);
  });

  it('treats undefined/null host as remote', () => {
    expect(classifyBindHost(undefined)).toBe('remote');
    expect(classifyBindHost(null)).toBe('remote');
  });
});

describe('assertBindTargetAuthReady', () => {
  it('never throws for loopback targets, regardless of auth readiness', () => {
    expect(() => assertBindTargetAuthReady('127.0.0.1', false)).not.toThrow();
    expect(() => assertBindTargetAuthReady('localhost', false)).not.toThrow();
    expect(() => assertBindTargetAuthReady('::1', true)).not.toThrow();
  });

  it('throws InsecureRemoteBindError for remote targets without a ready auth policy', () => {
    expect(() => assertBindTargetAuthReady('0.0.0.0', false)).toThrow(InsecureRemoteBindError);
    expect(() => assertBindTargetAuthReady('192.168.1.42', false)).toThrow(InsecureRemoteBindError);
    expect(() => assertBindTargetAuthReady('example.com', false)).toThrow(InsecureRemoteBindError);
  });

  it('allows remote targets when a ready auth policy is present', () => {
    expect(() => assertBindTargetAuthReady('0.0.0.0', true)).not.toThrow();
    expect(() => assertBindTargetAuthReady('192.168.1.42', true)).not.toThrow();
  });
});

describe('isHttpAuthPolicyReady', () => {
  const AUTH_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_ENABLED';
  const previousAuthEnabled = process.env[AUTH_ENV];

  afterEach(() => {
    if (previousAuthEnabled === undefined) {
      delete process.env[AUTH_ENV];
    } else {
      process.env[AUTH_ENV] = previousAuthEnabled;
    }
  });

  it('is not ready when auth is disabled, regardless of token registry', () => {
    delete process.env[AUTH_ENV];
    const registry = parseHttpAuthTokenRegistry(JSON.stringify({ 'valid-token': ['tools:read'] }));
    expect(isHttpAuthPolicyReady(registry)).toBe(false);
  });

  it('is not ready when auth is enabled but no tokens are configured', () => {
    process.env[AUTH_ENV] = 'true';
    const registry = parseHttpAuthTokenRegistry(undefined);
    expect(isHttpAuthPolicyReady(registry)).toBe(false);
  });

  it('is not ready when auth is enabled but only empty/whitespace tokens are configured', () => {
    process.env[AUTH_ENV] = 'true';
    const registry = parseHttpAuthTokenRegistry(JSON.stringify({ '': ['tools:read'], '   ': ['tools:write'] }));
    expect(isHttpAuthPolicyReady(registry)).toBe(false);
  });

  it('is ready when auth is enabled and at least one non-empty token is configured', () => {
    process.env[AUTH_ENV] = 'true';
    const registry = parseHttpAuthTokenRegistry(JSON.stringify({ 'valid-token': ['tools:read'] }));
    expect(isHttpAuthPolicyReady(registry)).toBe(true);
  });
});

describe('S1: fail-closed remote bind requires a ready auth policy', () => {
  const AUTH_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_ENABLED';
  const TOKENS_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_TOKENS';
  let previousAuthEnabled: string | undefined;
  let previousTokens: string | undefined;

  beforeEach(() => {
    previousAuthEnabled = process.env[AUTH_ENV];
    previousTokens = process.env[TOKENS_ENV];
    delete process.env[AUTH_ENV];
    delete process.env[TOKENS_ENV];
  });

  afterEach(() => {
    if (previousAuthEnabled === undefined) {
      delete process.env[AUTH_ENV];
    } else {
      process.env[AUTH_ENV] = previousAuthEnabled;
    }
    if (previousTokens === undefined) {
      delete process.env[TOKENS_ENV];
    } else {
      process.env[TOKENS_ENV] = previousTokens;
    }
  });

  async function expectNeverOpensSocket(server: ContextEngineHttpServer): Promise<unknown> {
    let caught: unknown;
    try {
      await server.start();
      throw new Error('Expected server.start() to reject before opening a socket');
    } catch (error) {
      caught = error;
    }
    expect(server.isRunning()).toBe(false);
    return caught;
  }

  it('rejects a wildcard IPv4 bind (0.0.0.0) with no auth policy configured', async () => {
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects a wildcard IPv6 bind (::) with no auth policy configured', async () => {
    const server = createServer({ bindHost: '::' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects a LAN IPv4 bind with no auth policy configured', async () => {
    const server = createServer({ bindHost: '192.168.1.42' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects a public IPv6 bind with no auth policy configured', async () => {
    const server = createServer({ bindHost: '2001:db8::1' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects an arbitrary hostname bind with no auth policy configured', async () => {
    const server = createServer({ bindHost: 'my-dev-machine' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects a remote bind when auth is enabled but the token registry is empty', async () => {
    process.env[AUTH_ENV] = 'true';
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('rejects a remote bind when auth is enabled with only an empty/whitespace token', async () => {
    process.env[AUTH_ENV] = 'true';
    process.env[TOKENS_ENV] = JSON.stringify({ '   ': ['tools:read'] });
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });
    const error = await expectNeverOpensSocket(server);
    expect(error).toBeInstanceOf(InsecureRemoteBindError);
  });

  it('allows a remote bind once auth is enabled with a valid, non-empty token', async () => {
    process.env[AUTH_ENV] = 'true';
    process.env[TOKENS_ENV] = JSON.stringify({ 'valid-token': ['tools:read'] });
    const server = createServer({ bindHost: '0.0.0.0' } as HttpServerOptions & { bindHost: string });

    try {
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isRunning()).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('allows a caller-supplied auth hook to satisfy the remote-bind readiness requirement', async () => {
    const server = createServer({
      bindHost: '0.0.0.0',
      authHook: () => ({ authorized: true }),
    } as HttpServerOptions & { bindHost: string });

    try {
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isRunning()).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('always allows loopback binds regardless of auth policy readiness', async () => {
    const noAuthServer = createServer({ bindHost: '127.0.0.1' });
    try {
      await expect(noAuthServer.start()).resolves.toBeUndefined();
    } finally {
      await noAuthServer.stop();
    }

    const ipv6LoopbackServer = createServer({ bindHost: '::1' });
    try {
      await expect(ipv6LoopbackServer.start()).resolves.toBeUndefined();
    } finally {
      await ipv6LoopbackServer.stop();
    }

    const localhostServer = createServer({ bindHost: 'localhost' });
    try {
      await expect(localhostServer.start()).resolves.toBeUndefined();
    } finally {
      await localhostServer.stop();
    }
  });
});
