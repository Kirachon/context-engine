#!/usr/bin/env node
/**
 * WS19 deterministic SLO gate for existing CI artifacts.
 *
 * Exit codes:
 * - 0: pass
 * - 1: threshold breach / required metric missing
 * - 2: usage / parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type Family = 'review' | 'index_search' | 'planning_lifecycle';
type MissingPolicy = 'fail' | 'skip';
type ThroughputMetric = 'files_per_sec' | 'mb_per_sec';

interface GateArgs {
  family: Family;
  artifactPath: string;
}

interface GateMetricRule {
  name: string;
  comparator: 'lte' | 'lt' | 'gte';
  threshold: number;
  missingPolicy: MissingPolicy;
  extract: (artifact: Record<string, unknown>) => number | undefined;
  formatThreshold: string;
}

interface MetricEvaluation {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
}

const FAMILY_LATENCY_LIMITS_MS: Record<Family, number> = {
  review: 500,
  index_search: 2000,
  planning_lifecycle: 1000,
};

const FAMILY_ERROR_RATE_LIMITS: Record<Family, number> = {
  review: 0.01,
  index_search: 0.005,
  planning_lifecycle: 0.01,
};

const FAMILY_TIMEOUT_RATE_LIMITS: Record<Family, number> = {
  review: 0.01,
  index_search: 0.005,
  planning_lifecycle: 0.01,
};

function parseArgs(argv: string[]): GateArgs {
  const out: Partial<GateArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    if (arg === '--family' && next()) {
      const family = next() as Family;
      if (family !== 'review' && family !== 'index_search' && family !== 'planning_lifecycle') {
        throw new Error(`Invalid --family: ${family}`);
      }
      out.family = family;
      i++;
      continue;
    }
    if ((arg === '--artifact' || arg === '--artifact-path') && next()) {
      out.artifactPath = next()!;
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!out.family) {
    throw new Error('Missing required --family <review|index_search|planning_lifecycle>.');
  }
  if (!out.artifactPath) {
    throw new Error('Missing required --artifact <path>.');
  }

  return out as GateArgs;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/ws19-slo-gate.ts --family <family> --artifact <path>

Families:
  review
  index_search
  planning_lifecycle
`);
  process.exit(code);
}

function readArtifact(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid JSON artifact: ${resolved}`);
  }
  return parsed as Record<string, unknown>;
}

function getByPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstFiniteByPaths(artifact: Record<string, unknown>, paths: string[]): number | undefined {
  for (const p of paths) {
    const value = finiteNumber(getByPath(artifact, p));
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function extractLatencyP95Ms(family: Family, artifact: Record<string, unknown>): number | undefined {
  if (family === 'review') {
    return firstFiniteByPaths(artifact, ['stats.duration_ms']);
  }
  return firstFiniteByPaths(artifact, ['payload.timing.p95_ms', 'payload.elapsed_ms', 'total_ms']);
}

function extractErrorRate(artifact: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(artifact, [
    'metrics.error_rate',
    'stats.error_rate',
    'summary.error_rate',
    'error_rate',
  ]);
}

function extractTimeoutRate(artifact: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(artifact, [
    'metrics.timeout_rate',
    'stats.timeout_rate',
    'summary.timeout_rate',
    'timeout_rate',
  ]);
}

function resolveThroughputMetric(artifact: Record<string, unknown>): { metric: ThroughputMetric; value: number } | undefined {
  const filesPerSec = finiteNumber(getByPath(artifact, 'payload.files_per_sec'));
  if (filesPerSec != null) {
    return { metric: 'files_per_sec', value: filesPerSec };
  }
  const mbPerSec = finiteNumber(getByPath(artifact, 'payload.mb_per_sec'));
  if (mbPerSec != null) {
    return { metric: 'mb_per_sec', value: mbPerSec };
  }
  return undefined;
}

function extractThroughput(artifact: Record<string, unknown>): number | undefined {
  const resolved = resolveThroughputMetric(artifact);
  if (!resolved) {
    return undefined;
  }
  // Normalize throughput into files_per_sec-compatible score:
  // - if files_per_sec is present, use it directly
  // - if only mb_per_sec is present, use its numeric value as-is with a matching threshold
  return resolved.value;
}

function throughputThresholdLabel(artifact: Record<string, unknown>): { threshold: number; label: string } {
  const resolved = resolveThroughputMetric(artifact);
  if (resolved?.metric === 'mb_per_sec') {
    return { threshold: 10, label: '10 MB/s' };
  }
  return { threshold: 100, label: '100 files/s' };
}

function getFamilyRules(family: Family, artifact: Record<string, unknown>): GateMetricRule[] {
  const latencyLimit = FAMILY_LATENCY_LIMITS_MS[family];
  const errorRateLimit = FAMILY_ERROR_RATE_LIMITS[family];
  const timeoutRateLimit = FAMILY_TIMEOUT_RATE_LIMITS[family];
  const throughput = throughputThresholdLabel(artifact);

  return [
    {
      name: 'p95_ms',
      comparator: 'lte',
      threshold: latencyLimit,
      missingPolicy: 'fail',
      extract: (data) => extractLatencyP95Ms(family, data),
      formatThreshold: `<= ${latencyLimit}ms`,
    },
    {
      name: 'error_rate',
      comparator: 'lt',
      threshold: errorRateLimit,
      missingPolicy: 'skip',
      extract: extractErrorRate,
      formatThreshold: `< ${(errorRateLimit * 100).toFixed(2)}%`,
    },
    {
      name: 'timeout_rate',
      comparator: 'lt',
      threshold: timeoutRateLimit,
      missingPolicy: 'skip',
      extract: extractTimeoutRate,
      formatThreshold: `< ${(timeoutRateLimit * 100).toFixed(2)}%`,
    },
    {
      name: 'throughput',
      comparator: 'gte',
      threshold: throughput.threshold,
      missingPolicy: 'skip',
      extract: extractThroughput,
      formatThreshold: `>= ${throughput.label}`,
    },
  ];
}

function compare(value: number, comparator: GateMetricRule['comparator'], threshold: number): boolean {
  if (comparator === 'lt') return value < threshold;
  if (comparator === 'lte') return value <= threshold;
  return value >= threshold;
}

function evaluateRule(rule: GateMetricRule, artifact: Record<string, unknown>): MetricEvaluation {
  const value = rule.extract(artifact);
  if (value == null) {
    if (rule.missingPolicy === 'skip') {
      return {
        name: rule.name,
        status: 'skip',
        message: `SKIP ${rule.name}: unavailable in artifact schema (policy=skip).`,
      };
    }
    return {
      name: rule.name,
      status: 'fail',
      message: `FAIL ${rule.name}: unavailable in artifact schema (policy=fail).`,
    };
  }

  const passed = compare(value, rule.comparator, rule.threshold);
  if (passed) {
    return {
      name: rule.name,
      status: 'pass',
      message: `PASS ${rule.name}: value=${value} threshold=${rule.formatThreshold}.`,
    };
  }

  return {
    name: rule.name,
    status: 'fail',
    message: `FAIL ${rule.name}: value=${value} threshold=${rule.formatThreshold}.`,
  };
}

function staleCacheGuard(family: Family, artifact: Record<string, unknown>): MetricEvaluation {
  if (family !== 'index_search') {
    return {
      name: 'stale_cache_guard',
      status: 'skip',
      message: 'SKIP stale_cache_guard: not applicable for this family.',
    };
  }

  const mode = String(
    getByPath(artifact, 'payload.mode') ??
      getByPath(artifact, 'provenance.bench_mode') ??
      ''
  ).trim();

  if (mode === 'search' || mode === 'retrieve') {
    const cold = getByPath(artifact, 'payload.cold');
    const bypassCache = getByPath(artifact, 'payload.bypass_cache');
    const coldOk = cold === true || bypassCache === true;
    if (!coldOk) {
      return {
        name: 'stale_cache_guard',
        status: 'fail',
        message: `FAIL stale_cache_guard: mode=${mode} requires payload.cold=true or payload.bypass_cache=true.`,
      };
    }
    return {
      name: 'stale_cache_guard',
      status: 'pass',
      message: `PASS stale_cache_guard: mode=${mode} uses cold/bypass cache settings.`,
    };
  }

  if (mode === 'scan' || mode === 'index') {
    return {
      name: 'stale_cache_guard',
      status: 'pass',
      message: `PASS stale_cache_guard: mode=${mode} does not rely on retrieval cache paths.`,
    };
  }

  return {
    name: 'stale_cache_guard',
    status: 'skip',
    message: 'SKIP stale_cache_guard: benchmark mode missing/unknown.',
  };
}

function main(): void {
  let args: GateArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const artifact = readArtifact(args.artifactPath);
    const rules = getFamilyRules(args.family, artifact);
    const evaluations = rules.map(rule => evaluateRule(rule, artifact));
    evaluations.push(staleCacheGuard(args.family, artifact));

    // eslint-disable-next-line no-console
    console.log(`WS19 SLO Gate`);
    // eslint-disable-next-line no-console
    console.log(`family=${args.family}`);
    // eslint-disable-next-line no-console
    console.log(`artifact=${path.resolve(args.artifactPath)}`);
    for (const evaluation of evaluations) {
      // eslint-disable-next-line no-console
      console.log(evaluation.message);
    }

    const failed = evaluations.filter(v => v.status === 'fail');
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`WS19 gate failed with ${failed.length} failing checks.`);
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('WS19 gate passed.');
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
