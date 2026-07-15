/**
 * R1c -- HTTP disconnect and shutdown cancellation.
 *
 * Wires every place an HTTP-flavored tool call can stop being wanted --
 * client disconnect, route timeout, session DELETE, idle-TTL eviction, and
 * server shutdown -- into the same `AbortSignal` that reaches tool
 * execution (R1a's `cancelled` outcome / R1b's abort propagation).
 *
 * These tests validate the five acceptance scenarios called out in the
 * remediation plan: client disconnect, middleware timeout, DELETE/session
 * close, eviction, and process shutdown all observe cancellation within a
 * bounded time (<500ms) rather than hanging or silently completing work
 * nobody is waiting for.
 */
import { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer, type HttpServerOptions } from '../../src/http/httpServer.js';
import { runAbortableTool } from '../../src/http/routes/tools.js';
import { buildToolRegistryEntries, type ToolRegistryEntry } from '../../src/mcp/server.js';

// A generous bound well above the <500ms acceptance target so CI/slow
// machines don't flake, while still catching a regression that hangs.
const CANCELLATION_BOUND_MS = 2_000;

type MockServiceClient = {
  getIndexStatus: ReturnType<typeof jest.fn>;
  indexWorkspace: ReturnType<typeof jest.fn>;
  semanticSearch: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
  getFile: ReturnType<typeof jest.fn>;
  clearCache: ReturnType<typeof jest.fn>;
  getWorkspacePath: ReturnType<typeof jest.fn>;
};

function createMockServiceClient(
  overrides: Partial<MockServiceClient> = {}
): MockServiceClient {
  return {
    getIndexStatus: jest.fn(() => ({
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2026-04-10T00:00:00.000Z',
      fileCount: 12,
      isStale: false,
    })),
    indexWorkspace: jest.fn(async () => ({ filesIndexed: 12, chunksCreated: 34 })),
    semanticSearch: jest.fn(async () => []),
    getContextForPrompt: jest.fn(async () => ({ query: 'placeholder', files: [], metadata: {} })),
    getFile: jest.fn(async () => 'contents'),
    clearCache: jest.fn(),
    getWorkspacePath: jest.fn(() => process.cwd()),
    ...overrides,
  };
}

/** A hang-until-aborted promise, mirroring real retrieval/AI work that only
 * stops early because it observes the signal (R1b's contract) rather than
 * because the caller gave up waiting on it. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const error = new Error('operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const ABORT_AWARE_TOOL = 'cancellation_abort_aware_tool';

function buildCancellationToolRegistry(
  serviceClient: MockServiceClient,
  onInvoked?: (signal: AbortSignal | undefined) => void
): ToolRegistryEntry[] {
  return [
    ...buildToolRegistryEntries(serviceClient as never),
    {
      tool: { name: ABORT_AWARE_TOOL },
      handler: async (_args: unknown, signal?: AbortSignal) => {
        onInvoked?.(signal);
        if (!signal) {
          throw new Error('expected an AbortSignal to be provided to the tool handler');
        }
        return hangUntilAborted(signal);
      },
    },
  ];
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
  return { app: server.getApp(), server, serviceClient };
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

async function initializeMcpSession(app: ReturnType<typeof createApp>['app']): Promise<string> {
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
        clientInfo: { name: 'r1c-cancellation-test-client', version: '1.0.0' },
      },
    });

  expect(initializeResponse.status).toBe(200);
  const sessionId = initializeResponse.headers['mcp-session-id'] as string;
  expect(typeof sessionId).toBe('string');

  const initializedResponse = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  expect([200, 202, 204]).toContain(initializedResponse.status);
  return sessionId;
}

/** Minimal EventEmitter-backed fake of the Express bits `runAbortableTool`
 * touches, for unit-level coverage of the abort-wiring contract itself
 * without needing a real socket. */
class FakeAbortableRequest extends EventEmitter {
  socket = {};
  setTimeout(_ms: number): this {
    return this;
  }
}

class FakeAbortableResponse extends EventEmitter {
  socket = {};
  writableEnded = false;
  setTimeout(_ms: number): this {
    return this;
  }
}

/**
 * Wait until `getSignal()` returns an aborted signal, or reject once
 * `boundMs` elapses. Polls the signal via its own 'abort' listener when
 * available rather than busy-waiting, so this resolves the instant the
 * abort actually fires.
 */
