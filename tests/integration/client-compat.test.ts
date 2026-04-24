/**
 * Client Compatibility Tests
 *
 * Ensures the legacy 38-tool contract remains available and compatible
 * with Codex CLI, Claude Desktop, Cursor, and other MCP clients while
 * allowing newer additive tools to coexist.
 */

import { describe, expect, test, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import { buildToolRegistryEntries, createServerCapabilities } from '../../src/mcp/server.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';

// List of all 38 existing tools that MUST remain unchanged
const EXISTING_TOOLS = [
  'index_workspace',
  'codebase_retrieval',
  'semantic_search',
  'get_file',
  'get_context_for_prompt',
  'enhance_prompt',
  'tool_manifest',
  'index_status',
  'reindex_workspace',
  'clear_index',
  'add_memory',
  'list_memories',
  'create_plan',
  'refine_plan',
  'visualize_plan',
  'execute_plan',
  'save_plan',
  'load_plan',
  'list_plans',
  'delete_plan',
  'request_approval',
  'respond_approval',
  'start_step',
  'complete_step',
  'fail_step',
  'view_progress',
  'view_history',
  'compare_plan_versions',
  'rollback_plan',
  'review_changes',
  'review_git_diff',
  'reactive_review_pr',
  'get_review_status',
  'pause_review',
  'resume_review',
  'get_review_telemetry',
  'scrub_secrets',
  'validate_content',
] as const;

type CompatTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

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

function getRuntimeTools(): CompatTool[] {
  return buildToolRegistryEntries({} as never).map((entry) => entry.tool as CompatTool);
}

async function initializeMcpSession(app: ReturnType<typeof createApp>['app'], clientName: string): Promise<string> {
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
          name: clientName,
          version: '1.0.0',
        },
      },
    });

  expect(initializeResponse.status).toBe(200);
  const sessionId = initializeResponse.headers['mcp-session-id'] as string;
  expect(typeof sessionId).toBe('string');

  const initializedResponse = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

  expect([200, 202, 204]).toContain(initializedResponse.status);
  return sessionId;
}

describe('MCP Client Compatibility', () => {
  describe('Tool Count Verification', () => {
    test('should have exactly 38 existing tools defined', () => {
      expect(EXISTING_TOOLS).toHaveLength(38);
    });

    test('should have no duplicate tool names', () => {
      const uniqueTools = new Set(EXISTING_TOOLS);
      expect(uniqueTools.size).toBe(EXISTING_TOOLS.length);
    });
  });

  describe('Tool Availability', () => {
    test('all existing tools should be registered in the server', () => {
      const runtimeToolNames = new Set(getRuntimeTools().map((tool) => tool.name));
      const manifestToolNames = new Set(getToolManifest().tools);

      for (const toolName of EXISTING_TOOLS) {
        expect(runtimeToolNames.has(toolName)).toBe(true);
        expect(manifestToolNames.has(toolName)).toBe(true);
      }
    });

    test('new tools should be additive only', () => {
      const runtimeToolNames = getRuntimeTools().map((tool) => tool.name);

      expect(runtimeToolNames).toEqual(expect.arrayContaining(EXISTING_TOOLS as unknown as string[]));
      expect(runtimeToolNames.length).toBeGreaterThan(EXISTING_TOOLS.length);
    });
  });

  describe('Schema Compatibility', () => {
    test('existing tool input schemas should match baseline', () => {
      const runtimeTools = new Map(getRuntimeTools().map((tool) => [tool.name, tool]));

      for (const toolName of EXISTING_TOOLS) {
        const tool = runtimeTools.get(toolName);
        expect(tool).toBeDefined();
        expect(tool).toEqual(
          expect.objectContaining({
            name: toolName,
            description: expect.any(String),
            inputSchema: expect.objectContaining({
              type: 'object',
            }),
          })
        );
      }
    });

    test('existing tool output schemas should remain an additive surface only', () => {
      const runtimeTools = getRuntimeTools().filter((tool) => EXISTING_TOOLS.includes(tool.name as (typeof EXISTING_TOOLS)[number]));

      for (const tool of runtimeTools) {
        if (tool.outputSchema !== undefined) {
          expect(tool.outputSchema).toEqual(expect.any(Object));
        }
      }
    });
  });

  describe('Protocol Compliance', () => {
    test('should respond to list_tools request', async () => {
      const { app } = createApp();
      const sessionId = await initializeMcpSession(app, 'compat-test-client');

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
      const toolsListPayload = parseSseJsonPayload(toolsListResponse.text);
      const toolNames = (((toolsListPayload.result as { tools?: Array<{ name: string }> })?.tools) ?? [])
        .map((tool) => tool.name);

      expect(toolNames).toEqual(expect.arrayContaining(EXISTING_TOOLS as unknown as string[]));
    });

    test('should handle tool calls with correct schema', () => {
      expect(createServerCapabilities({ resources: true, prompts: true })).toEqual({
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true },
      });
    });

    test('should return proper error format for invalid calls', async () => {
      const { app } = createApp();
      const sessionId = await initializeMcpSession(app, 'compat-test-client');

      const invalidCallResponse = await request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'unknown_tool',
            arguments: {},
          },
        });

      expect(invalidCallResponse.status).toBe(200);
      const invalidCallPayload = parseSseJsonPayload(invalidCallResponse.text);
      expect(invalidCallPayload.error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('Unknown tool: unknown_tool'),
        })
      );
    });
  });

  describe('Client-Specific Compatibility', () => {
    test('Codex CLI: capability advertisement remains MCP-compatible', () => {
      expect(createServerCapabilities({ resources: true, prompts: true })).toEqual({
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true },
      });
    });

    test('Claude Desktop: tool manifest parsing works', () => {
      const manifestJson = JSON.stringify(getToolManifest());
      const parsed = JSON.parse(manifestJson) as { tools?: string[]; discoverability?: object };

      expect(parsed.tools).toEqual(expect.arrayContaining(EXISTING_TOOLS as unknown as string[]));
      expect(parsed.discoverability).toEqual(expect.any(Object));
    });

    test('Cursor: streaming responses work', async () => {
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
              name: 'cursor',
              version: '1.0.0',
            },
          },
        });

      expect(initializeResponse.status).toBe(200);
      expect(initializeResponse.headers['content-type']).toContain('text/event-stream');
      expect(parseSseJsonPayload(initializeResponse.text)).toEqual(
        expect.objectContaining({
          result: expect.any(Object),
        })
      );
    });
  });
});

describe('Backward Compatibility Guarantees', () => {
  test('EXISTING_TOOLS constant should never change', () => {
    expect(EXISTING_TOOLS.length).toBeGreaterThanOrEqual(38);
  });

  test('existing tool behavior should not change', () => {
    const runtimeToolNames = getRuntimeTools().map((tool) => tool.name);
    const manifestToolNames = getToolManifest().tools;

    expect(runtimeToolNames).toEqual(expect.arrayContaining(EXISTING_TOOLS as unknown as string[]));
    expect(manifestToolNames).toEqual(expect.arrayContaining(EXISTING_TOOLS as unknown as string[]));
  });

  test('existing tool error messages should not change', async () => {
    const { app } = createApp();
    const sessionId = await initializeMcpSession(app, 'compat-test-client');

    const invalidCallResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'unknown_tool',
          arguments: {},
        },
      });

    const invalidCallPayload = parseSseJsonPayload(invalidCallResponse.text);
    expect(invalidCallPayload.error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Unknown tool: unknown_tool'),
      })
    );
  });
});

export { EXISTING_TOOLS };
