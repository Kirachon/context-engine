import type { InternalCache } from '../handlers/performance.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface InternalLRUCacheOptions {
  maxEntries: number;
  defaultTtlMs: number;
}

/**
 * Small in-process LRU+TTL cache for internal handlers.
 *
 * Uses Map insertion order for O(1) LRU behavior:
 * - touch on get via delete+set
 * - evict oldest via keys().next()
 */
export class InternalLRUCache implements InternalCache {
  private store = new Map<string, Entry<unknown>>();

  constructor(private options: InternalLRUCacheOptions) {}

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Touch for LRU
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as T;
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): void {
    const effectiveTtlMs = ttlMs ?? this.options.defaultTtlMs;
    const expiresAt = effectiveTtlMs > 0 ? Date.now() + effectiveTtlMs : Number.POSITIVE_INFINITY;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.options.maxEntries) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, { value, expiresAt });
  }
}