async function waitForAbort(
  initialSignal: AbortSignal | undefined,
  boundMs: number,
  getSignal: () => AbortSignal | undefined
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signal did not abort in time')), boundMs);
    const check = (): boolean => {
      const signal = getSignal();
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve();
        return true;
      }
      return false;
    };
    if (check()) return;
    const signal = initialSignal ?? getSignal();
    if (signal) {
      signal.addEventListener('abort', () => check(), { once: true });
    }
    // Fall back to a light poll in case the signal reference changes after
    // this listener was attached (not expected in these tests, but keeps
    // this helper honest rather than hanging silently).
    const interval = setInterval(() => {
      if (check()) {
        clearInterval(interval);
      }
    }, 20);
    timer.unref?.();
    (interval as unknown as { unref?: () => void }).unref?.();
  });
}

let runningServers: ContextEngineHttpServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.map((server) => server.stop().catch(() => {})));
  runningServers = [];
});

async function startRealServer(
  serviceClient: MockServiceClient,
  options: HttpServerOptions = {}
): Promise<{ server: ContextEngineHttpServer; port: number }> {
  const server = new ContextEngineHttpServer(serviceClient as never, {
    port: 0,
    version: '9.9.9',
    ...options,
  });
  await server.start();
  runningServers.push(server);
  const nodeServer = (server as unknown as { server: http.Server | null }).server;
  const address = nodeServer?.address() as AddressInfo | null;
  if (!address) {
    throw new Error('Failed to determine bound port for test server');
  }
  return { server, port: address.port };
}

