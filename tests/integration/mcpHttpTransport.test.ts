import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
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

function createApp(serviceClient = createMockServiceClient()) {
  const server = new ContextEngineHttpServer(serviceClient as never, {
    port: 0,
    version: '9.9.9',
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
});
