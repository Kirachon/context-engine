import { describe, expect, it } from '@jest/globals';

import {
  assembleContextPack,
  getContextPackStore,
  initializeContextPackStore,
  resetContextPackStoreForTests,
} from '../../src/context/index.js';
import {
  executeToolCall,
  type ExecuteToolCallParams,
  type SignalAwareToolHandler,
} from '../../src/mcp/executeTool.js';
import {
  errorResult,
  isToolResult,
  normalizeToolResult,
  okResult,
} from '../../src/mcp/formatting/index.js';
import {
  buildResourceList,
  buildResourceTemplateList,
  readResourceByUri,
} from '../../src/mcp/resources/index.js';
import {
  assessPathSafety,
  evaluateContextResourcePolicy,
  sanitizeLogContent,
} from '../../src/security/index.js';
import {
  auditLogToolCallCompleted,
  auditLogToolCallStarted,
  emitAuditEvent,
  serializeAuditEvent,
} from '../../src/telemetry/index.js';

describe('module boundaries', () => {
  it('exposes result formatting helpers from the formatting barrel', () => {
    expect(typeof okResult).toBe('function');
    expect(typeof errorResult).toBe('function');
    expect(typeof normalizeToolResult).toBe('function');
    expect(typeof isToolResult).toBe('function');

    const structured = okResult('hello', { schema_version: 1 });
    expect(normalizeToolResult(structured)).toEqual(structured);
    expect(isToolResult(normalizeToolResult('legacy text'))).toBe(true);
  });

  it('exposes tool execution from executeTool module', () => {
    expect(typeof executeToolCall).toBe('function');

    const handler: SignalAwareToolHandler = async () => 'ok';
    const params: ExecuteToolCallParams = {
      name: 'index_status',
      args: {},
      toolHandlers: new Map([['index_status', handler]]),
    };

    expect(params.name).toBe('index_status');
    expect(typeof handler).toBe('function');
  });

  it('exposes resource routing from the resources barrel', () => {
    expect(typeof buildResourceList).toBe('function');
    expect(typeof buildResourceTemplateList).toBe('function');
    expect(typeof readResourceByUri).toBe('function');
  });

  it('exposes context pack lifecycle from the context barrel', () => {
    expect(typeof initializeContextPackStore).toBe('function');
    expect(typeof getContextPackStore).toBe('function');
    expect(typeof resetContextPackStoreForTests).toBe('function');
    expect(typeof assembleContextPack).toBe('function');
  });

  it('exposes policy and safety helpers from the security barrel', () => {
    expect(typeof evaluateContextResourcePolicy).toBe('function');
    expect(typeof assessPathSafety).toBe('function');
    expect(typeof sanitizeLogContent).toBe('function');
  });

  it('exposes audit logging from the telemetry barrel', () => {
    expect(typeof auditLogToolCallStarted).toBe('function');
    expect(typeof auditLogToolCallCompleted).toBe('function');
    expect(typeof emitAuditEvent).toBe('function');
    expect(typeof serializeAuditEvent).toBe('function');

    const serialized = serializeAuditEvent({
      category: 'tool_call',
      outcome: 'success',
      timestamp: '2026-05-31T00:00:00.000Z',
      tool: 'index_status',
    });
    expect(serialized).toContain('"audit":true');
    expect(serialized).toContain('"tool":"index_status"');
  });
});
