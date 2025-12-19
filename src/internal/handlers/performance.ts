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

let cache: InternalCache = disabledCache;
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
