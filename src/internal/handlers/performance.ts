import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { envBool, envInt, envMs } from '../../config/env.js';
import { featureEnabled } from '../../config/features.js';

export interface InternalCache {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T, ttlMs?: number): void;
}

export interface InternalBatcher {
  enqueue(request: unknown): void;
}

export type EmbeddingReuseInputKind = 'document' | 'query';

export interface EmbeddingReuseLookup {
  inputKind: EmbeddingReuseInputKind;
  contentHash: string;
  runtimeId: string;
  modelId: string;
  runtimeGeneration: string;
  vectorDimension: number;
}

export interface InternalEmbeddingVectorEntry extends EmbeddingReuseLookup {
  schemaVersion: 1;
  vector: number[];
  updatedAt: string;
}

export interface InternalEmbeddingReuse {
  get(key: string): InternalEmbeddingVectorEntry | undefined;
  set(key: string, value: InternalEmbeddingVectorEntry): void;
  flush?: () => Promise<void>;
  flushSync?: () => void;
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

const EMBEDDING_REUSE_FILE_NAME = '.context-engine-embedding-cache.json';
const EMBEDDING_REUSE_FILE_VERSION = 1;
const EMBEDDING_REUSE_RUNTIME_GENERATION_PREFIX = 'embedding-reuse-v1';
const DEFAULT_EMBEDDING_REUSE_MAX_ENTRIES = 1_024;
const DEFAULT_EMBEDDING_REUSE_MAX_PERSISTED_BYTES = 8 * 1024 * 1024;
const DEFAULT_EMBEDDING_REUSE_FLUSH_DEBOUNCE_MS = 250;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

type PersistedEmbeddingReuseFile = {
  version: number;
  updated_at: string;
  entries: Record<string, InternalEmbeddingVectorEntry>;
};

export interface InternalEmbeddingReuseOptions {
  cachePath?: string;
  maxEntries?: number;
  maxPersistedBytes?: number;
  flushDebounceMs?: number;
}

type EmbeddingRuntimeIdentity = {
  id: string;
  modelId: string;
  vectorDimension: number;
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

function normalizeVectorDimension(vectorDimension: number): number | null {
  if (!Number.isInteger(vectorDimension) || vectorDimension < 1 || vectorDimension > 4_096) {
    return null;
  }
  return vectorDimension;
}

export function normalizeEmbeddingVector(vector: unknown, expectedDimension: number): number[] | null {
  const safeDimension = normalizeVectorDimension(expectedDimension);
  if (safeDimension === null || !Array.isArray(vector) || vector.length !== safeDimension) {
    return null;
  }

  const normalized: number[] = [];
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    normalized.push(value);
  }
  return normalized;
}

function normalizeEmbeddingReuseLookup(value: Partial<EmbeddingReuseLookup>): EmbeddingReuseLookup | null {
  const inputKind = value.inputKind;
  if (inputKind !== 'document' && inputKind !== 'query') {
    return null;
  }
  const contentHash = value.contentHash?.trim();
  const runtimeId = value.runtimeId?.trim();
  const modelId = value.modelId?.trim();
  const runtimeGeneration = value.runtimeGeneration?.trim();
  const vectorDimension = normalizeVectorDimension(value.vectorDimension ?? 0);
  if (!contentHash || !runtimeId || !modelId || !runtimeGeneration || vectorDimension === null) {
    return null;
  }
  return {
    inputKind,
    contentHash,
    runtimeId,
    modelId,
    runtimeGeneration,
    vectorDimension,
  };
}

function cloneEmbeddingReuseEntry(entry: InternalEmbeddingVectorEntry): InternalEmbeddingVectorEntry {
  return {
    ...entry,
    vector: [...entry.vector],
  };
}

function normalizeEmbeddingReuseEntry(
  value: unknown,
  expected?: EmbeddingReuseLookup
): InternalEmbeddingVectorEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const lookup = normalizeEmbeddingReuseLookup({
    inputKind: (value as Partial<InternalEmbeddingVectorEntry>).inputKind,
    contentHash: (value as Partial<InternalEmbeddingVectorEntry>).contentHash,
    runtimeId: (value as Partial<InternalEmbeddingVectorEntry>).runtimeId,
    modelId: (value as Partial<InternalEmbeddingVectorEntry>).modelId,
    runtimeGeneration: (value as Partial<InternalEmbeddingVectorEntry>).runtimeGeneration,
    vectorDimension: (value as Partial<InternalEmbeddingVectorEntry>).vectorDimension,
  });
  if (!lookup) {
    return null;
  }