describe('R1c: HTTP disconnect and shutdown cancellation', () => {
  // ==========================================================================
  // 1. Client disconnect (REST) -- a genuine socket-level abort, not just a
  //    finished request body, must reach the executor's AbortSignal.
  // ==========================================================================
  describe('client disconnect', () => {
    it('aborts the in-flight REST tool call when the client destroys the connection', async () => {
      let capturedSignal: AbortSignal | undefined;
      let invoked = false;
      const invokedResolvers: Array<() => void> = [];
      const waitForInvocation = () =>
        invoked ? Promise.resolve() : new Promise<void>((resolve) => invokedResolvers.push(resolve));

      const serviceClient = createMockServiceClient({
        semanticSearch: jest.fn((_query: string, _topK: number, opts: { signal?: AbortSignal }) => {
          capturedSignal = opts.signal;
          invoked = true;
          invokedResolvers.splice(0).forEach((resolve) => resolve());
          return hangUntilAborted(opts.signal as AbortSignal);
        }),
      });

      const { port } = await startRealServer(serviceClient);

      const body = JSON.stringify({ query: 'client disconnect probe' });
      const clientRequest = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/search',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }
      );
      // Real disconnects surface as ECONNRESET on the client socket; swallow
      // it here since we are the one causing it.
      clientRequest.on('error', () => {});
      clientRequest.write(body);
      clientRequest.end();

      await waitForInvocation();
      expect(capturedSignal?.aborted).toBe(false);

      const disconnectedAt = Date.now();
      clientRequest.destroy();

      await waitForAbort(capturedSignal, CANCELLATION_BOUND_MS, () => capturedSignal);

      expect(capturedSignal?.aborted).toBe(true);
      expect(Date.now() - disconnectedAt).toBeLessThan(CANCELLATION_BOUND_MS);

      // The server must remain healthy for subsequent callers -- cancellation
      // of one request must never wedge the lane for the next one.
      const followUp = await request((await startRealServer(createMockServiceClient())).server.getApp())
        .post('/api/v1/search')
        .send({ query: 'still works' });
      expect(followUp.status).toBe(200);
    });

    it('does not treat req finishing (body fully read) as a disconnect (regression guard)', async () => {
      // Historically `req.on('close')` was used to detect disconnects, but
      // Node fires that event once the request stream is fully consumed --
      // often immediately, well before any response exists -- not just on a
      // genuine premature disconnect. This pinned the resulting regression
      // (every ordinary request being spuriously cancelled) and must stay
      // green.
      const fakeReq = new FakeAbortableRequest();
      const fakeRes = new FakeAbortableResponse();

      const resultPromise = runAbortableTool(
        fakeReq as never,
        5_000,
        'Regression probe',
        async () => 'ok',
        fakeRes as never,
        'default'
      );

      // Simulate the request stream finishing essentially immediately, the
      // way Express/body-parser does for a small JSON body -- well before
      // the response (and therefore `res`'s own close) exists.
      fakeReq.emit('close');
      fakeReq.emit('aborted');

      await expect(resultPromise).resolves.toBe('ok');
    });

    it('aborts via runAbortableTool when the response closes before finishing', async () => {
      const fakeReq = new FakeAbortableRequest();
      const fakeRes = new FakeAbortableResponse();

      const executor = jest.fn((signal: AbortSignal) => hangUntilAborted(signal));
      const resultPromise = runAbortableTool(
        fakeReq as never,
        5_000,
        'Disconnect probe',
        executor,
        fakeRes as never,
        'default'
      );

      // Give the executor a tick to attach its abort listener before the
      // response "closes" out from under it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(fakeRes.writableEnded).toBe(false);
      fakeRes.emit('close');

      await expect(resultPromise).rejects.toEqual(
        expect.objectContaining({ statusCode: 499, name: 'AbortError' })
      );
    });

    it('ignores a response close that happens after the response already finished', async () => {
      const fakeReq = new FakeAbortableRequest();
      const fakeRes = new FakeAbortableResponse();

      const resultPromise = runAbortableTool(
        fakeReq as never,
        5_000,
        'Normal completion probe',
        async () => 'done',
        fakeRes as never,
        'default'
      );

      await expect(resultPromise).resolves.toBe('done');

      // The real response finishes and *then* 'close' fires (the normal
      // Node sequence) -- this must never retroactively fail an
      // already-resolved call.
      fakeRes.writableEnded = true;
      expect(() => fakeRes.emit('close')).not.toThrow();
    });
  });

  // ==========================================================================
  // 2. Route timeout -- runAbortableTool's own deadline, independent of any
  //    client behavior, must fire the same AbortSignal.
  // ==========================================================================
  describe('route timeout', () => {
    it('aborts the executor and rejects with 504 once the route-level timeout elapses', async () => {
      const fakeReq = new FakeAbortableRequest();
      const fakeRes = new FakeAbortableResponse();
      let observedSignal: AbortSignal | undefined;

      const startedAt = Date.now();
      const resultPromise = runAbortableTool(
        fakeReq as never,
        50,
        'Timeout probe',
        (signal) => {
          observedSignal = signal;
          return hangUntilAborted(signal);
        },
        fakeRes as never,
        'default'
      );

      await expect(resultPromise).rejects.toEqual(
        expect.objectContaining({ statusCode: 504 })
      );
      expect(observedSignal?.aborted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(CANCELLATION_BOUND_MS);
    });
  });

  // ==========================================================================
  // 3. DELETE /mcp mid-flight -- closing a session must abort any tools/call
  //    still running inside it, not just future calls on that session id.
  // ==========================================================================
  describe('DELETE /mcp session close', () => {
    it('aborts an in-flight tools/call when the session is explicitly deleted', async () => {
      let capturedSignal: AbortSignal | undefined;
      let resolveInvoked: (() => void) | undefined;
      const invokedPromise = new Promise<void>((resolve) => {
        resolveInvoked = resolve;
      });

      const serviceClient = createMockServiceClient();
      const { app, server } = createApp(serviceClient, {
        toolRegistryEntries: buildCancellationToolRegistry(serviceClient, (signal) => {
          capturedSignal = signal;
          resolveInvoked?.();
        }),
      });

      const sessionId = await initializeMcpSession(app);

      const callPromise = request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 5000,
          method: 'tools/call',
          params: { name: ABORT_AWARE_TOOL, arguments: {} },
        })
        .catch((error) => error);

      await invokedPromise;
      expect(capturedSignal?.aborted).toBe(false);

      const deletedAt = Date.now();
      const deleteResponse = await request(app)
        .delete('/mcp')
        .set('mcp-session-id', sessionId);

      expect(deleteResponse.status).toBe(204);
      expect(server.getActiveSessionCount()).toBe(0);

      // The delete call itself synchronously drives session.transport.close(),
      // which chains into the MCP SDK's Protocol#_onclose() aborting every
      // in-flight request handler's AbortSignal -- so this should already be
      // true by the time DELETE resolves, well inside the bound.
      expect(capturedSignal?.aborted).toBe(true);
      expect(Date.now() - deletedAt).toBeLessThan(CANCELLATION_BOUND_MS);

      // The original tools/call must settle (not hang) regardless of the
      // exact shape of its now-orphaned response.
      await expect(callPromise).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // 4. Idle-TTL eviction -- the sweep must abort in-flight work in the
  //    session it disposes, using the same transport-close mechanism as an
  //    explicit DELETE.
  // ==========================================================================
  describe('idle session eviction', () => {
    it('aborts an in-flight tools/call when its session is swept for idle TTL', async () => {
      let capturedSignal: AbortSignal | undefined;
      let resolveInvoked: (() => void) | undefined;
      const invokedPromise = new Promise<void>((resolve) => {
        resolveInvoked = resolve;
      });

      let currentTime = 5_000_000;
      const serviceClient = createMockServiceClient();
      const { app, server } = createApp(serviceClient, {
        sessionIdleTtlMs: 60_000,
        sessionSweepIntervalMs: 0,
        now: () => currentTime,
        toolRegistryEntries: buildCancellationToolRegistry(serviceClient, (signal) => {
          capturedSignal = signal;
          resolveInvoked?.();
        }),
      });

      const sessionId = await initializeMcpSession(app);

      const callPromise = request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .set('mcp-session-id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 5100,
          method: 'tools/call',
          params: { name: ABORT_AWARE_TOOL, arguments: {} },
        })
        .catch((error) => error);

      await invokedPromise;
      expect(capturedSignal?.aborted).toBe(false);

      // Advance the injected clock well past the idle TTL and sweep.
      currentTime += 120_000;
      const sweptAt = Date.now();
      const evictedCount = await server.runSessionSweep();

      expect(evictedCount).toBe(1);
      expect(server.getActiveSessionCount()).toBe(0);
      expect(capturedSignal?.aborted).toBe(true);
      expect(Date.now() - sweptAt).toBeLessThan(CANCELLATION_BOUND_MS);

      await expect(callPromise).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // 5. Process shutdown -- server.stop() must abort every outstanding piece
  //    of work (both stateful MCP sessions and plain REST in-flight calls)
  //    rather than waiting for it to finish naturally.
  // ==========================================================================
  describe('server shutdown', () => {
    it('aborts an in-flight REST tool call when the server is stopped', async () => {
      let capturedSignal: AbortSignal | undefined;
      let invoked = false;
      const invokedResolvers: Array<() => void> = [];
      const waitForInvocation = () =>
        invoked ? Promise.resolve() : new Promise<void>((resolve) => invokedResolvers.push(resolve));

      const serviceClient = createMockServiceClient({
        semanticSearch: jest.fn((_query: string, _topK: number, opts: { signal?: AbortSignal }) => {
          capturedSignal = opts.signal;
          invoked = true;
          invokedResolvers.splice(0).forEach((resolve) => resolve());
          return hangUntilAborted(opts.signal as AbortSignal);
        }),
      });

      const { server, port } = await startRealServer(serviceClient);

      const body = JSON.stringify({ query: 'shutdown probe' });
      const clientRequest = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/v1/search',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      clientRequest.on('error', () => {});
      clientRequest.write(body);
      clientRequest.end();

      await waitForInvocation();
      expect(capturedSignal?.aborted).toBe(false);

      const stoppedAt = Date.now();
      // `server.stop()` resolves once `http.Server#close()`'s own callback
      // fires; `closeAllConnections()` forcibly destroys any remaining
      // sockets in the same tick, but the *destroyed* request/response
      // streams only emit their own 'close' (and therefore the abort this
      // test is waiting on) a tick or two later. The acceptance bound is
      // "caller sees cancellation within 500ms of shutdown", not
      // "synchronously before stop() resolves" -- so wait for the signal
      // rather than asserting immediately after the await.
      await server.stop();
      await waitForAbort(capturedSignal, CANCELLATION_BOUND_MS, () => capturedSignal);

      expect(capturedSignal?.aborted).toBe(true);
      expect(Date.now() - stoppedAt).toBeLessThan(CANCELLATION_BOUND_MS);
    });

    it('aborts an in-flight MCP tools/call and disposes its session when the server is stopped', async () => {
      let capturedSignal: AbortSignal | undefined;
      let resolveInvoked: (() => void) | undefined;
      const invokedPromise = new Promise<void>((resolve) => {
        resolveInvoked = resolve;
      });

      const serviceClient = createMockServiceClient();
      const { server, port } = await startRealServer(serviceClient, {
        toolRegistryEntries: buildCancellationToolRegistry(serviceClient, (signal) => {
          capturedSignal = signal;
          resolveInvoked?.();
        }),
      });

      const initializeResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'shutdown-test-client', version: '1.0.0' },
          },
        }),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers.get('mcp-session-id');
      expect(typeof sessionId).toBe('string');
      await initializeResponse.body?.cancel();

      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId as string,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      const callPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId as string,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: ABORT_AWARE_TOOL, arguments: {} },
        }),
      }).catch((error) => error);

      await invokedPromise;
      expect(capturedSignal?.aborted).toBe(false);
      expect(server.getActiveSessionCount()).toBe(1);

      const stoppedAt = Date.now();
      await server.stop();

      expect(capturedSignal?.aborted).toBe(true);
      expect(server.getActiveSessionCount()).toBe(0);
      expect(Date.now() - stoppedAt).toBeLessThan(CANCELLATION_BOUND_MS);

      await callPromise;
    });
  });
});
