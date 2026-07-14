import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';

import { createHttpAuthMiddleware } from '../../src/http/middleware/httpAuth.js';
import { executeToolCall } from '../../src/mcp/executeTool.js';
import { readResourceByUri } from '../../src/mcp/resources/resourceRouter.js';
import { createTaskManager } from '../../src/mcp/tasks/taskManager.js';
import { evaluateContextResourcePolicy, formatPolicyReceiptForLog } from '../../src/security/contextPolicy.js';
import { sanitizeLogContent } from '../../src/security/secretScanner.js';
import {
  auditLogRedaction,
  auditLogScopeDecision,
  auditLogToolCallCompleted,
  auditLogToolCallStarted,
  emitAuditEvent,
  resetAuditLogSinkForTests,
  serializeAuditEvent,
  setAuditLogSinkForTests,
  type AuditEvent,
} from '../../src/telemetry/auditLog.js';
import { runWithRequestContext } from '../../src/telemetry/requestContext.js';
import {
  ServiceClientRuntimeAccess,
  type RuntimeSearchQueueLike,
  type ServiceClientRuntimeAccessOptions,
} from '../../src/mcp/serviceClientRuntimeAccess.js';
import { retrieve } from '../../src/internal/retrieval/retrieve.js';

const SECRET_FIXTURES = {
  authHeader: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret.payload',
  githubToken: `ghp_${'a'.repeat(36)}`,
  openAiKey: `sk-proj-${'z'.repeat(90)}`,
  rawEnv: `OPENAI_API_KEY=sk-proj-${'z'.repeat(90)}\nDATABASE_URL=postgres://user:supersecret@db.internal:5432/app`,
  requestBody: JSON.stringify({
    method: 'tools/call',
    params: {
      name: 'semantic_search',
      arguments: {
        query: 'auth flow',
        apiKey: `sk-proj-${'x'.repeat(90)}`,
      },
    },
  }),
  fileContent: `export const TOKEN = '${`ghp_${'b'.repeat(36)}`}';\n`.repeat(200),
  bearerToken: `Bearer ${'t'.repeat(48)}`,
} as const;

function createWorkspace(): string {
  return process.cwd();
}

function collectAuditOutput(events: string[]): void {
  setAuditLogSinkForTests((serialized) => {
    events.push(serialized);
  });
}

function assertNoSecretsInOutput(output: string): void {
  expect(output).not.toContain('supersecret');
  expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  expect(output).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  expect(output).not.toMatch(/sk-proj-[A-Za-z0-9]{20,}/);
  expect(output).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i);
  expect(output).not.toContain(SECRET_FIXTURES.rawEnv);
  expect(output).not.toContain(SECRET_FIXTURES.fileContent.slice(0, 80));
}