  if (expected) {
    if (
      lookup.inputKind !== expected.inputKind
      || lookup.contentHash !== expected.contentHash
      || lookup.runtimeId !== expected.runtimeId
      || lookup.modelId !== expected.modelId
      || lookup.runtimeGeneration !== expected.runtimeGeneration
      || lookup.vectorDimension !== expected.vectorDimension
    ) {
      return null;
    }
  }

  const vector = normalizeEmbeddingVector((value as Partial<InternalEmbeddingVectorEntry>).vector, lookup.vectorDimension);
  if (!vector) {
    return null;
  }

  const schemaVersion = (value as Partial<InternalEmbeddingVectorEntry>).schemaVersion;
  if (schemaVersion !== EMBEDDING_REUSE_FILE_VERSION) {
    return null;
  }

  const updatedAt = typeof (value as Partial<InternalEmbeddingVectorEntry>).updatedAt === 'string'
    ? (value as InternalEmbeddingVectorEntry).updatedAt
    : new Date(0).toISOString();

  return {
    schemaVersion: EMBEDDING_REUSE_FILE_VERSION,
    ...lookup,
    vector,
    updatedAt,
  };
}

export function hashEmbeddingReuseContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildEmbeddingRuntimeGeneration(runtime: EmbeddingRuntimeIdentity): string {
  return [
    EMBEDDING_REUSE_RUNTIME_GENERATION_PREFIX,
    runtime.id,
    runtime.modelId,
    runtime.vectorDimension,
  ].join('|');
}

export function createEmbeddingReuseLookup(
  runtime: EmbeddingRuntimeIdentity,
  inputKind: EmbeddingReuseInputKind,
  contentHash: string
): EmbeddingReuseLookup {
  return {
    inputKind,
    contentHash: contentHash.trim(),
    runtimeId: runtime.id,
    modelId: runtime.modelId,
    runtimeGeneration: buildEmbeddingRuntimeGeneration(runtime),
    vectorDimension: runtime.vectorDimension,
  };
}

export function buildEmbeddingReuseKey(lookup: EmbeddingReuseLookup): string {
  return [
    'embedding',
    lookup.inputKind,
    lookup.runtimeGeneration,
    lookup.contentHash,
  ].join(':');
}

export function createEmbeddingReuseEntry(
  lookup: EmbeddingReuseLookup,
  vector: unknown
): InternalEmbeddingVectorEntry | null {
  return normalizeEmbeddingReuseEntry({
    schemaVersion: EMBEDDING_REUSE_FILE_VERSION,
    ...lookup,
    vector,
    updatedAt: new Date().toISOString(),
  }, lookup);
}

export function getReusableEmbeddingVector(
  reuse: InternalEmbeddingReuse,
  lookup: EmbeddingReuseLookup
): number[] | undefined {
  const cached = reuse.get(buildEmbeddingReuseKey(lookup));
  const normalized = normalizeEmbeddingReuseEntry(cached, lookup);
  return normalized ? [...normalized.vector] : undefined;
}

export function setReusableEmbeddingVector(
  reuse: InternalEmbeddingReuse,
  lookup: EmbeddingReuseLookup,
  vector: unknown
): boolean {
  const entry = createEmbeddingReuseEntry(lookup, vector);
  if (!entry) {
    return false;
  }
  reuse.set(buildEmbeddingReuseKey(lookup), entry);
  return true;
}

