import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_SCOPE_KEY_VERSION = 'v1';
const UNSAFE_VALUE = Symbol('unsafe-cache-value');

function normalizeStableValue(value: unknown, seen: Set<object>): unknown | typeof UNSAFE_VALUE {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : UNSAFE_VALUE;
  }
  if (typeof value === 'undefined') {
    return UNSAFE_VALUE;
  }
  if (typeof value !== 'object') {
    return UNSAFE_VALUE;
  }
  if (seen.has(value)) {
    return UNSAFE_VALUE;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: unknown[] = [];
      for (const item of value) {
        const next = normalizeStableValue(item, seen);
        if (next === UNSAFE_VALUE) return UNSAFE_VALUE;
        normalized.push(next);
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return UNSAFE_VALUE;
    }

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (typeof entry === 'undefined') continue;
      const next = normalizeStableValue(entry, seen);
      if (next === UNSAFE_VALUE) return UNSAFE_VALUE;
      normalized[key] = next;
    }
    return normalized;
  } catch {
    return UNSAFE_VALUE;
  } finally {
    seen.delete(value);
  }
}

export function stableCacheScopeJson(value: unknown): string | null {
  const normalized = normalizeStableValue(value, new Set<object>());
  if (normalized === UNSAFE_VALUE) return null;
  try {
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
}

export function fingerprintCacheScopeValue(value: unknown): string | null {
  const serialized = stableCacheScopeJson(value);
  if (serialized === null) return null;
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export function canonicalWorkspacePath(workspacePath: string): string | null {
  if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) return null;
  try {
    const resolved = fs.realpathSync.native(path.resolve(workspacePath));
    if (!fs.statSync(resolved).isDirectory()) return null;
    const normalized = path.normalize(resolved).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}

export function createResultCacheScope(input: {
  workspacePath: string;
  liveCorpusFingerprint: string | null;
  providerRuntime: unknown;
  indexState: unknown;
}): string | null {
  if (!input.liveCorpusFingerprint) return null;
  const workspacePath = canonicalWorkspacePath(input.workspacePath);
  if (!workspacePath) return null;
  const identity = {
    version: CACHE_SCOPE_KEY_VERSION,
    workspacePath,
    liveCorpusFingerprint: input.liveCorpusFingerprint,
    providerRuntime: input.providerRuntime,
    indexState: input.indexState,
  };
  const fingerprint = fingerprintCacheScopeValue(identity);
  return fingerprint ? `ce-result-scope:${CACHE_SCOPE_KEY_VERSION}:${fingerprint}` : null;
}

export function buildScopedCacheKey(
  scope: string | null,
  namespace: string,
  identity: unknown
): string | null {
  if (!scope || !namespace.trim()) return null;
  const fingerprint = fingerprintCacheScopeValue(identity);
  return fingerprint
    ? `ce-result-cache:${CACHE_SCOPE_KEY_VERSION}:${namespace}:${scope}:${fingerprint}`
    : null;
}

export async function getResultCacheScope(client: unknown, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) return null;
  const getter = (client as { getResultCacheScope?: unknown }).getResultCacheScope;
  if (typeof getter !== 'function') return null;
  try {
    const value = await getter.call(client, signal);
    signal?.throwIfAborted();
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export async function getContextResultCacheScope(
  client: unknown,
  query: string,
  options: unknown
): Promise<string | null> {
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) return null;
  const getter = (client as { getContextCacheScope?: unknown }).getContextCacheScope;
  if (typeof getter !== 'function') return null;
  try {
    const value = await getter.call(client, query, options);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
