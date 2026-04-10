import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';
import { REQUEST_ID_HEADER } from '../../src/http/middleware/logging.js';

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
      workspace: '/tmp/workspace',
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

describe('MCP HTTP transport', () => {
  it('supports initialize and tools/list over POST /mcp with session reuse', async () => {
    const { app } = createApp();

    const initializeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
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
      });

    expect(initializeResponse.status).toBe(200);
    expect(initializeResponse.headers['content-type']).toContain('text/event-stream');
    expect(typeof initializeResponse.headers[REQUEST_ID_HEADER]).toBe('string');
    expect((initializeResponse.headers[REQUEST_ID_HEADER] as string).length).toBeGreaterThan(0);
    const initializePayload = parseSseJsonPayload(initializeResponse.text);
    expect(
      (initializePayload.result as { capabilities?: { tools?: unknown } } | undefined)
        ?.capabilities?.tools
    ).toBeDefined();

    const sessionId = initializeResponse.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    expect(initializeResponse.headers[REQUEST_ID_HEADER]).not.toBe(sessionId);

    const initializedResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    expect([200, 202, 204]).toContain(initializedResponse.status);

    const toolsListResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });

    expect(toolsListResponse.status).toBe(200);
    expect(toolsListResponse.headers['content-type']).toContain('text/event-stream');
    const toolsListPayload = parseSseJsonPayload(toolsListResponse.text);
    const tools = (toolsListPayload.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
    expect(Array.isArray(tools)).toBe(true);

    const toolNames = (tools ?? []).map(
      (tool: { name: string }) => tool.name
    );
    expect(toolNames).toEqual(expect.arrayContaining([
      'index_workspace',
      'semantic_search',
      'tool_manifest',
      'review_auto',
    ]));
  });

  it('supports resources and prompts over POST /mcp with the same session', async () => {
    const { app } = createApp();

    const initializeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(initializeResponse.status).toBe(200);
    const initializePayload = parseSseJsonPayload(initializeResponse.text);
    const capabilities = (initializePayload.result as {
      capabilities?: { resources?: unknown; prompts?: unknown };
    } | undefined)?.capabilities;
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();

    const sessionId = initializeResponse.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const initializedResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    expect([200, 202, 204]).toContain(initializedResponse.status);

    const resourcesListResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 11,
        method: 'resources/list',
        params: {},
      });

    expect(resourcesListResponse.status).toBe(200);
    expect(typeof resourcesListResponse.headers[REQUEST_ID_HEADER]).toBe('string');
    const resourcesListPayload = parseSseJsonPayload(resourcesListResponse.text);
    const resources = (resourcesListPayload.result as {
      resources?: Array<{ uri: string }>;
    } | undefined)?.resources;
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'context-engine://tool-manifest' }),
      ])
    );

    const resourceReadResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 12,
        method: 'resources/read',
        params: {
          uri: 'context-engine://tool-manifest',
        },
      });

    expect(resourceReadResponse.status).toBe(200);
    const resourceReadPayload = parseSseJsonPayload(resourceReadResponse.text);
    const resourceContents = (resourceReadPayload.result as {
      contents?: Array<{ text: string }>;
    } | undefined)?.contents;
    expect(resourceContents?.[0]?.text).toContain('"resources"');
    expect(resourceContents?.[0]?.text).toContain('"prompts"');

    const promptsListResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 13,
        method: 'prompts/list',
        params: {},
      });

    expect(promptsListResponse.status).toBe(200);
    const promptsListPayload = parseSseJsonPayload(promptsListResponse.text);
    const prompts = (promptsListPayload.result as {
      prompts?: Array<{ name: string; title?: string }>;
    } | undefined)?.prompts;
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'create-plan', title: 'Create Plan' }),
        expect.objectContaining({ name: 'enhance-request' }),
      ])
    );

    const promptGetResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 14,
        method: 'prompts/get',
        params: {
          name: 'enhance-request',
          arguments: {
            prompt: 'focus the request',
            include_paths: 'src/mcp/**',
            exclude_paths: 'tests/**',
          },
        },
      });

    expect(promptGetResponse.status).toBe(200);
    const promptGetPayload = parseSseJsonPayload(promptGetResponse.text);
    const promptMessages = (promptGetPayload.result as {
      messages?: Array<{ content?: { text?: string } }>;
    } | undefined)?.messages;
    expect(promptMessages?.[0]?.content?.text).toContain('expert prompt enhancer');
    expect(promptMessages?.[1]?.content?.text).toContain('src/mcp/**');
    expect(promptMessages?.[1]?.content?.text).toContain('tests/**');

    const enhancePromptDefinition = prompts?.find((entry) => entry.name === 'enhance-request');
    expect(enhancePromptDefinition).toEqual(
      expect.objectContaining({
        name: 'enhance-request',
      })
    );
    expect((enhancePromptDefinition as { arguments?: Array<{ name: string; description?: string }> } | undefined)?.arguments)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'auto_scope' }),
          expect.objectContaining({ name: 'external_sources' }),
        ])
      );

    const createPlanPromptResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 15,
        method: 'prompts/get',
        params: {
          name: 'create-plan',
          arguments: {
            task: 'Plan the auth changes',
            auto_scope: 'false',
            include_paths: 'src/auth/**',
            exclude_paths: 'src/auth/legacy/**',
          },
        },
      });

    expect(createPlanPromptResponse.status).toBe(200);
    const createPlanPromptPayload = parseSseJsonPayload(createPlanPromptResponse.text);
    const createPlanMessages = (createPlanPromptPayload.result as {
      messages?: Array<{ content?: { text?: string } }>;
    } | undefined)?.messages;
    expect(createPlanMessages?.[1]?.content?.text).toContain('Plan the auth changes');
    expect(createPlanMessages?.[1]?.content?.text).toContain('auto_scope: false');
    expect(createPlanMessages?.[1]?.content?.text).toContain('include_paths: src/auth/**');
    expect(createPlanMessages?.[1]?.content?.text).toContain('exclude_paths: src/auth/legacy/**');

    const enhancePromptWithAutoScopeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 16,
        method: 'prompts/get',
        params: {
          name: 'enhance-request',
          arguments: {
            prompt: 'Focus auth work',
            auto_scope: 'false',
            include_paths: 'src/auth/**',
          },
        },
      });

    expect(enhancePromptWithAutoScopeResponse.status).toBe(200);
    const enhancePromptWithAutoScopePayload = parseSseJsonPayload(enhancePromptWithAutoScopeResponse.text);
    const enhancePromptWithAutoScopeMessages = (enhancePromptWithAutoScopePayload.result as {
      messages?: Array<{ content?: { text?: string } }>;
    } | undefined)?.messages;
    expect(enhancePromptWithAutoScopeMessages?.[1]?.content?.text).toContain('## Auto Scope');
    expect(enhancePromptWithAutoScopeMessages?.[1]?.content?.text).toContain('- false');
    expect(enhancePromptWithAutoScopeMessages?.[1]?.content?.text).toContain('src/auth/**');

    const invalidExternalSourcesResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 17,
        method: 'prompts/get',
        params: {
          name: 'enhance-request',
          arguments: {
            prompt: 'Focus auth work',
            external_sources: '{not-json}',
          },
        },
      });

    expect(invalidExternalSourcesResponse.status).toBe(200);
    const invalidExternalSourcesPayload = parseSseJsonPayload(invalidExternalSourcesResponse.text);
    expect((invalidExternalSourcesPayload.error as { message?: string } | undefined)?.message).toContain('external_sources');
  });

  it('rejects POST /mcp requests without a session unless they initialize', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32000,
      },
      id: 3,
    });
    expect(typeof response.body?.error?.message).toBe('string');
  });

  it('returns 403 for denied-origin POST /mcp requests', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/mcp')
      .set('origin', 'https://evil.example')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Origin not allowed: https://evil.example',
      statusCode: 403,
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 403 for denied-origin preflight OPTIONS /mcp requests', async () => {
    const { app } = createApp();

    const response = await request(app)
      .options('/mcp')
      .set('origin', 'https://evil.example')
      .set('access-control-request-method', 'POST');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Origin not allowed: https://evil.example',
      statusCode: 403,
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts valid preflight OPTIONS /mcp requests from allowed local origins', async () => {
    const { app } = createApp();

    const response = await request(app)
      .options('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'POST');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type,Authorization,Mcp-Session-Id');
    expect(response.headers['access-control-expose-headers']).toBe('Mcp-Session-Id');
    expect(response.headers['vary']).toContain('Origin');
  });

  it('accepts IPv6 loopback origins for local MCP clients', async () => {
    const { app } = createApp();

    const response = await request(app)
      .options('/mcp')
      .set('origin', 'http://[::1]:3000')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type,mcp-session-id');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://[::1]:3000');
  });

  it('supports tools/list over additive GET /mcp with an initialized session', async () => {
    const { app } = createApp();

    const initializeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 20,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const initializedResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

    expect([200, 202, 204]).toContain(initializedResponse.status);

    const listener = app.listen(0);

    try {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to bind test HTTP listener');
      }

      const controller = new AbortController();
      const streamResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': sessionId as string,
        },
        signal: controller.signal,
      });

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
      await streamResponse.body?.cancel();
      controller.abort();
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('returns session-not-found JSON for additive GET /mcp with an unknown session', async () => {
    const { app } = createApp();

    const response = await request(app)
      .get('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', 'missing-session');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'MCP session not found: missing-session',
      },
      id: null,
    });
  });

  it('terminates an initialized session with DELETE /mcp and rejects stale reuse afterward', async () => {
    const { app } = createApp();

    const initializeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 30,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const deleteResponse = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', sessionId as string);

    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.text).toBe('');

    const staleResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId as string)
      .send({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/list',
        params: {},
      });

    expect(staleResponse.status).toBe(404);
    expect(staleResponse.body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: `MCP session not found: ${sessionId as string}`,
      },
      id: 31,
    });
  });

  it('returns session-not-found JSON for DELETE /mcp with an unknown session', async () => {
    const { app } = createApp();

    const response = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', 'missing-session');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'MCP session not found: missing-session',
      },
      id: null,
    });
  });

  it('keeps the auth hook inert by default for allowed local clients', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 40,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(response.status).toBe(200);
  });

  it('applies the optional auth hook across MCP transport verbs when configured', async () => {
    const { app } = createApp(createMockServiceClient(), {
      authHook: (req) => {
        if (req.headers.authorization === 'Bearer allow') {
          return { authorized: true };
        }
        return {
          authorized: false,
          statusCode: 401,
          message: 'Missing or invalid authorization',
        };
      },
    });

    const unauthorizedPost = await request(app)
      .post('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 41,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(unauthorizedPost.status).toBe(401);
    expect(unauthorizedPost.body).toEqual({
      error: 'Missing or invalid authorization',
      statusCode: 401,
    });

    const unauthorizedDelete = await request(app)
      .delete('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('mcp-session-id', 'missing-session');

    expect(unauthorizedDelete.status).toBe(401);
    expect(unauthorizedDelete.body).toEqual({
      error: 'Missing or invalid authorization',
      statusCode: 401,
    });

    const preflightResponse = await request(app)
      .options('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'DELETE')
      .set('access-control-request-headers', 'authorization,mcp-session-id');

    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const authorizedPost = await request(app)
      .post('/mcp')
      .set('origin', 'http://localhost:3000')
      .set('authorization', 'Bearer allow')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 42,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'http-test-client',
            version: '1.0.0',
          },
        },
      });

    expect(authorizedPost.status).toBe(200);
  });
});
