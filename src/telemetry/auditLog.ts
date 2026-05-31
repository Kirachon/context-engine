import type { HttpAuthScope } from '../http/authScopes.js';
import type { ContextPolicyReceipt } from '../security/contextPolicy.js';
import { formatPolicyReceiptForLog } from '../security/contextPolicy.js';
import { sanitizeLogContent } from '../security/secretScanner.js';
import { getRequestContext } from './requestContext.js';

export type AuditEventCategory =
  | 'tool_call'
  | 'resource_read'
  | 'redaction'
  | 'task'
  | 'scope_decision';

export type AuditEventOutcome = 'success' | 'error' | 'denied' | 'redacted' | 'blocked';

export interface AuditEventBase {
  category: AuditEventCategory;
  outcome: AuditEventOutcome;
  timestamp: string;
  requestId?: string;
  transport?: string;
}

export interface ToolCallAuditEvent extends AuditEventBase {
  category: 'tool_call';
  tool: string;
  elapsedMs?: number;
  argKeys?: readonly string[];
  errorMessage?: string;
}

export interface ResourceReadAuditEvent extends AuditEventBase {
  category: 'resource_read';
  uri: string;
  path?: string;
  errorMessage?: string;
}

export interface RedactionAuditEvent extends AuditEventBase {
  category: 'redaction';
  uri?: string;
  path?: string;
  policyId?: string;
  reason?: string;
  receiptSummary?: string;
}

export interface TaskAuditEvent extends AuditEventBase {
  category: 'task';
  taskId: string;
  kind: string;
  status: string;
  progressMessage?: string;
  errorMessage?: string;
}

export interface ScopeDecisionAuditEvent extends AuditEventBase {
  category: 'scope_decision';
  authorized: boolean;
  statusCode?: number;
  requiredScope?: HttpAuthScope | null;
  grantedScopes?: readonly HttpAuthScope[];
  method?: string;
  path?: string;
  rpcMethod?: string;
  message?: string;
}

export type AuditEvent =
  | ToolCallAuditEvent
  | ResourceReadAuditEvent
  | RedactionAuditEvent
  | TaskAuditEvent
  | ScopeDecisionAuditEvent;

export type AuditLogSink = (serializedEvent: string, event: AuditEvent) => void;

const DEFAULT_MAX_ARG_SUMMARY_LENGTH = 120;
const DEFAULT_MAX_ERROR_LENGTH = 240;

let auditLogSink: AuditLogSink | null = null;

function defaultAuditLogSink(serializedEvent: string): void {
  console.error(serializedEvent);
}

function resolveSink(): AuditLogSink {
  if (auditLogSink) {
    return auditLogSink;
  }
  return (serializedEvent) => defaultAuditLogSink(serializedEvent);
}

export function setAuditLogSinkForTests(sink: AuditLogSink | null): void {
  auditLogSink = sink;
}

export function resetAuditLogSinkForTests(): void {
  auditLogSink = null;
}

function attachRequestContext<T extends AuditEventBase>(event: T): T {
  const context = getRequestContext();
  if (!context) {
    return event;
  }

  return {
    ...event,
    requestId: context.requestId,
    transport: context.transport,
  };
}

