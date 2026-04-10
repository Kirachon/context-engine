import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  transport: 'http' | 'mcp' | 'stdio';
  method?: string;
  path?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createRequestContext(input: Omit<RequestContext, 'requestId'> & { requestId?: string }): RequestContext {
  return {
    requestId: input.requestId?.trim() || randomUUID(),
    transport: input.transport,
    method: input.method,
    path: input.path,
    sessionId: input.sessionId,
  };
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) {
    return;
  }
  Object.assign(current, patch);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function formatRequestLogPrefix(): string {
  const context = storage.getStore();
  if (!context) {
    return '[request:unknown]';
  }
  return `[request:${context.requestId}]`;
}
