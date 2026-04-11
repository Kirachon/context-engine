import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildEmbeddingReuseKey,
  createEmbeddingReuseLookup,
  createInternalEmbeddingReuse,
  getReusableEmbeddingVector,
  hashEmbeddingReuseContent,
  setReusableEmbeddingVector,
} from '../../../src/internal/handlers/performance.js';

describe('internal/handlers/performance embedding reuse', () => {
  it('rejects NaN and Infinity vectors before they can be reused or persisted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embedding-reuse-'));
    const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
    const cache = createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 16,
      maxPersistedBytes: 256 * 1024,
    });
    const lookup = createEmbeddingReuseLookup(
      { id: 'hash-3', modelId: 'hash-3', vectorDimension: 3 },
      'query',
      'query-hash'
    );
    const key = buildEmbeddingReuseKey(lookup);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    cache.set(key, {
      schemaVersion: 1,
      ...lookup,
      vector: [Number.NaN, 0, 0],
      updatedAt: new Date().toISOString(),
    });
    cache.set(key, {
      schemaVersion: 1,
      ...lookup,
      vector: [Number.POSITIVE_INFINITY, 0, 0],
      updatedAt: new Date().toISOString(),
    });

    await cache.flush?.();

    expect(cache.get(key)).toBeUndefined();
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { entries?: Record<string, unknown> };
      expect(Object.keys(parsed.entries ?? {})).toHaveLength(0);
    }
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scopes reusable vectors by content hash and returns defensive copies', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embedding-reuse-'));
    const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
    const cache = createInternalEmbeddingReuse({
      cachePath,
      flushDebounceMs: 0,
      maxEntries: 16,
      maxPersistedBytes: 256 * 1024,
    });
    const runtime = { id: 'runtime-a', modelId: 'model-a', vectorDimension: 3 };
    const originalLookup = createEmbeddingReuseLookup(
      runtime,
      'document',
      hashEmbeddingReuseContent('export const alpha = 1;')
    );
    const changedLookup = createEmbeddingReuseLookup(
      runtime,
      'document',
      hashEmbeddingReuseContent('export const alpha = 2;')
    );
    const queryLookup = createEmbeddingReuseLookup(
      runtime,
      'query',
      originalLookup.contentHash
    );

    expect(setReusableEmbeddingVector(cache, originalLookup, [1, 2, 3])).toBe(true);
    await cache.flush?.();

    const firstRead = getReusableEmbeddingVector(cache, originalLookup);

    expect(firstRead).toEqual([1, 2, 3]);
    expect(getReusableEmbeddingVector(cache, changedLookup)).toBeUndefined();
    expect(getReusableEmbeddingVector(cache, queryLookup)).toBeUndefined();

    firstRead![0] = 999;

    expect(getReusableEmbeddingVector(cache, originalLookup)).toEqual([1, 2, 3]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists the latest debounced write for a reused key', async () => {
    jest.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embedding-reuse-'));

    try {
      const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
      const lookup = createEmbeddingReuseLookup(
        { id: 'runtime-a', modelId: 'model-a', vectorDimension: 3 },
        'query',
        'query-hash'
      );
      const cache = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 25,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(setReusableEmbeddingVector(cache, lookup, [1, 0, 0])).toBe(true);
      expect(setReusableEmbeddingVector(cache, lookup, [0, 1, 0])).toBe(true);

      await jest.advanceTimersByTimeAsync(30);
      await cache.flush?.();

      const reloaded = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 0,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(getReusableEmbeddingVector(reloaded, lookup)).toEqual([0, 1, 0]);
    } finally {
      jest.useRealTimers();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('restarts the debounce window when newer writes arrive', async () => {
    jest.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embedding-reuse-'));

    try {
      const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
      const lookup = createEmbeddingReuseLookup(
        { id: 'runtime-a', modelId: 'model-a', vectorDimension: 3 },
        'query',
        'query-hash'
      );
      const cache = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 25,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(setReusableEmbeddingVector(cache, lookup, [1, 0, 0])).toBe(true);
      await jest.advanceTimersByTimeAsync(20);
      expect(setReusableEmbeddingVector(cache, lookup, [0, 1, 0])).toBe(true);

      await jest.advanceTimersByTimeAsync(10);
      expect(fs.existsSync(cachePath)).toBe(false);

      await jest.advanceTimersByTimeAsync(20);

      const reloaded = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 0,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(getReusableEmbeddingVector(reloaded, lookup)).toEqual([0, 1, 0]);
    } finally {
      jest.useRealTimers();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persists repeated flushes to the same cache path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embedding-reuse-'));

    try {
      const cachePath = path.join(tmp, '.context-engine-embedding-cache.json');
      const lookup = createEmbeddingReuseLookup(
        { id: 'runtime-a', modelId: 'model-a', vectorDimension: 3 },
        'query',
        'query-hash'
      );
      const cache = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 0,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(setReusableEmbeddingVector(cache, lookup, [1, 0, 0])).toBe(true);
      await cache.flush?.();
      expect(setReusableEmbeddingVector(cache, lookup, [0, 1, 0])).toBe(true);
      await cache.flush?.();

      const reloaded = createInternalEmbeddingReuse({
        cachePath,
        flushDebounceMs: 0,
        maxEntries: 16,
        maxPersistedBytes: 256 * 1024,
      });

      expect(getReusableEmbeddingVector(reloaded, lookup)).toEqual([0, 1, 0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