describe('auditLog secret hygiene', () => {
  let capturedEvents: string[];

  beforeEach(() => {
    capturedEvents = [];
    collectAuditOutput(capturedEvents);
  });

  afterEach(() => {
    resetAuditLogSinkForTests();
  });

  it('scrubs auth headers, tokens, and raw .env via sanitizeLogContent', () => {
    const scrubbed = sanitizeLogContent(
      `${SECRET_FIXTURES.authHeader}\n${SECRET_FIXTURES.rawEnv}\n${SECRET_FIXTURES.githubToken}`
    );

    assertNoSecretsInOutput(scrubbed);
    expect(scrubbed).toMatch(/authorization: \[REDACTED\]/i);
  });

  it('does not emit tool arg values, request bodies, or full file contents in tool audit logs', async () => {
    const handler = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    await executeToolCall({
      name: 'semantic_search',
      args: {
        query: SECRET_FIXTURES.requestBody,
        diff: SECRET_FIXTURES.fileContent,
        token: SECRET_FIXTURES.openAiKey,
      },
      toolHandlers: new Map([['semantic_search', handler]]),
      log: () => undefined,
    });

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"tool_call"');
    expect(output).toContain('"tool":"semantic_search"');
    expect(output).toContain('"argKeys"');
    expect(output).not.toMatch(/"query"\s*:\s*"/);
    expect(output).not.toMatch(/"diff"\s*:\s*"/);
    expect(output).not.toMatch(/"token"\s*:\s*"/);
    expect(output).not.toContain(SECRET_FIXTURES.fileContent.slice(0, 120));
  });

  it('scrubs error messages and omits request body secrets from scope decision logs', () => {
    auditLogScopeDecision({
      authorized: false,
      statusCode: 403,
      requiredScope: 'tools:write',
      grantedScopes: ['tools:read'],
      method: 'POST',
      path: '/mcp',
      rpcMethod: 'tools/call',
      message: `${SECRET_FIXTURES.authHeader} ${SECRET_FIXTURES.requestBody}`,
    });

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"scope_decision"');
    expect(output).toContain('"authorized":false');
    expect(output).toContain('"requiredScope":"tools:write"');
    expect(output).not.toContain('tools:write","apiKey"');
  });

  it('logs redactions without raw secret content from policy receipts', () => {
    const receipt = evaluateContextResourcePolicy({
      workspaceRoot: createWorkspace(),
      requestedPath: '.env',
      mode: 'strict',
    }).receipts[0]!;

    auditLogRedaction(
      {
        ...receipt,
        message: `${SECRET_FIXTURES.authHeader} ${SECRET_FIXTURES.rawEnv}`,
      },
      { uri: 'context-engine://files/.env' }
    );

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"redaction"');
    expect(output).toContain('"uri":"context-engine://files/.env"');
    expect(formatPolicyReceiptForLog({
      ...receipt,
      message: `${SECRET_FIXTURES.authHeader} ${SECRET_FIXTURES.rawEnv}`,
    })).not.toContain('sk-proj-');
  });

  it('logs resource reads without returning or logging full file contents', async () => {
    await expect(
      readResourceByUri('context-engine://files/does-not-exist.ts', {
        workspaceRoot: createWorkspace(),
      })
    ).rejects.toThrow();

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"resource_read"');
    expect(output).toContain('context-engine://files/does-not-exist.ts');
  });

  it('logs task lifecycle without task result payloads or secrets', () => {
    const taskManager = createTaskManager();
    const task = taskManager.createTask({
      kind: 'review_diff',
      progress: {
        message: `Running with ${SECRET_FIXTURES.bearerToken}`,
      },
    });

    taskManager.markTaskFailed(task.id, `Failed: ${SECRET_FIXTURES.openAiKey}`);

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"task"');
    expect(output).toContain('"kind":"review_diff"');
    expect(output).toContain('"status":"failed"');
    expect(output).not.toContain('"result"');
  });

  it('includes request context metadata without secrets', () => {
    runWithRequestContext(
      {
        requestId: 'req-test-123',
        transport: 'http',
        method: 'POST',
        path: '/mcp',
      },
      () => {
        auditLogToolCallStarted('get_file', {
          path: '.env',
          secret: SECRET_FIXTURES.openAiKey,
        });
      }
    );

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"requestId":"req-test-123"');
    expect(output).toContain('"transport":"http"');
  });

  it('http auth middleware emits scope decisions without bearer tokens', () => {
    const previousAuthEnabled = process.env.CONTEXT_ENGINE_HTTP_AUTH_ENABLED;
    const previousTokens = process.env.CONTEXT_ENGINE_HTTP_AUTH_TOKENS;

    process.env.CONTEXT_ENGINE_HTTP_AUTH_ENABLED = 'true';
    process.env.CONTEXT_ENGINE_HTTP_AUTH_TOKENS = JSON.stringify({
      [`reader-${SECRET_FIXTURES.githubToken}`]: ['tools:read'],
    });

    const middleware = createHttpAuthMiddleware();
    const next = jest.fn();
    const req = {
      method: 'GET',
      path: '/status',
      headers: {
        authorization: `Bearer reader-${SECRET_FIXTURES.githubToken}`,
      },
      body: JSON.parse(SECRET_FIXTURES.requestBody),
    } as unknown as Request;

    middleware(req, {} as never, next);

    const output = capturedEvents.join('\n');
    assertNoSecretsInOutput(output);
    expect(output).toContain('"category":"scope_decision"');
    expect(output).toContain('"authorized":true');
    expect(next).toHaveBeenCalled();

    if (previousAuthEnabled === undefined) {
      delete process.env.CONTEXT_ENGINE_HTTP_AUTH_ENABLED;
    } else {
      process.env.CONTEXT_ENGINE_HTTP_AUTH_ENABLED = previousAuthEnabled;
    }

    if (previousTokens === undefined) {
      delete process.env.CONTEXT_ENGINE_HTTP_AUTH_TOKENS;
    } else {
      process.env.CONTEXT_ENGINE_HTTP_AUTH_TOKENS = previousTokens;
    }
  });

  it('serializes audit events as scrubbed JSON', () => {
    const serialized = serializeAuditEvent({
      category: 'tool_call',
      outcome: 'error',
      timestamp: new Date().toISOString(),
      tool: 'enhance_prompt',
      elapsedMs: 12,
      errorMessage: SECRET_FIXTURES.authHeader,
    });

    assertNoSecretsInOutput(serialized);
    expect(() => JSON.parse(serialized.replace(/\.\.\.\[truncated.*?\]/g, ''))).not.toThrow();
  });

  it('emitAuditEvent never writes unsanitized nested secret payloads', () => {
    const event: AuditEvent = {
      category: 'scope_decision',
      outcome: 'denied',
      timestamp: new Date().toISOString(),
      authorized: false,
      message: SECRET_FIXTURES.rawEnv,
      rpcMethod: 'resources/read',
      path: '/mcp',
      method: 'POST',
    };

    const serialized = emitAuditEvent(event);
    assertNoSecretsInOutput(serialized);
    auditLogToolCallCompleted('review_diff', 'success', 4, SECRET_FIXTURES.openAiKey);
    assertNoSecretsInOutput(capturedEvents.join('\n'));
  });
});

describe('query-derived logging privacy (S2)', () => {
  // Secret-bearing canary embedded in the query text itself. Default
  // diagnostics must never contain the raw query, so this canary must never
  // appear in captured stderr/stdout regardless of success or failure paths.
  const QUERY_CANARY = `sk-proj-CANARY-${'q'.repeat(40)}`;

  function createFakeSearchQueue(): RuntimeSearchQueueLike {
    return {
      length: 0,
      depth: 0,
      enqueue: async (fn) => fn(),
    };
  }

  function createRuntimeAccess(providerCall: (...args: unknown[]) => Promise<{ text: string; model: string }>): ServiceClientRuntimeAccess {
    const options: ServiceClientRuntimeAccessOptions = {
      workspacePath: process.cwd(),
      getAIProviderId: () => 'openai_session' as never,
      getCachedProvider: () =>
        ({
          id: 'openai_session',
          modelLabel: 'codex-session',
          call: providerCall,
        }) as never,
      setCachedProvider: () => undefined,
    };
    return new ServiceClientRuntimeAccess(options);
  }

  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function capturedConsoleErrorOutput(): string {
    return consoleErrorSpy.mock.calls
      .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
      .join('\n');
  }

  it('searchAndAsk never logs the raw query on success', async () => {
    const runtime = createRuntimeAccess(async () => ({ text: 'ok', model: 'codex-session' }));

    await runtime.searchAndAsk({
      searchQuery: QUERY_CANARY,
      searchQueues: {
        interactive: createFakeSearchQueue(),
        background: createFakeSearchQueue(),
      },
    });

    const output = capturedConsoleErrorOutput();
    expect(output).not.toContain(QUERY_CANARY);
    expect(output).toContain('[searchAndAsk]');
    expect(output).toMatch(/queryLength=\d+/);
  });

  it('searchAndAsk never logs the raw query on provider failure', async () => {
    const runtime = createRuntimeAccess(async () => {
      throw new Error('provider unavailable');
    });

    await expect(
      runtime.searchAndAsk({
        searchQuery: QUERY_CANARY,
        searchQueues: {
          interactive: createFakeSearchQueue(),
          background: createFakeSearchQueue(),
        },
      })
    ).rejects.toThrow('provider unavailable');

    const output = capturedConsoleErrorOutput();
    expect(output).not.toContain(QUERY_CANARY);
    expect(output).toContain('outcome=error');
  });

  it('retrieve() fanout failure logs never contain the raw query variant text', async () => {
    const serviceClient = {
      semanticSearch: jest.fn(async () => {
        throw new Error('semantic backend down');
      }),
      localKeywordSearch: jest.fn(async () => {
        throw new Error('lexical backend down');
      }),
    } as never;

    const denseProvider = {
      id: 'dense:test',
      search: jest.fn(async () => {
        throw new Error('dense backend down');
      }),
    };

    const results = await retrieve(QUERY_CANARY, serviceClient, {
      enableExpansion: false,
      enableLexical: true,
      enableDense: true,
      denseProvider,
      enableFusion: true,
      topK: 5,
      log: true,
    });

    expect(results).toEqual([]);
    const output = capturedConsoleErrorOutput();
    expect(output).not.toContain(QUERY_CANARY);
    expect(output).toMatch(/\[retrieve\] Semantic fanout failed/);
    expect(output).toMatch(/\[retrieve\] Lexical fanout failed/);
    expect(output).toMatch(/\[retrieve\] Dense fanout failed/);
    expect(output).toMatch(/queryLength=\d+/);
  });
});