class PersistentInternalEmbeddingReuse implements InternalEmbeddingReuse {
  private readonly entries = new Map<string, InternalEmbeddingVectorEntry>();
  private readonly cachePath: string;
  private readonly maxEntries: number;
  private readonly maxPersistedBytes: number;
  private readonly flushDebounceMs: number;
  private readonly warnings = new Set<string>();
  private loaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(options: Required<InternalEmbeddingReuseOptions>) {
    this.cachePath = options.cachePath;
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxPersistedBytes = Math.max(1_024, options.maxPersistedBytes);
    this.flushDebounceMs = Math.max(0, options.flushDebounceMs);
  }

  private warnOnce(code: string, message: string): void {
    if (this.warnings.has(code)) {
      return;
    }
    this.warnings.add(code);
    console.warn(message);
  }

  private evictOldestUntilWithinLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
      this.dirty = true;
    }
  }

  private loadIfNeeded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    if (!fs.existsSync(this.cachePath)) {
      return;
    }

    try {
      const stat = fs.statSync(this.cachePath);
      if (!stat.isFile()) {
        return;
      }
      if (stat.size > this.maxPersistedBytes) {
        this.warnOnce(
          'load-too-large',
          `[embeddingReuse] Skipping persisted cache load because "${this.cachePath}" exceeds ${this.maxPersistedBytes} bytes.`
        );
        return;
      }

      const raw = fs.readFileSync(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedEmbeddingReuseFile>;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== EMBEDDING_REUSE_FILE_VERSION) {
        this.warnOnce(
          'load-invalid-format',
          `[embeddingReuse] Ignoring persisted cache at "${this.cachePath}" because its format is invalid.`
        );
        return;
      }
      if (!parsed.entries || typeof parsed.entries !== 'object') {
        return;
      }

      let droppedInvalidEntries = false;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        const normalized = normalizeEmbeddingReuseEntry(entry);
        if (!normalized || buildEmbeddingReuseKey(normalized) !== key) {
          droppedInvalidEntries = true;
          continue;
        }
        this.entries.set(key, normalized);
        this.evictOldestUntilWithinLimit();
      }
      if (droppedInvalidEntries) {
        this.dirty = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnOnce(
        'load-failed',
        `[embeddingReuse] Failed to load persisted cache from "${this.cachePath}": ${message}`
      );
    }
  }

  private scheduleFlush(): void {
    if (this.flushDebounceMs === 0) {
      void this.flush();
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDebounceMs);
  }

  private buildSerializedPayload(): string {
    while (true) {
      const payload: PersistedEmbeddingReuseFile = {
        version: EMBEDDING_REUSE_FILE_VERSION,
        updated_at: new Date().toISOString(),
        entries: Object.fromEntries(
          [...this.entries.entries()].map(([key, entry]) => [key, cloneEmbeddingReuseEntry(entry)])
        ),
      };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') <= this.maxPersistedBytes) {
        return serialized;
      }

      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        return JSON.stringify({
          version: EMBEDDING_REUSE_FILE_VERSION,
          updated_at: payload.updated_at,
          entries: {},
        });
      }

      this.entries.delete(oldestKey);
      this.warnOnce(
        'persist-trimmed',
        `[embeddingReuse] Trimming persisted cache to stay within ${this.maxPersistedBytes} bytes.`
      );
    }
  }

  get(key: string): InternalEmbeddingVectorEntry | undefined {
    this.loadIfNeeded();
    const existing = this.entries.get(key);
    if (!existing) {
      return undefined;
    }

    const normalized = normalizeEmbeddingReuseEntry(existing);
    if (!normalized || buildEmbeddingReuseKey(normalized) !== key) {
      this.entries.delete(key);
      this.dirty = true;
      this.scheduleFlush();
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, normalized);
    return cloneEmbeddingReuseEntry(normalized);
  }

  set(key: string, value: InternalEmbeddingVectorEntry): void {
    this.loadIfNeeded();
    const normalized = normalizeEmbeddingReuseEntry(value);
    if (!normalized) {
      this.warnOnce(
        'set-invalid-entry',
        '[embeddingReuse] Skipping invalid embedding cache entry because its vector payload is not finite or dimensionally valid.'
      );
      return;
    }
    if (buildEmbeddingReuseKey(normalized) !== key) {
      this.warnOnce(
        'set-key-mismatch',
        '[embeddingReuse] Skipping embedding cache entry because its metadata does not match the provided cache key.'
      );
      return;
    }

    this.entries.delete(key);
    this.entries.set(key, normalized);
    this.dirty = true;
    this.evictOldestUntilWithinLimit();
    this.scheduleFlush();
  }

  private flushInternal(): void {
    this.loadIfNeeded();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) {
      return;
    }

    const tmpPath = `${this.cachePath}.tmp`;
    try {
      const serialized = this.buildSerializedPayload();
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(tmpPath, serialized, 'utf8');
      if (fs.existsSync(this.cachePath)) {
        fs.unlinkSync(this.cachePath);
      }
      fs.renameSync(tmpPath, this.cachePath);
      this.dirty = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnOnce(
        'flush-failed',
        `[embeddingReuse] Failed to persist cache to "${this.cachePath}": ${message}`
      );
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // ignore cleanup failures
      }
    }
  }

  flushSync(): void {
    this.flushInternal();
  }

  async flush(): Promise<void> {
    this.flushInternal();
  }
}

