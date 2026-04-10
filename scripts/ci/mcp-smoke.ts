#!/usr/bin/env node

import { createServer, type AddressInfo } from 'node:http';
import { once } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCError, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { ContextEngineHttpServer } from '../../src/http/httpServer.js';

type MockServiceClient = {
  getIndexStatus: () => {
    workspace: string;
    lastIndexed: string;
    fileCount: number;
    isStale: boolean;
  };
  indexWorkspace: () => Promise<{ filesIndexed: number; chunksCreated: number }>;
  semanticSearch: () => Promise<never[]>;
  getContextForPrompt: () => Promise<{ query: string; files: never[]; metadata: Record<string, unknown> }>;
  getFile: () => Promise<string>;
  clearCache: () => void;
  getWorkspacePath: () => string;
};

function createMockServiceClient(): MockServiceClient {
  return {
    getIndexStatus: () => ({
      workspace: process.cwd(),
      lastIndexed: '2026-04-10T00:00:00.000Z',
      fileCount: 12,
      isStale: false,
    }),
    indexWorkspace: async () => ({
      filesIndexed: 12,
      chunksCreated: 34,
    }),
    semanticSearch: async () => [],
    getContextForPrompt: async () => ({
      query: 'placeholder',
      files: [],
      metadata: {},
    }),
    getFile: async () => 'contents',
    clearCache: () => undefined,
    getWorkspacePath: () => process.cwd(),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function expectJsonRpcError(payload: unknown): JSONRPCError {
  assert(payload && typeof payload === 'object', 'Expected JSON-RPC payload object');
  const error = (payload as JSONRPCResponse).error;
  assert(error && typeof error === 'object', 'Expected JSON-RPC error object');
  assert(typeof error.code === 'number', 'Expected numeric JSON-RPC error code');
  assert(typeof error.message === 'string', 'Expected JSON-RPC error message string');
  return error;
}

function parseSseJsonPayload(text: string): Record<string, unknown> {
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '));

  assert(dataLine, `Missing SSE data payload: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function parseJsonRpcPayload(response: Response): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream') || bodyText.includes('\ndata: ') || bodyText.startsWith('event: ')) {
    return parseSseJsonPayload(bodyText);
  }

  return JSON.parse(bodyText) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const appServer = new ContextEngineHttpServer(createMockServiceClient() as never, {
    port: 0,
    version: '9.9.9',
  });
  const listener = createServer(appServer.getApp());
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');

  const address = listener.address() as AddressInfo | null;
  assert(address, 'Failed to resolve smoke server address');
  const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const client = new Client(
    { name: 'context-engine-smoke', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(baseUrl);

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert(toolNames.includes('tool_manifest'), 'Expected tool_manifest in tools/list');
    assert(toolNames.includes('semantic_search'), 'Expected semantic_search in tools/list');
    const enhanceTool = tools.tools.find((tool) => tool.name === 'enhance_prompt');
    assert(enhanceTool, 'Expected enhance_prompt in tools/list');
    assert(enhanceTool.title === 'Enhance Prompt', 'Expected canonical tool title in tools/list');

    const resources = await client.listResources();
    const manifestResource = resources.resources.find(
      (resource) => resource.uri === 'context-engine://tool-manifest'
    );
    assert(manifestResource, 'Expected context-engine://tool-manifest in resources/list');
    assert(manifestResource.title === 'Tool Manifest', 'Expected canonical resource title in resources/list');

    const resourceRead = await client.readResource({ uri: 'context-engine://tool-manifest' });
    const toolManifestText = resourceRead.contents.find(
      (entry) => 'text' in entry && typeof entry.text === 'string'
    );
    assert(toolManifestText?.text.includes('"tools"'), 'Expected tool manifest resource contents');
    assert(
      toolManifestText?.text.includes('"discoverability"'),
      'Expected discoverability metadata in tool manifest resource contents'
    );

    const prompts = await client.listPrompts();
    const enhancePrompt = prompts.prompts.find((prompt) => prompt.name === 'enhance-request');
    assert(enhancePrompt, 'Expected enhance-request in prompts/list');
    assert(enhancePrompt.title === 'Enhance Request', 'Expected canonical prompt title in prompts/list');

    const prompt = await client.getPrompt({
      name: 'enhance-request',
      arguments: {
        prompt: 'focus auth work',
        include_paths: 'src/mcp/**',
        exclude_paths: 'tests/**',
      },
    });
    const promptText = prompt.messages
      .map((message) => ('text' in message.content ? message.content.text : ''))
      .join('\n');
    assert(promptText.includes('src/mcp/**'), 'Expected include_paths in prompt/get output');
    assert(promptText.includes('tests/**'), 'Expected exclude_paths in prompt/get output');

    const toolCall = await client.callTool({
      name: 'tool_manifest',
      arguments: {},
    });
    const toolText = toolCall.content.find((entry) => entry.type === 'text')?.text;
    assert(typeof toolText === 'string' && toolText.includes('"prompts"'), 'Expected tool_manifest call result');

    const sessionId = transport.sessionId;
    assert(typeof sessionId === 'string' && sessionId.length > 0, 'Expected transport session id');

    const invalidToolResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'semantic_search',
          arguments: {},
        },
      }),
    });

    assert(invalidToolResponse.status === 200, 'Expected JSON-RPC response status for invalid tool args');
    const invalidToolBody = await parseJsonRpcPayload(invalidToolResponse);
    assert(invalidToolBody.id === 99, 'Expected matching JSON-RPC id for invalid tool args');
    const invalidToolPayload = expectJsonRpcError(invalidToolBody);
    assert(invalidToolPayload.code < 0, 'Expected JSON-RPC error code for invalid tool args');

    const invalidResourceResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'resources/read',
        params: {
          uri: 'context-engine://missing-resource',
        },
      }),
    });

    assert(invalidResourceResponse.status === 200, 'Expected JSON-RPC response status for unknown resource');
    const invalidResourceBody = await parseJsonRpcPayload(invalidResourceResponse);
    assert(invalidResourceBody.id === 100, 'Expected matching JSON-RPC id for unknown resource');
    const invalidResourcePayload = expectJsonRpcError(invalidResourceBody);
    assert(invalidResourcePayload.code < 0, 'Expected JSON-RPC error code for unknown resource');

    console.log('MCP smoke check passed.');
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
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
}

main().catch((error) => {
  console.error(
    `[mcp-smoke] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
