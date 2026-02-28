import { describe, expect, it, jest } from '@jest/globals';
import { executeToolCall } from '../../src/mcp/tooling/runtime.js';

describe('mcp tooling runtime wrapper', () => {
  it('returns success response for known tool handlers', async () => {
    const now: () => number = jest.fn<() => number>().mockReturnValueOnce(100).mockReturnValueOnce(135);
    const log = jest.fn();
    const toolHandlers = new Map<string, (args: unknown) => Promise<string>>([
      ['demo_tool', async (args) => `ok:${String(args)}`],
    ]);

    const result = await executeToolCall({
      name: 'demo_tool',
      args: 'value',
      toolHandlers,
      now,
      log,
    });

    expect(result).toEqual({
      response: {
        content: [
          {
            type: 'text',
            text: 'ok:value',
          },
        ],
      },
      result: 'success',
      elapsedMs: 35,
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('Tool: demo_tool');
    expect(log.mock.calls[1][0]).toContain('Tool demo_tool completed in 35ms');
  });

  it('returns error envelope for unknown tools', async () => {
    const now: () => number = jest.fn<() => number>().mockReturnValueOnce(10).mockReturnValueOnce(22);
    const log = jest.fn();

    const result = await executeToolCall({
      name: 'missing_tool',
      args: {},
      toolHandlers: new Map(),
      now,
      log,
    });

    expect(result).toEqual({
      response: {
        content: [
          {
            type: 'text',
            text: 'Error: Unknown tool: missing_tool',
          },
        ],
        isError: true,
      },
      result: 'error',
      elapsedMs: 12,
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain('Tool missing_tool failed after 12ms: Unknown tool: missing_tool');
  });

  it('returns error envelope when tool handler throws', async () => {
    const now: () => number = jest.fn<() => number>().mockReturnValueOnce(7).mockReturnValueOnce(20);
    const log = jest.fn();
    const toolHandlers = new Map<string, (args: unknown) => Promise<string>>([
      ['boom_tool', async () => { throw new Error('boom'); }],
    ]);

    const result = await executeToolCall({
      name: 'boom_tool',
      args: {},
      toolHandlers,
      now,
      log,
    });

    expect(result).toEqual({
      response: {
        content: [
          {
            type: 'text',
            text: 'Error: boom',
          },
        ],
        isError: true,
      },
      result: 'error',
      elapsedMs: 13,
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain('Tool boom_tool failed after 13ms: boom');
  });
});
