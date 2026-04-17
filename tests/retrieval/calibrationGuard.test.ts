import { describe, expect, it } from '@jest/globals';
import {
  computeQualityWarnings,
  type QualityWarning,
} from '../../src/internal/retrieval/rankingCalibration.js';
import type { EmbeddingRuntimeStatus } from '../../src/internal/retrieval/embeddingRuntime.js';

function makeStatus(overrides: Partial<EmbeddingRuntimeStatus> = {}): EmbeddingRuntimeStatus {
  return {
    state: 'healthy',
    configured: { id: 'transformers:Xenova/all-MiniLM-L6-v2', modelId: 'Xenova/all-MiniLM-L6-v2', vectorDimension: 384 },
    active: { id: 'transformers:Xenova/all-MiniLM-L6-v2', modelId: 'Xenova/all-MiniLM-L6-v2', vectorDimension: 384 },
    fallback: { id: 'hash-32', modelId: 'hash-32', vectorDimension: 32 },
    loadFailures: 0,
    hashFallbackActive: false,
    downgrade: null,
    ...overrides,
  };
}

function assertShape(warning: QualityWarning): void {
  expect(typeof warning.code).toBe('string');
  expect(warning.code.length).toBeGreaterThan(0);
  expect(['info', 'warn', 'error']).toContain(warning.severity);
  expect(typeof warning.detail).toBe('string');
  expect(warning.detail.trim().length).toBeGreaterThan(0);
}

describe('computeQualityWarnings', () => {
  it('returns no warnings when runtime is healthy and reranker is enabled', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: makeStatus(),
      rerankEnabled: true,
    });
    expect(warnings).toEqual([]);
  });

  it('reports hash-fallback when embedding runtime status is undefined', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: undefined,
      rerankEnabled: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('embedding_hash_fallback');
    warnings.forEach(assertShape);
  });

  it('reports hash-fallback when active runtime is hash but configured is transformer', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: makeStatus({
        state: 'degraded',
        active: { id: 'hash-32', modelId: 'hash-32', vectorDimension: 32 },
        hashFallbackActive: true,
        downgrade: { reason: 'transformer_load_failed', since: '2026-01-01T00:00:00.000Z' },
        loadFailures: 3,
        lastFailure: 'boom',
      }),
      rerankEnabled: true,
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('embedding_hash_fallback');
    expect(codes).toContain('embedding_runtime_degraded');
    warnings.forEach(assertShape);
  });

  it('reports reranker_disabled when rerankEnabled is false', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: makeStatus(),
      rerankEnabled: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('reranker_disabled');
    warnings.forEach(assertShape);
  });

  it('reports reranker_fallback when a fallback reason is provided', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: makeStatus(),
      rerankEnabled: true,
      rerankFallbackReason: 'rerank_error',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('reranker_fallback');
    expect(warnings[0].detail).toContain('rerank_error');
    warnings.forEach(assertShape);
  });

  it('treats fallback reason of "none" as no reranker fallback warning', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: makeStatus(),
      rerankEnabled: true,
      rerankFallbackReason: 'none',
    });
    expect(warnings).toEqual([]);
  });

  it('reports both hash-fallback and reranker_disabled when both conditions hold', () => {
    const warnings = computeQualityWarnings({
      embeddingRuntimeStatus: undefined,
      rerankEnabled: false,
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('embedding_hash_fallback');
    expect(codes).toContain('reranker_disabled');
    warnings.forEach(assertShape);
  });

  it('emits the hash-fallback warning on every call (no caching/suppression)', () => {
    const ctx = { embeddingRuntimeStatus: undefined, rerankEnabled: true };
    const first = computeQualityWarnings(ctx);
    const second = computeQualityWarnings(ctx);
    expect(first.map((w) => w.code)).toContain('embedding_hash_fallback');
    expect(second.map((w) => w.code)).toContain('embedding_hash_fallback');
    expect(first).toEqual(second);
  });
});
