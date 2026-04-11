import * as v8 from 'node:v8';
import { featureEnabled } from '../config/features.js';

type LabelValues = Record<string, string | number | boolean | undefined>;

type MetricType = 'counter' | 'gauge' | 'histogram';

interface MetricMeta {
  name: string;
  type: MetricType;
  help?: string;
}

interface SeriesKey {
  name: string;
  labels: Record<string, string>;
}

function normalizeLabels(labels?: LabelValues): Record<string, string> {
  if (!labels) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function stableLabelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
  return `{${sorted.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

const DEFAULT_DURATION_BUCKETS_S = [
  0.001,
  0.0025,
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
];

class MetricsRegistry {
  private metas = new Map<string, MetricMeta>();
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private readonly maxSeries = 5000;
  private droppedUpdates = 0;
  private histograms = new Map<
    string,
    {
      buckets: number[];
      bucketCounts: number[];
      sum: number;
      count: number;
    }
  >();

  private canCreateSeries(key: string, map: Map<string, unknown>): boolean {
    if (map.has(key)) return true;
    const seriesCount = this.counters.size + this.gauges.size + this.histograms.size;
    if (seriesCount >= this.maxSeries) {
      this.droppedUpdates += 1;
      return false;
    }
    return true;
  }

  private ensureMeta(name: string, type: MetricType, help?: string): void {
    const existing = this.metas.get(name);
    if (existing) return;
    this.metas.set(name, { name, type, help });
  }

  incCounter(name: string, labels?: LabelValues, value: number = 1, help?: string): void {
    this.ensureMeta(name, 'counter', help);
    const labelObj = normalizeLabels(labels);
    const key = `${name}|${stableLabelKey(labelObj)}`;
    if (!this.canCreateSeries(key, this.counters)) return;
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  setGauge(name: string, labels: LabelValues | undefined, value: number, help?: string): void {
    this.ensureMeta(name, 'gauge', help);
    const labelObj = normalizeLabels(labels);
    const key = `${name}|${stableLabelKey(labelObj)}`;
    if (!this.canCreateSeries(key, this.gauges)) return;
    this.gauges.set(key, value);
  }

  observeHistogram(
    name: string,
    labels: LabelValues | undefined,
    valueSeconds: number,
    opts?: { help?: string; buckets?: number[] }
  ): void {
    this.ensureMeta(name, 'histogram', opts?.help);
    const labelObj = normalizeLabels(labels);
    const seriesKey = `${name}|${stableLabelKey(labelObj)}`;
    const rawBuckets = opts?.buckets?.length ? opts.buckets : DEFAULT_DURATION_BUCKETS_S;
    const buckets = rawBuckets
      .filter((b) => Number.isFinite(b) && b > 0)
      .slice()
      .sort((a, b) => a - b);

    let series = this.histograms.get(seriesKey);
    if (!series) {
      if (!this.canCreateSeries(seriesKey, this.histograms)) return;
      series = {
        buckets: buckets.length ? buckets : DEFAULT_DURATION_BUCKETS_S.slice(),
        // Cumulative counts per bucket boundary.
        bucketCounts: new Array(buckets.length ? buckets.length : DEFAULT_DURATION_BUCKETS_S.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(seriesKey, series);
    }

    // If buckets changed between calls, keep the first-set buckets for this series.
    const b = series.buckets;
    const bucketCounts = series.bucketCounts;

    series.sum += valueSeconds;
    series.count += 1;

    for (let i = 0; i < b.length; i++) {
      if (valueSeconds <= b[i]) {
        bucketCounts[i] += 1;
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const memoryUsage = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const heapLimitBytes = Math.max(0, Number(heapStats.heap_size_limit) || 0);
    const heapUtilization = heapLimitBytes > 0 ? memoryUsage.heapUsed / heapLimitBytes : 0;

    // Process/runtime metrics (cheap, computed at render time)
    lines.push('# HELP process_uptime_seconds Uptime of the Node.js process in seconds.');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${process.uptime()}`);

    lines.push('# HELP process_resident_memory_bytes Resident set size memory in bytes.');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${memoryUsage.rss}`);

    lines.push('# HELP process_heap_used_bytes Used V8 heap memory in bytes.');
    lines.push('# TYPE process_heap_used_bytes gauge');
    lines.push(`process_heap_used_bytes ${memoryUsage.heapUsed}`);

    lines.push('# HELP process_heap_total_bytes Total V8 heap memory in bytes.');
    lines.push('# TYPE process_heap_total_bytes gauge');
    lines.push(`process_heap_total_bytes ${memoryUsage.heapTotal}`);

    lines.push('# HELP process_heap_limit_bytes Current V8 heap size limit in bytes.');
    lines.push('# TYPE process_heap_limit_bytes gauge');
    lines.push(`process_heap_limit_bytes ${heapLimitBytes}`);

    lines.push('# HELP process_external_memory_bytes External memory tracked by Node.js in bytes.');
    lines.push('# TYPE process_external_memory_bytes gauge');
    lines.push(`process_external_memory_bytes ${memoryUsage.external}`);

    lines.push('# HELP process_array_buffers_bytes ArrayBuffer memory tracked by Node.js in bytes.');
    lines.push('# TYPE process_array_buffers_bytes gauge');
    lines.push(`process_array_buffers_bytes ${memoryUsage.arrayBuffers}`);

    lines.push('# HELP process_heap_utilization_ratio Ratio of used V8 heap bytes to the current heap limit.');
    lines.push('# TYPE process_heap_utilization_ratio gauge');
    lines.push(`process_heap_utilization_ratio ${heapUtilization}`);

    lines.push('# HELP context_engine_metrics_dropped_total Number of metric updates dropped due to registry limits.');
    lines.push('# TYPE context_engine_metrics_dropped_total counter');
    lines.push(`context_engine_metrics_dropped_total ${this.droppedUpdates}`);

    // User metrics
    const metas = Array.from(this.metas.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const meta of metas) {
      if (meta.help) {
        lines.push(`# HELP ${meta.name} ${meta.help}`);
      }
      lines.push(`# TYPE ${meta.name} ${meta.type}`);

      if (meta.type === 'counter') {
        for (const [key, value] of this.counters.entries()) {
          if (!key.startsWith(meta.name + '|')) continue;
          const labels = JSON.parse(key.substring(meta.name.length + 1)) as Array<[string, string]>;
          const labelObj: Record<string, string> = Object.fromEntries(labels);
          lines.push(`${meta.name}${formatLabels(labelObj)} ${value}`);
        }
      } else if (meta.type === 'gauge') {
        for (const [key, value] of this.gauges.entries()) {
          if (!key.startsWith(meta.name + '|')) continue;
          const labels = JSON.parse(key.substring(meta.name.length + 1)) as Array<[string, string]>;
          const labelObj: Record<string, string> = Object.fromEntries(labels);
          lines.push(`${meta.name}${formatLabels(labelObj)} ${value}`);
        }
      } else if (meta.type === 'histogram') {
        for (const [seriesKey, series] of this.histograms.entries()) {
          if (!seriesKey.startsWith(meta.name + '|')) continue;
          const labels = JSON.parse(seriesKey.substring(meta.name.length + 1)) as Array<[string, string]>;
          const baseLabels: Record<string, string> = Object.fromEntries(labels);

          // Prometheus histogram requires cumulative counts per bucket.
          for (let i = 0; i < series.buckets.length; i++) {
            lines.push(
              `${meta.name}_bucket${formatLabels({ ...baseLabels, le: String(series.buckets[i]) })} ${series.bucketCounts[i]}`
            );
          }
          lines.push(
            `${meta.name}_bucket${formatLabels({ ...baseLabels, le: '+Inf' })} ${series.count}`
          );
          lines.push(`${meta.name}_sum${formatLabels(baseLabels)} ${series.sum}`);
          lines.push(`${meta.name}_count${formatLabels(baseLabels)} ${series.count}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }
}

const REGISTRY = new MetricsRegistry();

export function metricsEnabled(): boolean {
  return featureEnabled('metrics');
}

export function incCounter(
  name: string,
  labels?: LabelValues,
  value: number = 1,
  help?: string
): void {
  if (!metricsEnabled()) return;
  REGISTRY.incCounter(name, labels, value, help);
}

export function setGauge(name: string, labels: LabelValues | undefined, value: number, help?: string): void {
  if (!metricsEnabled()) return;
  REGISTRY.setGauge(name, labels, value, help);
}

export function observeDurationMs(
  name: string,
  labels: LabelValues | undefined,
  durationMs: number,
  opts?: { help?: string; bucketsSeconds?: number[] }
): void {
  if (!metricsEnabled()) return;
  const seconds = durationMs / 1000;
  REGISTRY.observeHistogram(name, labels, seconds, { help: opts?.help, buckets: opts?.bucketsSeconds });
}

export async function timeAsync<T>(
  name: string,
  labels: LabelValues | undefined,
  fn: () => Promise<T>,
  opts?: { help?: string; bucketsSeconds?: number[]; onErrorLabel?: { key: string; value: string } }
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    observeDurationMs(name, labels, Date.now() - start, { help: opts?.help, bucketsSeconds: opts?.bucketsSeconds });
    return result;
  } catch (e) {
    const errorLabels = opts?.onErrorLabel
      ? { ...(labels || {}), [opts.onErrorLabel.key]: opts.onErrorLabel.value }
      : labels;
    observeDurationMs(name, errorLabels, Date.now() - start, { help: opts?.help, bucketsSeconds: opts?.bucketsSeconds });
    throw e;
  }
}

export function renderPrometheusMetrics(): string {
  if (!metricsEnabled()) return '';
  return REGISTRY.renderPrometheus();
}
