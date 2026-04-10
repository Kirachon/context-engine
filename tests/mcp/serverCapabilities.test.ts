import { describe, expect, it } from '@jest/globals';

import { SERVER_CAPABILITY_PARITY, createServerCapabilities } from '../../src/mcp/server.js';

describe('MCP server capability parity', () => {
  it('defines the advertised capabilities and their runtime receipts in one parity artifact', () => {
    expect(SERVER_CAPABILITY_PARITY).toEqual({
      tools: {
        capability: { listChanged: true },
        runtimeReceipts: ['ListToolsRequestSchema', 'CallToolRequestSchema'],
      },
      resources: {
        capability: { subscribe: false, listChanged: true },
        runtimeReceipts: ['ListResourcesRequestSchema', 'ReadResourceRequestSchema'],
      },
      prompts: {
        capability: { listChanged: true },
        runtimeReceipts: ['ListPromptsRequestSchema', 'GetPromptRequestSchema'],
      },
      logging: {
        capability: undefined,
        runtimeReceipts: [],
      },
    });
  });

  it('derives advertised server capabilities from the parity artifact', () => {
    expect(createServerCapabilities()).toEqual({
      tools: SERVER_CAPABILITY_PARITY.tools.capability,
    });

    expect(createServerCapabilities({ resources: true, prompts: true })).toEqual({
      tools: SERVER_CAPABILITY_PARITY.tools.capability,
      resources: SERVER_CAPABILITY_PARITY.resources.capability,
      prompts: SERVER_CAPABILITY_PARITY.prompts.capability,
    });
  });
});
