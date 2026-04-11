import * as v8 from 'node:v8';
import { envInt } from '../config/env.js';

export type MemoryPressureLevel = 'normal' | 'elevated' | 'high' | 'critical';

export interface MemoryPressureSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapLimitBytes: number;
  heapUtilization: number;
}

export interface MemoryPressureThresholds {
  rssElevatedBytes: number;
  rssHighBytes: number;
  rssCriticalBytes: number;
  heapElevatedRatio: number;
  heapHighRatio: number;
  heapCriticalRatio: number;
}

export interface MemoryPressureStatus {
  level: MemoryPressureLevel;
  reasons: string[];
  snapshot: MemoryPressureSnapshot;
}

export interface RetrievalMemoryGuardrails {
  fanoutConcurrencyCap?: number;
  maxVariantsCap?: number;
  disableRerank?: boolean;
}

const MEBIBYTE = 1024 * 1024;

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function envRatio(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  return clampRatio(Number(raw), defaultValue);
}

function levelRank(level: MemoryPressureLevel): number {
  switch (level) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'elevated':
      return 1;
    default:
      return 0;
  }
}

function updateLevel(current: MemoryPressureLevel, candidate: MemoryPressureLevel): MemoryPressureLevel {
  return levelRank(candidate) > levelRank(current) ? candidate : current;
}

export function readMemoryPressureSnapshot(): MemoryPressureSnapshot {
  const usage = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapLimitBytes = Math.max(0, Number(heapStats.heap_size_limit) || 0);
  const heapUtilization = heapLimitBytes > 0
    ? clampRatio(usage.heapUsed / heapLimitBytes, 0)
    : 0;

  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    heapLimitBytes,
    heapUtilization,
  };
}

export function getMemoryPressureThresholds(): MemoryPressureThresholds {
  return {
    rssElevatedBytes: envInt('CE_MEMORY_PRESSURE_RSS_ELEVATED_BYTES', 1280 * MEBIBYTE, { min: 0 }),
    rssHighBytes: envInt('CE_MEMORY_PRESSURE_RSS_HIGH_BYTES', 1536 * MEBIBYTE, { min: 0 }),
    rssCriticalBytes: envInt('CE_MEMORY_PRESSURE_RSS_CRITICAL_BYTES', 1792 * MEBIBYTE, { min: 0 }),
    heapElevatedRatio: envRatio('CE_MEMORY_PRESSURE_HEAP_ELEVATED_RATIO', 0.8),
    heapHighRatio: envRatio('CE_MEMORY_PRESSURE_HEAP_HIGH_RATIO', 0.88),
    heapCriticalRatio: envRatio('CE_MEMORY_PRESSURE_HEAP_CRITICAL_RATIO', 0.94),
  };
}

export function evaluateMemoryPressure(
  snapshot: MemoryPressureSnapshot = readMemoryPressureSnapshot(),
  thresholds: MemoryPressureThresholds = getMemoryPressureThresholds()
): MemoryPressureStatus {
  let level: MemoryPressureLevel = 'normal';
  const reasons = new Set<string>();

  if (snapshot.heapUtilization >= thresholds.heapCriticalRatio) {
    level = updateLevel(level, 'critical');
    reasons.add('heap_utilization');
  } else if (snapshot.heapUtilization >= thresholds.heapHighRatio) {
    level = updateLevel(level, 'high');
    reasons.add('heap_utilization');
  } else if (snapshot.heapUtilization >= thresholds.heapElevatedRatio) {
    level = updateLevel(level, 'elevated');
    reasons.add('heap_utilization');
  }

  if (snapshot.rssBytes >= thresholds.rssCriticalBytes) {
    level = updateLevel(level, 'critical');
    reasons.add('rss_bytes');
  } else if (snapshot.rssBytes >= thresholds.rssHighBytes) {
    level = updateLevel(level, 'high');
    reasons.add('rss_bytes');
  } else if (snapshot.rssBytes >= thresholds.rssElevatedBytes) {
    level = updateLevel(level, 'elevated');
    reasons.add('rss_bytes');
  }

  return {
    level,
    reasons: Array.from(reasons.values()),
    snapshot,
  };
}

export function getRetrievalMemoryGuardrails(status: MemoryPressureStatus): RetrievalMemoryGuardrails {
  switch (status.level) {
    case 'critical':
      return {
        fanoutConcurrencyCap: 1,
        maxVariantsCap: 1,
        disableRerank: true,
      };
    case 'high':
      return {
        fanoutConcurrencyCap: 2,
        disableRerank: true,
      };
    default:
      return {};
  }
}

export function memoryPressureLevelValue(level: MemoryPressureLevel): number {
  return levelRank(level);
}
