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
});
