import { afterEach, describe, expect, it } from '@jest/globals';

import {
  executeToolCall,
  type SignalAwareToolHandler,
} from '../../src/mcp/executeTool.js';
import {
  resetAuditLogSinkForTests,
  setAuditLogSinkForTests,
  type AuditEvent,
} from '../../src/telemetry/auditLog.js';
import type { JsonSchema } from '../../src/mcp/types/outputSchema.js';

/**
 * R1a -- Cancellation and error contract.
 *
 * Executor-focused characterization tests for the single cancellation
 * outcome vocabulary defined in `src/mcp/executeTool.ts`. These tests own
 * the pre-abort, queued-abort, handler-abort/timeout, and mixed
 * error/cancel fixtures called for by the plan card, plus dedicated
 * permit-release and no-publication assertions. They deliberately call
 * `executeToolCall` directly (no transport) so the executor's contract is
 * pinned independently of MCP stdio, MCP HTTP, or REST wiring.
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAbortError(message = 'The operation was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

const capturedAuditEvents: AuditEvent[] = [];

function lastToolCallAuditEvent(): AuditEvent | undefined {
  return [...capturedAuditEvents].reverse().find((event) => event.category === 'tool_call');
}

describe('R1a -- executeToolCall cancellation outcome vocabulary', () => {
  afterEach(() => {
    resetAuditLogSinkForTests();
    capturedAuditEvents.length = 0;
  });

  it('classifies pre-abort calls as cancelled without ever invoking the handler', async () => {
    setAuditLogSinkForTests((_serialized, event) => {
      capturedAuditEvents.push(event);
    });

    const controller = new AbortController();
    controller.abort();

    let handlerCalled = false;
    const handler: SignalAwareToolHandler = async () => {
      handlerCalled = true;
      return 'should never run';
    };

    const execution = await executeToolCall({
      name: 'pre_abort_tool',
      args: {},
      toolHandlers: new Map([['pre_abort_tool', handler]]),
      signal: controller.signal,
    });

    expect(handlerCalled).toBe(false);
    expect(execution.result).toBe('cancelled');
    expect(execution.response.isError).toBe(true);
    expect(execution.response.content[0]?.text).toBe(
      'Cancelled: pre_abort_tool was cancelled before completion.'
    );
    expect(lastToolCallAuditEvent()).toEqual(
      expect.objectContaining({ category: 'tool_call', outcome: 'cancelled', tool: 'pre_abort_tool' })
    );
  });

  it('classifies queued-abort calls (aborted during synchronous dispatch) as cancelled without invoking the handler', async () => {
    const controller = new AbortController();

    let handlerCalled = false;
    const handler: SignalAwareToolHandler = async () => {
      handlerCalled = true;
      return 'should never run';
    };

    // Simulate the signal firing on the way through synchronous dispatch
    // (handler lookup + schema validation) -- i.e. the call was "queued"
    // behind that work when cancellation landed, strictly before the
    // handler itself started.
    const realSchemas = new Map<string, JsonSchema>();
    const toolInputSchemas = new Map<string, JsonSchema>();
    Object.defineProperty(toolInputSchemas, 'get', {
      value: (key: string) => {
        controller.abort();
        return realSchemas.get(key);
      },
    });

    const execution = await executeToolCall({
      name: 'queued_abort_tool',
      args: {},
      toolHandlers: new Map([['queued_abort_tool', handler]]),
      toolInputSchemas,
      signal: controller.signal,
    });

    expect(handlerCalled).toBe(false);
    expect(execution.result).toBe('cancelled');
    expect(execution.response.isError).toBe(true);
  });

  it('classifies handler-abort calls as cancelled, awaits full handler settlement, and releases the handler-owned permit', async () => {
    const controller = new AbortController();
    let permitHeld = 0;
    let permitReleasedBeforeSettle = false;
    const started = deferred<void>();

    const handler: SignalAwareToolHandler = async (_args, signal) => {
      permitHeld += 1;
      try {
        started.resolve();
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError('handler aborted mid-flight')), {
            once: true,
          });
        });
        return 'unreachable';
      } finally {
        permitHeld -= 1;
        permitReleasedBeforeSettle = permitHeld === 0;
      }
    };

    const executionPromise = executeToolCall({
      name: 'handler_abort_tool',
      args: {},
      toolHandlers: new Map([['handler_abort_tool', handler]]),
      signal: controller.signal,
    });

    await started.promise;
    expect(permitHeld).toBe(1);
    controller.abort();

    const execution = await executionPromise;

    expect(execution.result).toBe('cancelled');
    expect(permitHeld).toBe(0);
    expect(permitReleasedBeforeSettle).toBe(true);
    expect(execution.response.isError).toBe(true);
    expect(execution.response.content[0]?.text).not.toContain('handler aborted mid-flight');
  });

  it('classifies timeout-triggered aborts (caller-owned timer reusing the same signal) identically to a direct cancel', async () => {
    const controller = new AbortController();
    const started = deferred<void>();

    const handler: SignalAwareToolHandler = async (_args, signal) => {
      started.resolve();
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(createAbortError('timed out')), { once: true });
      });
      return 'unreachable';
    };

    const executionPromise = executeToolCall({
      name: 'timeout_tool',
      args: {},
      toolHandlers: new Map([['timeout_tool', handler]]),
      signal: controller.signal,
    });

    await started.promise;
    // Model `runAbortableTool`'s caller-owned timeout: a timer fires and
    // aborts the very same signal the executor was given, indistinguishable
    // from an explicit cancel at this layer.
    setTimeout(() => controller.abort(), 5);

    const execution = await executionPromise;

    expect(execution.result).toBe('cancelled');
    expect(execution.response.isError).toBe(true);
  });

  it('mixed error/cancel: an unrelated thrown error is still classified cancelled once the signal has fired, and its message is not published', async () => {
    setAuditLogSinkForTests((_serialized, event) => {
      capturedAuditEvents.push(event);
    });

    const controller = new AbortController();
    const handler: SignalAwareToolHandler = async () => {
      controller.abort();
      throw new Error('unrelated handler bug');
    };

    const execution = await executeToolCall({
      name: 'mixed_error_cancel_tool',
      args: {},
      toolHandlers: new Map([['mixed_error_cancel_tool', handler]]),
      signal: controller.signal,
    });

    expect(execution.result).toBe('cancelled');
    expect(execution.response.content[0]?.text).not.toContain('unrelated handler bug');
    expect(lastToolCallAuditEvent()).toEqual(
      expect.objectContaining({ outcome: 'cancelled', tool: 'mixed_error_cancel_tool' })
    );
  });

  it('mixed error/cancel: an abort-shaped error is a genuine error (not cancelled) when the signal never fired', async () => {
    const controller = new AbortController();
    const handler: SignalAwareToolHandler = async () => {
      // Some handlers surface their own internal timeouts using the same
      // 'AbortError' shape as a real cancellation. Without an aborted
      // signal, the executor must not misclassify this as 'cancelled'.
      throw createAbortError('internal unrelated abort-shaped error');
    };

    const execution = await executeToolCall({
      name: 'unrelated_abort_shaped_error_tool',
      args: {},
      toolHandlers: new Map([['unrelated_abort_shaped_error_tool', handler]]),
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(false);
    expect(execution.result).toBe('error');
    expect(execution.response.content[0]?.text).toContain('internal unrelated abort-shaped error');
  });

  it('classifies a handler result that resolves successfully after the signal aborted as cancelled, never publishing the success', async () => {
    const controller = new AbortController();
    const handler: SignalAwareToolHandler = async () => {
      controller.abort();
      return 'late success payload';
    };

    const execution = await executeToolCall({
      name: 'late_success_tool',
      args: {},
      toolHandlers: new Map([['late_success_tool', handler]]),
      signal: controller.signal,
    });

    expect(execution.result).toBe('cancelled');
    expect(execution.response.content[0]?.text).not.toContain('late success payload');
  });

  it('leaves success and error outcomes byte-for-byte unchanged when no signal is aborted (regression fence)', async () => {
    const successHandler: SignalAwareToolHandler = async () => 'ok';
    const errorHandler: SignalAwareToolHandler = async () => {
      throw new Error('boom');
    };

    const successExecution = await executeToolCall({
      name: 'plain_success_tool',
      args: {},
      toolHandlers: new Map([['plain_success_tool', successHandler]]),
    });
    const errorExecution = await executeToolCall({
      name: 'plain_error_tool',
      args: {},
      toolHandlers: new Map([['plain_error_tool', errorHandler]]),
    });

    expect(successExecution).toEqual({
      response: { content: [{ type: 'text', text: 'ok' }] },
      result: 'success',
      elapsedMs: expect.any(Number),
    });
    expect(errorExecution).toEqual({
      response: { content: [{ type: 'text', text: 'Error: boom' }], isError: true },
      result: 'error',
      elapsedMs: expect.any(Number),
    });
  });
});