function shouldEnableRequestMemoCache(): boolean {
  return envBool('CE_INTERNAL_REQUEST_CACHE', false) || featureEnabled('retrieval_request_memo_v2');
}

function shouldEnableEmbeddingReuse(): boolean {
  return envBool('CE_INTERNAL_EMBEDDING_REUSE', false);
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

export function createInternalEmbeddingReuse(options: InternalEmbeddingReuseOptions = {}): InternalEmbeddingReuse {
  return new PersistentInternalEmbeddingReuse({
    cachePath: options.cachePath ?? path.join(process.cwd(), EMBEDDING_REUSE_FILE_NAME),
    maxEntries: Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_EMBEDDING_REUSE_MAX_ENTRIES)),
    maxPersistedBytes: Math.max(1_024, Math.floor(options.maxPersistedBytes ?? DEFAULT_EMBEDDING_REUSE_MAX_PERSISTED_BYTES)),
    flushDebounceMs: Math.max(0, Math.floor(options.flushDebounceMs ?? DEFAULT_EMBEDDING_REUSE_FLUSH_DEBOUNCE_MS)),
  });
}

function createDefaultInternalEmbeddingReuse(): InternalEmbeddingReuse {
  if (!shouldEnableEmbeddingReuse()) {
    return disabledEmbeddingReuse;
  }
  return createInternalEmbeddingReuse({
    maxEntries: envInt(
      'CE_INTERNAL_EMBEDDING_REUSE_MAX_ENTRIES',
      DEFAULT_EMBEDDING_REUSE_MAX_ENTRIES,
      { min: 1, max: 100_000 }
    ),
    maxPersistedBytes: envInt(
      'CE_INTERNAL_EMBEDDING_REUSE_MAX_FILE_BYTES',
      DEFAULT_EMBEDDING_REUSE_MAX_PERSISTED_BYTES,
      { min: 1_024, max: 256 * 1024 * 1024 }
    ),
    flushDebounceMs: envMs(
      'CE_INTERNAL_EMBEDDING_REUSE_FLUSH_MS',
      DEFAULT_EMBEDDING_REUSE_FLUSH_DEBOUNCE_MS,
      { min: 0, max: 60_000 }
    ),
  });
}

let cache: InternalCache = createDefaultInternalCache();
let batcher: InternalBatcher = disabledBatcher;
let embeddingReuse: InternalEmbeddingReuse = createDefaultInternalEmbeddingReuse();
let embeddingReuseShutdownHooksRegistered = false;

function flushEmbeddingReuseOnProcessExit(): void {
  if (typeof embeddingReuse.flushSync === 'function') {
    embeddingReuse.flushSync();
    return;
  }
  void embeddingReuse.flush?.();
}

function ensureEmbeddingReuseShutdownHooks(): void {
  if (embeddingReuseShutdownHooksRegistered) {
    return;
  }
  embeddingReuseShutdownHooksRegistered = true;
  process.once('beforeExit', flushEmbeddingReuseOnProcessExit);
  process.once('exit', flushEmbeddingReuseOnProcessExit);
}

ensureEmbeddingReuseShutdownHooks();

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
