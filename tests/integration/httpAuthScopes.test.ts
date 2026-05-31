import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';
import { HTTP_AUTH_SCOPES } from '../../src/http/authScopes.js';

type MockServiceClient = {
  getIndexStatus: ReturnType<typeof jest.fn>;
  indexWorkspace: ReturnType<typeof jest.fn>;
  semanticSearch: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
  getFile: ReturnType<typeof jest.fn>;
  clearCache: ReturnType<typeof jest.fn>;
  getWorkspacePath: ReturnType<typeof jest.fn>;
};

const AUTH_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_ENABLED';
const TOKENS_ENV = 'CONTEXT_ENGINE_HTTP_AUTH_TOKENS';

const TEST_TOKENS = {
  reader: ['tools:read', 'resources:read'],
  writer: ['tools:read', 'tools:write'],
  canceller: ['tools:read', 'tasks:cancel'],
} as const;

function createMockServiceClient(): MockServiceClient {
  return {
    getIndexStatus: jest.fn(() => ({
      workspace: '/tmp/workspace',
      status: 'idle',
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

function createApp(
  serviceClient = createMockServiceClient(),
  options: HttpServerOptions = {}
) {
  const server = new ContextEngineHttpServer(serviceClient as never, {
    port: 0,
    version: '9.9.9',
    ...options,
  });

  return {
    app: server.getApp(),
    serviceClient,
  };
}

function parseSseJsonPayload(text: string): Record<string, unknown> {
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '));

  if (!dataLine) {
    throw new Error(`Missing SSE data payload: ${text}`);
  }

  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function initializeMcpSession(
  app: ReturnType<typeof createApp>['app'],
  authorization?: string
): Promise<string> {
  const initializeRequest = request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream');

  if (authorization) {
    initializeRequest.set('authorization', authorization);
  }

  const initializeResponse = await initializeRequest.send({
    jsonrpc: '2.0',
    id: 900,
    method: 'initialize',
    params: {
      protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'http-auth-test-client',
        version: '1.0.0',
      },
    },
  });

  expect(initializeResponse.status).toBe(200);
  const sessionId = initializeResponse.headers['mcp-session-id'];
  expect(typeof sessionId).toBe('string');

  const initializedRequest = request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId as string);

  if (authorization) {
    initializedRequest.set('authorization', authorization);
  }

  const initializedResponse = await initializedRequest.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  expect([200, 202, 204]).toContain(initializedResponse.status);
  return sessionId as string;
}

describe('HTTP auth scopes', () => {
  const previousAuthEnabled = process.env[AUTH_ENV];
  const previousTokens = process.env[TOKENS_ENV];

  beforeEach(() => {
    process.env[TOKENS_ENV] = JSON.stringify(TEST_TOKENS);
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

  it('allows local MCP clients without auth when HTTP auth is disabled', async () => {
    delete process.env[AUTH_ENV];
    const { app } = createApp();

    const sessionId = await initializeMcpSession(app);

    const toolsListResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

    expect(toolsListResponse.status).toBe(200);
  });

  it('rejects missing and invalid auth when HTTP auth is enabled', async () => {
    process.env[AUTH_ENV] = 'true';
    const { app } = createApp();

    const missingAuthResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-auth-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(missingAuthResponse.status).toBe(401);
    expect(missingAuthResponse.body).toEqual({
      error: 'Missing or invalid authorization',
      statusCode: 401,
    });

    const invalidAuthResponse = await request(app)
      .post('/mcp')
      .set('authorization', 'Bearer unknown-token')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-auth-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(invalidAuthResponse.status).toBe(401);
    expect(invalidAuthResponse.body).toEqual({
      error: 'Missing or invalid authorization',
      statusCode: 401,
    });
  });

  it('rejects insufficient scope for tool writes', async () => {
    process.env[AUTH_ENV] = 'true';
    const { app } = createApp();
    const sessionId = await initializeMcpSession(app, 'Bearer reader');

    const toolsCallResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('authorization', 'Bearer reader')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'tool_manifest',
          arguments: {},
        },
      });

    expect(toolsCallResponse.status).toBe(403);
    expect(toolsCallResponse.body).toEqual({
      error: `Insufficient scope: requires ${HTTP_AUTH_SCOPES.TOOLS_WRITE}`,
      statusCode: 403,
    });
  });

  it('allows resource reads with resources:read scope', async () => {
    process.env[AUTH_ENV] = 'true';
    const { app } = createApp();
    const sessionId = await initializeMcpSession(app, 'Bearer reader');

    const resourceReadResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('authorization', 'Bearer reader')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/read',
        params: {
          uri: 'context-engine://tool-manifest',
        },
      });

    expect(resourceReadResponse.status).toBe(200);
    const payload = parseSseJsonPayload(resourceReadResponse.text);
    const resourceContents = (payload.result as {
      contents?: Array<{ text: string }>;
    } | undefined)?.contents;
    expect(resourceContents?.[0]?.text).toContain('"resources"');
  });

  it('requires tasks:cancel scope for MCP session deletion', async () => {
    process.env[AUTH_ENV] = 'true';
    const { app } = createApp();
    const sessionId = await initializeMcpSession(app, 'Bearer writer');

    const insufficientScopeResponse = await request(app)
      .delete('/mcp')
      .set('authorization', 'Bearer writer')
      .set('mcp-session-id', sessionId);

    expect(insufficientScopeResponse.status).toBe(403);
    expect(insufficientScopeResponse.body).toEqual({
      error: `Insufficient scope: requires ${HTTP_AUTH_SCOPES.TASKS_CANCEL}`,
      statusCode: 403,
    });

    const authorizedDeleteResponse = await request(app)
      .delete('/mcp')
      .set('authorization', 'Bearer canceller')
      .set('mcp-session-id', sessionId);

    expect(authorizedDeleteResponse.status).toBe(204);
  });
});
