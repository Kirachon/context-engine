import { describe, expect, it } from '@jest/globals';

import { runWithStdioRequestContext } from '../../src/mcp/server.js';
import { formatRequestLogPrefix, getRequestContext } from '../../src/telemetry/requestContext.js';

describe('stdio request context', () => {
  it('creates a correlated stdio request context for MCP handlers', async () => {
    const result = await runWithStdioRequestContext('tools/list', () => ({
      context: getRequestContext(),
      prefix: formatRequestLogPrefix(),
    }));

    expect(result.context).toBeDefined();
    expect(result.context?.transport).toBe('stdio');
    expect(result.context?.method).toBe('tools/list');
    expect(result.prefix).toMatch(/^\[request:[^\]]+\]$/);
    expect(result.prefix).not.toBe('[request:unknown]');
  });

  it('tools/call wiring preserves correlated stdio request context', async () => {
    const wrapToolCall = (fn: () => Promise<unknown>) => runWithStdioRequestContext('tools/call', fn);
    const result = (await wrapToolCall(async () => ({
      context: getRequestContext(),
      prefix: formatRequestLogPrefix(),
    }))) as { context: ReturnType<typeof getRequestContext>; prefix: string };

    expect(result.context?.transport).toBe('stdio');
    expect(result.context?.method).toBe('tools/call');
    expect(result.prefix).not.toBe('[request:unknown]');
  });
});
