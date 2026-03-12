import { envBool, envInt, envMs } from '../../config/env.js';
import { featureEnabled } from '../../config/features.js';

export interface InternalCache {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T, ttlMs?: number): void;
}

export interface InternalBatcher {
  enqueue(request: unknown): void;
}

export interface InternalEmbeddingReuse {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

const disabledCache: InternalCache = {
  get: () => undefined,
  set: () => undefined,
};

const disabledBatcher: InternalBatcher = {
  enqueue: () => undefined,
};

const disabledEmbeddingReuse: InternalEmbeddingReuse = {
  get: () => undefined,
  set: () => undefined,
};

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

class InProcessInternalCache implements InternalCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private readonly sweepLimitPerPass: number;
  private lastSweepAtMs = 0;

  constructor(defaultTtlMs: number, maxEntries: number, sweepIntervalMs: number, sweepLimitPerPass: number) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = Math.max(1, maxEntries);
    this.sweepIntervalMs = Math.max(100, sweepIntervalMs);
    this.sweepLimitPerPass = Math.max(1, sweepLimitPerPass);
  }

  private sweepExpiredEntries(now: number): void {
    if (now - this.lastSweepAtMs < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAtMs = now;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
        if (removed >= this.sweepLimitPerPass) {
          break;
        }
      }
    }
  }

  private evictOldestUntilWithinLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  get<T = unknown>(key: string): T | undefined {
    const now = Date.now();
    this.sweepExpiredEntries(now);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): void {
    const effectiveTtlMs = Math.max(1, ttlMs ?? this.defaultTtlMs);
    const now = Date.now();
    this.sweepExpiredEntries(now);
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: now + effectiveTtlMs,
    });
    this.evictOldestUntilWithinLimit();
  }
}

function shouldEnableRequestMemoCache(): boolean {
  return envBool('CE_INTERNAL_REQUEST_CACHE', false) || featureEnabled('retrieval_request_memo_v2');
}

function createDefaultInternalCache(): InternalCache {
  if (!shouldEnableRequestMemoCache()) {
    return disabledCache;
  }
  const ttlMs = envMs('CE_INTERNAL_REQUEST_CACHE_TTL_MS', 15_000, { min: 100, max: 300_000 });
  const maxEntries = envInt('CE_INTERNAL_REQUEST_CACHE_MAX_ENTRIES', 2_000, { min: 100, max: 50_000 });
  const sweepIntervalMs = envMs('CE_INTERNAL_REQUEST_CACHE_SWEEP_INTERVAL_MS', 1_000, { min: 100, max: 60_000 });
  const sweepLimitPerPass = envInt('CE_INTERNAL_REQUEST_CACHE_SWEEP_LIMIT', 128, { min: 1, max: 5_000 });
  return new InProcessInternalCache(ttlMs, maxEntries, sweepIntervalMs, sweepLimitPerPass);
}

let cache: InternalCache = createDefaultInternalCache();
let batcher: InternalBatcher = disabledBatcher;
let embeddingReuse: InternalEmbeddingReuse = disabledEmbeddingReuse;

export function getInternalCache(): InternalCache {
  return cache;
}

export function getInternalBatcher(): InternalBatcher {
  return batcher;
}

export function getInternalEmbeddingReuse(): InternalEmbeddingReuse {
  return embeddingReuse;
}

export function setInternalCache(next?: InternalCache): void {
  cache = next ?? disabledCache;
}

export function setInternalBatcher(next?: InternalBatcher): void {
  batcher = next ?? disabledBatcher;
}

export function setInternalEmbeddingReuse(next?: InternalEmbeddingReuse): void {
  embeddingReuse = next ?? disabledEmbeddingReuse;
}
