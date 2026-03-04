#!/usr/bin/env node
/**
 * Retrieval parity artifact generator + threshold gate.
 *
 * Consumes benchmark, replay, and shadow outputs (when available), computes
 * overlap/reliability/perf deltas, writes a machine-readable artifact, and
 * optionally fails CI when configured thresholds are breached.
 *
 * Exit codes:
 * - 0: artifact generated; gate passed (or gate disabled)
 * - 1: threshold breach
 * - 2: usage / parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type SourceName = 'bench' | 'replay' | 'shadow';
type Comparator = 'lte' | 'lt' | 'gte' | 'gt';
type MissingPolicy = 'skip' | 'fail';
type EvalStatus = 'pass' | 'fail' | 'skip';

interface CliArgs {
  benchBaselinePath?: string;
  benchCandidatePath?: string;
  replayPath?: string;
  shadowPath?: string;
  thresholdsPath: string;
  outPath: string;
  gateEnabled: boolean;
}

interface ThresholdRule {
  comparator: Comparator;
  threshold: number;
  missing_policy?: MissingPolicy;
  description?: string;
}

interface ThresholdConfig {
  schema_version?: number;
  metrics?: Record<string, ThresholdRule>;
}

interface MetricValue {
  value?: number;
  note?: string;
}

interface SourceMetrics {
  overlap_ratio: MetricValue;
  reliability: {
    error_rate_delta_pp: MetricValue;
    timeout_rate_delta_pp: MetricValue;
    unique_files_drop_pct: MetricValue;
  };
  perf: {
    p95_regression_pct: MetricValue;
    p95_regression_abs_ms: MetricValue;
  };
}

interface MetricEvaluation {
  id: string;
  status: EvalStatus;
  comparator: Comparator;
  threshold: number;
  value?: number;
  message: string;
}

interface ParityArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    bench_baseline?: string;
    bench_candidate?: string;
    replay?: string;
    shadow?: string;
    thresholds: string;
  };
  metrics: Record<SourceName, SourceMetrics>;
  evaluations: MetricEvaluation[];
  gate: {
    enabled: boolean;
    status: 'pass' | 'fail';
    failed_metric_ids: string[];
  };
}

const DEFAULT_THRESHOLDS_PATH = path.join('config', 'ci', 'retrieval-parity-thresholds.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-parity-report.json');

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    thresholdsPath: DEFAULT_THRESHOLDS_PATH,
    outPath: DEFAULT_OUT_PATH,
    gateEnabled: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[i + 1];

    if (arg === '--bench-baseline' && next()) {
      out.benchBaselinePath = next()!;
      i++;
      continue;
    }
    if (arg === '--bench-candidate' && next()) {
      out.benchCandidatePath = next()!;
      i++;
      continue;
    }
    if (arg === '--replay' && next()) {
      out.replayPath = next()!;
      i++;
      continue;
    }
    if (arg === '--shadow' && next()) {
      out.shadowPath = next()!;
      i++;
      continue;
    }
    if (arg === '--thresholds' && next()) {
      out.thresholdsPath = next()!;
      i++;
      continue;
    }
    if (arg === '--out' && next()) {
      out.outPath = next()!;
      i++;
      continue;
    }
    if (arg === '--no-gate') {
      out.gateEnabled = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!out.benchBaselinePath && !out.benchCandidatePath && !out.replayPath && !out.shadowPath) {
    throw new Error('At least one input is required: --bench-baseline/--bench-candidate/--replay/--shadow.');
  }

  return out;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/retrieval-parity-gate.ts [options]

Inputs:
  --bench-baseline <path>   Baseline benchmark artifact (optional)
  --bench-candidate <path>  Candidate benchmark artifact (optional)
  --replay <path>           Replay artifact (optional)
  --shadow <path>           Shadow artifact (optional)

Options:
  --thresholds <path>       Threshold config JSON (default: ${DEFAULT_THRESHOLDS_PATH})
  --out <path>              Output parity artifact path (default: ${DEFAULT_OUT_PATH})
  --no-gate                 Generate artifact only; do not enforce thresholds
`);
  process.exit(code);
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid JSON object: ${resolved}`);
  }
  return parsed as Record<string, unknown>;
}

function readThresholdConfig(filePath: string): ThresholdConfig {
  const parsed = readJsonFile(filePath) as ThresholdConfig;
  if (!parsed.metrics || typeof parsed.metrics !== 'object') {
    throw new Error(`Threshold config missing "metrics" object: ${path.resolve(filePath)}`);
  }
  return parsed;
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

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstFiniteByPaths(obj: Record<string, unknown>, paths: string[]): number | undefined {
  for (const p of paths) {
    const value = asFiniteNumber(getByPath(obj, p));
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function calcPctDelta(candidate: number, baseline: number): number {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) {
    return Number.NaN;
  }
  const absBaseline = Math.abs(baseline);
  const scale = Math.max(1, absBaseline, Math.abs(candidate));
  const effectivelyZeroBaseline = absBaseline <= Number.EPSILON * scale;
  if (effectivelyZeroBaseline) {
    if (candidate === baseline) return 0;
    return candidate > baseline ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  const pct = ((candidate - baseline) / baseline) * 100;
  if (Number.isFinite(pct)) {
    return pct;
  }
  return pct > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

function metric(value?: number, note?: string): MetricValue {
  return { value, note };
}

function emptySourceMetrics(): SourceMetrics {
  return {
    overlap_ratio: metric(undefined, 'not available'),
    reliability: {
      error_rate_delta_pp: metric(undefined, 'not available'),
      timeout_rate_delta_pp: metric(undefined, 'not available'),
      unique_files_drop_pct: metric(undefined, 'not available'),
    },
    perf: {
      p95_regression_pct: metric(undefined, 'not available'),
      p95_regression_abs_ms: metric(undefined, 'not available'),
    },
  };
}

function extractP95Ms(obj: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(obj, ['payload.timing.p95_ms', 'payload.elapsed_ms', 'total_ms']);
}

function extractErrorRate(obj: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(obj, ['metrics.error_rate', 'stats.error_rate', 'summary.error_rate', 'error_rate']);
}

function extractTimeoutRate(obj: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(obj, ['metrics.timeout_rate', 'stats.timeout_rate', 'summary.timeout_rate', 'timeout_rate']);
}

function extractUniqueFilesAtK(obj: Record<string, unknown>): number | undefined {
  return firstFiniteByPaths(obj, [
    'unique_files_at_k',
    'unique_files_k',
    'unique_files',
    'metrics.unique_files_at_k',
    'summary.unique_files_at_k',
  ]);
}

function extractOverlapRatio(obj: Record<string, unknown>): number | undefined {
  const direct = firstFiniteByPaths(obj, [
    'overlap_ratio',
    'overlap',
    'metrics.overlap_ratio',
    'metrics.overlap',
    'summary.overlap_ratio',
    'summary.overlap',
    'quality.overlap_ratio',
    'quality.overlap',
  ]);
  if (direct != null) {
    return direct;
  }

  const intersection = firstFiniteByPaths(obj, ['intersection_count', 'metrics.intersection_count']);
  const union = firstFiniteByPaths(obj, ['union_count', 'metrics.union_count']);
  if (intersection != null && union != null && union > 0) {
    return intersection / union;
  }
  return undefined;
}

function fromPair(
  artifact: Record<string, unknown>,
  baselineExtractor: (obj: Record<string, unknown>) => number | undefined,
  candidateExtractor: (obj: Record<string, unknown>) => number | undefined
): { baseline?: number; candidate?: number } {
  const baselineNode = getByPath(artifact, 'baseline');
  const candidateNode = getByPath(artifact, 'candidate');
  const baseline = baselineNode && typeof baselineNode === 'object'
    ? baselineExtractor(baselineNode as Record<string, unknown>)
    : undefined;
  const candidate = candidateNode && typeof candidateNode === 'object'
    ? candidateExtractor(candidateNode as Record<string, unknown>)
    : undefined;
  return { baseline, candidate };
}

function buildBenchMetrics(
  baselineArtifact?: Record<string, unknown>,
  candidateArtifact?: Record<string, unknown>
): SourceMetrics {
  const out = emptySourceMetrics();
  if (!baselineArtifact || !candidateArtifact) {
    out.perf.p95_regression_pct.note = 'requires both bench baseline and candidate';
    out.perf.p95_regression_abs_ms.note = 'requires both bench baseline and candidate';
    out.reliability.error_rate_delta_pp.note = 'requires both bench baseline and candidate';
    out.reliability.timeout_rate_delta_pp.note = 'requires both bench baseline and candidate';
    out.reliability.unique_files_drop_pct.note = 'requires both bench baseline and candidate';
    return out;
  }

  const baselineP95 = extractP95Ms(baselineArtifact);
  const candidateP95 = extractP95Ms(candidateArtifact);
  if (baselineP95 != null && candidateP95 != null) {
    out.perf.p95_regression_abs_ms = metric(candidateP95 - baselineP95);
    out.perf.p95_regression_pct = metric(calcPctDelta(candidateP95, baselineP95));
  } else {
    out.perf.p95_regression_pct.note = 'missing p95 metric in baseline/candidate bench artifacts';
    out.perf.p95_regression_abs_ms.note = 'missing p95 metric in baseline/candidate bench artifacts';
  }

  const baselineErr = extractErrorRate(baselineArtifact);
  const candidateErr = extractErrorRate(candidateArtifact);
  if (baselineErr != null && candidateErr != null) {
    out.reliability.error_rate_delta_pp = metric((candidateErr - baselineErr) * 100);
  } else {
    out.reliability.error_rate_delta_pp.note = 'error_rate unavailable in bench artifact schema';
  }

  const baselineTimeout = extractTimeoutRate(baselineArtifact);
  const candidateTimeout = extractTimeoutRate(candidateArtifact);
  if (baselineTimeout != null && candidateTimeout != null) {
    out.reliability.timeout_rate_delta_pp = metric((candidateTimeout - baselineTimeout) * 100);
  } else {
    out.reliability.timeout_rate_delta_pp.note = 'timeout_rate unavailable in bench artifact schema';
  }

  const baselineUnique = extractUniqueFilesAtK(baselineArtifact);
  const candidateUnique = extractUniqueFilesAtK(candidateArtifact);
  if (baselineUnique != null && candidateUnique != null && baselineUnique > 0) {
    out.reliability.unique_files_drop_pct = metric(((baselineUnique - candidateUnique) / baselineUnique) * 100);
  } else {
    out.reliability.unique_files_drop_pct.note = 'unique_files@k unavailable or invalid baseline in bench artifact schema';
  }

  out.overlap_ratio.note = 'bench artifacts do not typically include overlap_ratio';
  return out;
}

function buildReplayOrShadowMetrics(artifact?: Record<string, unknown>): SourceMetrics {
  const out = emptySourceMetrics();
  if (!artifact) {
    out.overlap_ratio.note = 'artifact not provided';
    out.reliability.error_rate_delta_pp.note = 'artifact not provided';
    out.reliability.timeout_rate_delta_pp.note = 'artifact not provided';
    out.reliability.unique_files_drop_pct.note = 'artifact not provided';
    out.perf.p95_regression_pct.note = 'artifact not provided';
    out.perf.p95_regression_abs_ms.note = 'artifact not provided';
    return out;
  }

  const overlap = extractOverlapRatio(artifact);
  if (overlap != null) {
    out.overlap_ratio = metric(overlap);
  } else {
    out.overlap_ratio.note = 'overlap_ratio not found';
  }

  const errPair = fromPair(artifact, extractErrorRate, extractErrorRate);
  if (errPair.baseline != null && errPair.candidate != null) {
    out.reliability.error_rate_delta_pp = metric((errPair.candidate - errPair.baseline) * 100);
  } else {
    out.reliability.error_rate_delta_pp.note = 'baseline/candidate error_rate not found';
  }

  const timeoutPair = fromPair(artifact, extractTimeoutRate, extractTimeoutRate);
  if (timeoutPair.baseline != null && timeoutPair.candidate != null) {
    out.reliability.timeout_rate_delta_pp = metric((timeoutPair.candidate - timeoutPair.baseline) * 100);
  } else {
    out.reliability.timeout_rate_delta_pp.note = 'baseline/candidate timeout_rate not found';
  }

  const uniquePair = fromPair(artifact, extractUniqueFilesAtK, extractUniqueFilesAtK);
  if (uniquePair.baseline != null && uniquePair.candidate != null && uniquePair.baseline > 0) {
    out.reliability.unique_files_drop_pct = metric(((uniquePair.baseline - uniquePair.candidate) / uniquePair.baseline) * 100);
  } else {
    out.reliability.unique_files_drop_pct.note = 'baseline/candidate unique_files@k not found';
  }

  const p95Pair = fromPair(artifact, extractP95Ms, extractP95Ms);
  if (p95Pair.baseline != null && p95Pair.candidate != null) {
    out.perf.p95_regression_abs_ms = metric(p95Pair.candidate - p95Pair.baseline);
    out.perf.p95_regression_pct = metric(calcPctDelta(p95Pair.candidate, p95Pair.baseline));
  } else {
    out.perf.p95_regression_pct.note = 'baseline/candidate p95 metric not found';
    out.perf.p95_regression_abs_ms.note = 'baseline/candidate p95 metric not found';
  }

  return out;
}

function flattenMetrics(metrics: Record<SourceName, SourceMetrics>): Record<string, MetricValue> {
  return {
    'bench.overlap_ratio': metrics.bench.overlap_ratio,
    'bench.reliability.error_rate_delta_pp': metrics.bench.reliability.error_rate_delta_pp,
    'bench.reliability.timeout_rate_delta_pp': metrics.bench.reliability.timeout_rate_delta_pp,
    'bench.reliability.unique_files_drop_pct': metrics.bench.reliability.unique_files_drop_pct,
    'bench.perf.p95_regression_pct': metrics.bench.perf.p95_regression_pct,
    'bench.perf.p95_regression_abs_ms': metrics.bench.perf.p95_regression_abs_ms,
    'replay.overlap_ratio': metrics.replay.overlap_ratio,
    'replay.reliability.error_rate_delta_pp': metrics.replay.reliability.error_rate_delta_pp,
    'replay.reliability.timeout_rate_delta_pp': metrics.replay.reliability.timeout_rate_delta_pp,
    'replay.reliability.unique_files_drop_pct': metrics.replay.reliability.unique_files_drop_pct,
    'replay.perf.p95_regression_pct': metrics.replay.perf.p95_regression_pct,
    'replay.perf.p95_regression_abs_ms': metrics.replay.perf.p95_regression_abs_ms,
    'shadow.overlap_ratio': metrics.shadow.overlap_ratio,
    'shadow.reliability.error_rate_delta_pp': metrics.shadow.reliability.error_rate_delta_pp,
    'shadow.reliability.timeout_rate_delta_pp': metrics.shadow.reliability.timeout_rate_delta_pp,
    'shadow.reliability.unique_files_drop_pct': metrics.shadow.reliability.unique_files_drop_pct,
    'shadow.perf.p95_regression_pct': metrics.shadow.perf.p95_regression_pct,
    'shadow.perf.p95_regression_abs_ms': metrics.shadow.perf.p95_regression_abs_ms,
  };
}

function compareValue(value: number, comparator: Comparator, threshold: number): boolean {
  if (comparator === 'lte') return value <= threshold;
  if (comparator === 'lt') return value < threshold;
  if (comparator === 'gte') return value >= threshold;
  return value > threshold;
}

function evaluateRules(
  config: ThresholdConfig,
  metrics: Record<string, MetricValue>,
  gateEnabled: boolean
): MetricEvaluation[] {
  const rules = config.metrics ?? {};
  const evaluations: MetricEvaluation[] = [];

  for (const [id, rule] of Object.entries(rules)) {
    const metric = metrics[id];
    const missingPolicy: MissingPolicy = rule.missing_policy ?? 'skip';

    if (!metric || metric.value == null || !Number.isFinite(metric.value)) {
      const status: EvalStatus = missingPolicy === 'fail' && gateEnabled ? 'fail' : 'skip';
      evaluations.push({
        id,
        status,
        comparator: rule.comparator,
        threshold: rule.threshold,
        value: metric?.value,
        message:
          status === 'fail'
            ? `FAIL ${id}: metric unavailable (policy=fail).`
            : `SKIP ${id}: metric unavailable (policy=${missingPolicy}).`,
      });
      continue;
    }

    const passed = !gateEnabled || compareValue(metric.value, rule.comparator, rule.threshold);
    const status: EvalStatus = passed ? 'pass' : 'fail';
    evaluations.push({
      id,
      status,
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: metric.value,
      message: `${status.toUpperCase()} ${id}: value=${metric.value} ${rule.comparator} ${rule.threshold}`,
    });
  }

  return evaluations;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const thresholds = readThresholdConfig(args.thresholdsPath);

    const benchBaseline = args.benchBaselinePath ? readJsonFile(args.benchBaselinePath) : undefined;
    const benchCandidate = args.benchCandidatePath ? readJsonFile(args.benchCandidatePath) : undefined;
    const replay = args.replayPath ? readJsonFile(args.replayPath) : undefined;
    const shadow = args.shadowPath ? readJsonFile(args.shadowPath) : undefined;

    const metrics: Record<SourceName, SourceMetrics> = {
      bench: buildBenchMetrics(benchBaseline, benchCandidate),
      replay: buildReplayOrShadowMetrics(replay),
      shadow: buildReplayOrShadowMetrics(shadow),
    };

    const flat = flattenMetrics(metrics);
    const evaluations = evaluateRules(thresholds, flat, args.gateEnabled);
    const failed = evaluations.filter(e => e.status === 'fail').map(e => e.id);

    const artifact: ParityArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        bench_baseline: args.benchBaselinePath ? path.resolve(args.benchBaselinePath) : undefined,
        bench_candidate: args.benchCandidatePath ? path.resolve(args.benchCandidatePath) : undefined,
        replay: args.replayPath ? path.resolve(args.replayPath) : undefined,
        shadow: args.shadowPath ? path.resolve(args.shadowPath) : undefined,
        thresholds: path.resolve(args.thresholdsPath),
      },
      metrics,
      evaluations,
      gate: {
        enabled: args.gateEnabled,
        status: failed.length > 0 ? 'fail' : 'pass',
        failed_metric_ids: failed,
      },
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log('Retrieval parity artifact generated.');
    // eslint-disable-next-line no-console
    console.log(`out=${outPath}`);
    // eslint-disable-next-line no-console
    console.log(`gate_enabled=${args.gateEnabled}`);
    // eslint-disable-next-line no-console
    console.log(`gate_status=${artifact.gate.status}`);
    for (const evaluation of evaluations) {
      // eslint-disable-next-line no-console
      console.log(evaluation.message);
    }

    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`Retrieval parity gate failed (${failed.length} metrics).`);
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();

