import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Express } from 'express';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';
import { executeToolCall } from '../../src/mcp/executeTool.js';
import { buildToolRegistryEntries, type ToolRegistryEntry } from '../../src/mcp/server.js';
import { buildToolInputSchemaMap } from '../../src/mcp/utils/validateToolInput.js';
import { createRequestContext, runWithRequestContext } from '../../src/telemetry/requestContext.js';

const PARITY_THROW_TOOL = 'parity_throw_tool';
const PARITY_STRUCTURED_ERROR_TOOL = 'parity_structured_error_tool';

type MockServiceClient = {
  getIndexStatus: ReturnType<typeof jest.fn>;
  indexWorkspace: ReturnType<typeof jest.fn>;
  semanticSearch: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
  getFile: ReturnType<typeof jest.fn>;
  clearCache: ReturnType<typeof jest.fn>;
  getWorkspacePath: ReturnType<typeof jest.fn>;
};

type ToolCallPayload = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

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

function buildParityToolRegistry(serviceClient: MockServiceClient): ToolRegistryEntry[] {
  return [
    ...buildToolRegistryEntries(serviceClient as never),
    {
      tool: { name: PARITY_THROW_TOOL },
      handler: async () => {
        throw new Error('parity-boom');
      },
    },
    {
      tool: { name: PARITY_STRUCTURED_ERROR_TOOL },
      handler: async () => ({
        content: [{ type: 'text' as const, text: 'structured validation failed' }],
        structuredContent: {
          schema_version: 1,
          code: 'VALIDATION_FAILED',
          field: 'path',
        },
        isError: true,
      }),
    },
  ];
}

function buildParityToolHandlers(serviceClient: MockServiceClient) {
  const entries = buildParityToolRegistry(serviceClient);
  return {
    handlers: new Map(
      entries.map((entry) => [entry.tool.name, entry.handler])
    ),
    inputSchemas: buildToolInputSchemaMap(entries),
  };
}

async function executeStdioLikeToolCall(options: {
  name: string;
  args: unknown;
  serviceClient?: MockServiceClient;
}) {
  const serviceClient = options.serviceClient ?? createMockServiceClient();
  const { handlers, inputSchemas } = buildParityToolHandlers(serviceClient);

  return runWithRequestContext(
    createRequestContext({
      transport: 'stdio',
      method: 'tools/call',
      path: 'stdio',
    }),
    () =>
      executeToolCall({
        name: options.name,
        args: options.args,
        toolHandlers: handlers,
        toolInputSchemas: inputSchemas,
        useObservability: true,
      })
  );
}

function createParityHttpApp(
  serviceClient = createMockServiceClient(),
  options: HttpServerOptions = {}
) {
  const server = new ContextEngineHttpServer(serviceClient as never, {
    port: 0,
    version: '9.9.9',
    toolRegistryEntries: buildParityToolRegistry(serviceClient),
    ...options,
  });

  return {
    app: server.getApp() as Express,
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

async function initializeMcpSession(app: Express): Promise<string> {
  const initializeResponse = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 900,
      method: 'initialize',
      params: {
        protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'parity-test-client',
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
  return sessionId as string;
}

async function callHttpMcpTool(
  app: Express,
  sessionId: string,
  name: string,
  args: unknown,
  requestId = 901
): Promise<ToolCallPayload> {
  const response = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    });

  expect(response.status).toBe(200);
  const payload = parseSseJsonPayload(response.text);
  return (payload.result ?? {}) as ToolCallPayload;
}

async function callHttpMcpToolExpectingJsonRpcError(
  app: Express,
  sessionId: string,
  name: string,
  args: unknown,
  requestId = 901
) {
  const response = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    });

  expect(response.status).toBe(200);
  const payload = parseSseJsonPayload(response.text);
  expect(payload.id).toBe(requestId);
  expect(payload.error).toEqual(
    expect.objectContaining({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining(name),
    })
  );
  return payload;
}

function normalizeToolCallPayload(payload: ToolCallPayload): ToolCallPayload {
  return {
    content: payload.content,
    structuredContent: payload.structuredContent,
    isError: payload.isError,
  };
}

describe('MCP transport parity (error paths)', () => {
  it('returns matching unknown-tool JSON-RPC errors on stdio-like and HTTP /mcp paths', async () => {
    const { app, serviceClient } = createParityHttpApp();
    const sessionId = await initializeMcpSession(app);

    await expect(
      executeStdioLikeToolCall({
        name: 'missing_parity_tool',
        args: {},
        serviceClient,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining('Unknown tool: missing_parity_tool'),
      })
    );

    await callHttpMcpToolExpectingJsonRpcError(
      app,
      sessionId,
      'missing_parity_tool',
      {},
      2001
    );
  });

  it('returns matching invalid-params JSON-RPC errors on stdio-like and HTTP /mcp paths', async () => {
    const { app, serviceClient } = createParityHttpApp();
    const sessionId = await initializeMcpSession(app);

    await expect(
      executeStdioLikeToolCall({
        name: 'get_file',
        args: {},
        serviceClient,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining('get_file'),
      })
    );

    await callHttpMcpToolExpectingJsonRpcError(app, sessionId, 'get_file', {}, 2002);
  });

  it('returns matching handler-throw error envelopes on stdio-like and HTTP /mcp paths', async () => {
    const { app, serviceClient } = createParityHttpApp();
    const sessionId = await initializeMcpSession(app);

    const stdioExecution = await executeStdioLikeToolCall({
      name: PARITY_THROW_TOOL,
      args: {},
      serviceClient,
    });
    const httpResult = await callHttpMcpTool(app, sessionId, PARITY_THROW_TOOL, {}, 2003);

    expect(stdioExecution.result).toBe('error');
    expect(normalizeToolCallPayload(stdioExecution.response)).toEqual(
      normalizeToolCallPayload(httpResult)
    );
    expect(stdioExecution.response).toEqual({
      content: [{ type: 'text', text: 'Error: parity-boom' }],
      isError: true,
    });
  });

  it('returns matching structured error envelopes on stdio-like and HTTP /mcp paths', async () => {
    const { app, serviceClient } = createParityHttpApp();
    const sessionId = await initializeMcpSession(app);

    const stdioExecution = await executeStdioLikeToolCall({
      name: PARITY_STRUCTURED_ERROR_TOOL,
      args: {},
      serviceClient,
    });
    const httpResult = await callHttpMcpTool(app, sessionId, PARITY_STRUCTURED_ERROR_TOOL, {}, 2004);

    expect(stdioExecution.result).toBe('success');
    expect(normalizeToolCallPayload(stdioExecution.response)).toEqual(
      normalizeToolCallPayload(httpResult)
    );
    expect(stdioExecution.response).toEqual({
      content: [{ type: 'text', text: 'structured validation failed' }],
      structuredContent: {
        schema_version: 1,
        code: 'VALIDATION_FAILED',
        field: 'path',
      },
      isError: true,
    });
  });
});