function truncateScrubbed(value: string, maxLength: number): string {
  const scrubbed = sanitizeLogContent(value);
  if (scrubbed.length <= maxLength) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, maxLength)}...[truncated]`;
}

function summarizeArgKeys(args: unknown): readonly string[] | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }

  return Object.keys(args as Record<string, unknown>).sort();
}

export function serializeAuditEvent(event: AuditEvent): string {
  const payload: Record<string, unknown> = {
    audit: true,
    category: event.category,
    outcome: event.outcome,
    timestamp: event.timestamp,
  };

  if (event.requestId) {
    payload.requestId = event.requestId;
  }
  if (event.transport) {
    payload.transport = event.transport;
  }

  switch (event.category) {
    case 'tool_call':
      payload.tool = event.tool;
      if (event.elapsedMs !== undefined) {
        payload.elapsedMs = event.elapsedMs;
      }
      if (event.argKeys?.length) {
        payload.argKeys = event.argKeys;
      }
      if (event.errorMessage) {
        payload.errorMessage = truncateScrubbed(event.errorMessage, DEFAULT_MAX_ERROR_LENGTH);
      }
      break;
    case 'resource_read':
      payload.uri = sanitizeLogContent(event.uri);
      if (event.path) {
        payload.path = sanitizeLogContent(event.path);
      }
      if (event.errorMessage) {
        payload.errorMessage = truncateScrubbed(event.errorMessage, DEFAULT_MAX_ERROR_LENGTH);
      }
      break;
    case 'redaction':
      if (event.uri) {
        payload.uri = sanitizeLogContent(event.uri);
      }
      if (event.path) {
        payload.path = sanitizeLogContent(event.path);
      }
      if (event.policyId) {
        payload.policyId = event.policyId;
      }
      if (event.reason) {
        payload.reason = sanitizeLogContent(event.reason);
      }
      if (event.receiptSummary) {
        payload.receiptSummary = truncateScrubbed(event.receiptSummary, DEFAULT_MAX_ARG_SUMMARY_LENGTH);
      }
      break;
    case 'task':
      payload.taskId = event.taskId;
      payload.kind = event.kind;
      payload.status = event.status;
      if (event.progressMessage) {
        payload.progressMessage = truncateScrubbed(event.progressMessage, DEFAULT_MAX_ARG_SUMMARY_LENGTH);
      }
      if (event.errorMessage) {
        payload.errorMessage = truncateScrubbed(event.errorMessage, DEFAULT_MAX_ERROR_LENGTH);
      }
      break;
    case 'scope_decision':
      payload.authorized = event.authorized;
      if (event.statusCode !== undefined) {
        payload.statusCode = event.statusCode;
      }
      if (event.requiredScope) {
        payload.requiredScope = event.requiredScope;
      }
      if (event.grantedScopes?.length) {
        payload.grantedScopes = [...event.grantedScopes];
      }
      if (event.method) {
        payload.method = event.method;
      }
      if (event.path) {
        payload.path = sanitizeLogContent(event.path);
      }
      if (event.rpcMethod) {
        payload.rpcMethod = sanitizeLogContent(event.rpcMethod);
      }
      if (event.message) {
        payload.message = truncateScrubbed(event.message, DEFAULT_MAX_ERROR_LENGTH);
      }
      break;
    default: {
      const exhaustive: never = event;
      return sanitizeLogContent(JSON.stringify(exhaustive));
    }
  }

  return sanitizeLogContent(JSON.stringify(payload));
}

export function emitAuditEvent(event: AuditEvent): string {
  const enriched = attachRequestContext(event);
  const serialized = serializeAuditEvent(enriched);
  resolveSink()(serialized, enriched);
  return serialized;
}

export function auditLogToolCallStarted(name: string, args: unknown): void {
  emitAuditEvent({
    category: 'tool_call',
    outcome: 'success',
    timestamp: new Date().toISOString(),
    tool: name,
    argKeys: summarizeArgKeys(args),
  });
}

export function auditLogToolCallCompleted(
  name: string,
  outcome: Extract<AuditEventOutcome, 'success' | 'error'>,
  elapsedMs: number,
  errorMessage?: string
): void {
  emitAuditEvent({
    category: 'tool_call',
    outcome,
    timestamp: new Date().toISOString(),
    tool: name,
    elapsedMs,
    errorMessage,
  });
}

export function auditLogResourceRead(
  uri: string,
  outcome: Extract<AuditEventOutcome, 'success' | 'error' | 'redacted' | 'blocked'>,
  options?: { path?: string; errorMessage?: string }
): void {
  emitAuditEvent({
    category: 'resource_read',
    outcome,
    timestamp: new Date().toISOString(),
    uri,
    path: options?.path,
    errorMessage: options?.errorMessage,
  });
}

export function auditLogRedaction(
  receipt: ContextPolicyReceipt,
  options?: { uri?: string }
): void {
  const outcome: Extract<AuditEventOutcome, 'redacted' | 'blocked'> =
    receipt.action === 'block' ? 'blocked' : 'redacted';

  emitAuditEvent({
    category: 'redaction',
    outcome,
    timestamp: new Date().toISOString(),
    uri: options?.uri,
    path: receipt.path,
    policyId: receipt.policyId,
    reason: receipt.reason,
    receiptSummary: formatPolicyReceiptForLog(receipt),
  });
}

export function auditLogTaskLifecycle(
  taskId: string,
  kind: string,
  status: string,
  options?: { progressMessage?: string; errorMessage?: string }
): void {
  const outcome: AuditEventOutcome =
    status === 'failed'
      ? 'error'
      : status === 'cancelled'
        ? 'denied'
        : 'success';

  emitAuditEvent({
    category: 'task',
    outcome,
    timestamp: new Date().toISOString(),
    taskId,
    kind,
    status,
    progressMessage: options?.progressMessage,
    errorMessage: options?.errorMessage,
  });
}

export function auditLogScopeDecision(input: {
  authorized: boolean;
  statusCode?: number;
  requiredScope?: HttpAuthScope | null;
  grantedScopes?: readonly HttpAuthScope[];
  method?: string;
  path?: string;
  rpcMethod?: string;
  message?: string;
}): void {
  emitAuditEvent({
    category: 'scope_decision',
    outcome: input.authorized ? 'success' : 'denied',
    timestamp: new Date().toISOString(),
    authorized: input.authorized,
    statusCode: input.statusCode,
    requiredScope: input.requiredScope,
    grantedScopes: input.grantedScopes,
    method: input.method,
    path: input.path,
    rpcMethod: input.rpcMethod,
    message: input.message,
  });
}
