import {
  evaluateMemoryPressure,
  getRetrievalMemoryGuardrails,
  memoryPressureLevelValue,
  type MemoryPressureSnapshot,
  type MemoryPressureThresholds,
} from '../../src/runtime/memoryPressure.js';

const MEBIBYTE = 1024 * 1024;
const DEFAULT_THRESHOLDS: MemoryPressureThresholds = {
  rssElevatedBytes: 1280 * MEBIBYTE,
  rssHighBytes: 1536 * MEBIBYTE,
  rssCriticalBytes: 1792 * MEBIBYTE,
  heapElevatedRatio: 0.8,
  heapHighRatio: 0.88,
  heapCriticalRatio: 0.94,
};

function buildSnapshot(overrides: Partial<MemoryPressureSnapshot> = {}): MemoryPressureSnapshot {
  return {
    rssBytes: 512 * MEBIBYTE,
    heapUsedBytes: 256 * MEBIBYTE,
    heapTotalBytes: 320 * MEBIBYTE,
    externalBytes: 16 * MEBIBYTE,
    arrayBuffersBytes: 4 * MEBIBYTE,
    heapLimitBytes: 1024 * MEBIBYTE,
    heapUtilization: 0.25,
    ...overrides,
  };
}

describe('memory pressure guardrails', () => {
  it('stays monitoring-only below conservative thresholds', () => {
    const status = evaluateMemoryPressure(buildSnapshot(), DEFAULT_THRESHOLDS);

    expect(status.level).toBe('normal');
    expect(status.reasons).toEqual([]);
    expect(getRetrievalMemoryGuardrails(status)).toEqual({});
    expect(memoryPressureLevelValue(status.level)).toBe(0);
  });

  it('caps fanout and rerank under high pressure', () => {
    const status = evaluateMemoryPressure(
      buildSnapshot({
        heapUsedBytes: 900 * MEBIBYTE,
        heapTotalBytes: 940 * MEBIBYTE,
        heapLimitBytes: 1000 * MEBIBYTE,
        heapUtilization: 0.9,
      }),
      DEFAULT_THRESHOLDS
    );

    expect(status.level).toBe('high');
    expect(status.reasons).toContain('heap_utilization');
    expect(getRetrievalMemoryGuardrails(status)).toEqual({
      fanoutConcurrencyCap: 2,
      disableRerank: true,
    });
    expect(memoryPressureLevelValue(status.level)).toBe(2);
  });

  it('caps variants only at critical pressure', () => {
    const status = evaluateMemoryPressure(
      buildSnapshot({
        rssBytes: 1900 * MEBIBYTE,
        heapUsedBytes: 950 * MEBIBYTE,
        heapTotalBytes: 980 * MEBIBYTE,
        heapLimitBytes: 1000 * MEBIBYTE,
        heapUtilization: 0.95,
      }),
      DEFAULT_THRESHOLDS
    );

    expect(status.level).toBe('critical');
    expect(status.reasons).toEqual(expect.arrayContaining(['heap_utilization', 'rss_bytes']));
    expect(getRetrievalMemoryGuardrails(status)).toEqual({
      fanoutConcurrencyCap: 1,
      maxVariantsCap: 1,
      disableRerank: true,
    });
    expect(memoryPressureLevelValue(status.level)).toBe(3);
  });
});
