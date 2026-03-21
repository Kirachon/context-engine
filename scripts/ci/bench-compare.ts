#!/usr/bin/env node
/**
 * Compare two benchmark JSON outputs from scripts/bench.ts.
 *
 * Exit codes:
 * - 0: pass (within thresholds)
 * - 1: fail (threshold breach)
 * - 2: usage / parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

interface CompareArgs {
  baselinePath: string;
  candidatePath: string;
  metricPath?: string;
  maxRegressionPct?: number;
  maxRegressionAbs?: number;
  higherIsBetter: boolean;
  requireSameMode: boolean;
}

interface BenchPayload {
  mode?: string;
  [key: string]: unknown;
}

interface ProvenanceMetadata {
  timestamp_utc?: string;
  commit_sha?: string;
  branch_or_tag?: string;
  workspace_fingerprint?: string;
  index_fingerprint?: string;
  bench_mode?: string;
  dataset_id?: string;
  dataset_hash?: string;
  retrieval_provider?: string;
  feature_flags_snapshot?: string;
  node_version?: string;
  os_version?: string;
  env_fingerprint?: string;
  [key: string]: unknown;
}

interface BenchOutput {
  total_ms?: number;
  payload?: BenchPayload;
  provenance?: ProvenanceMetadata;
  [key: string]: unknown;
}

function parseNumber(value: string | undefined, name: string): number {
  if (!value) throw new Error(`Missing value for ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${name}: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): CompareArgs {
  const args: CompareArgs = {
    baselinePath: '',
    candidatePath: '',
    higherIsBetter: false,
    requireSameMode: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];

    if ((a === '--baseline' || a === '-b') && next()) {
      args.baselinePath = next()!;
      i++;
      continue;
    }
    if ((a === '--candidate' || a === '-c') && next()) {
      args.candidatePath = next()!;
      i++;
      continue;
    }
    if (a === '--metric' && next()) {
      args.metricPath = next()!;
      i++;
      continue;
    }
    if (a === '--max-regression-pct' && next()) {
      args.maxRegressionPct = parseNumber(next(), '--max-regression-pct');
      i++;
      continue;
    }
    if (a === '--max-regression-abs' && next()) {
      args.maxRegressionAbs = parseNumber(next(), '--max-regression-abs');
      i++;
      continue;
    }
    if (a === '--higher-is-better') {
      args.higherIsBetter = true;
      continue;
    }
    if (a === '--no-require-same-mode') {
      args.requireSameMode = false;
      continue;
    }
    if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!args.baselinePath || !args.candidatePath) {
    throw new Error('Both --baseline and --candidate are required.');
  }
  if (args.maxRegressionPct == null && args.maxRegressionAbs == null) {
    args.maxRegressionPct = 10;
  }

  return args;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  npm run bench:compare -- --baseline bench-baseline.json --candidate bench-candidate.json [options]

Options:
  --baseline, -b <path>       Baseline benchmark JSON
  --candidate, -c <path>      Candidate benchmark JSON
  --metric <dot.path>         Metric path (default auto-detect)
  --max-regression-pct <n>    Allowed regression percent (default 10)
  --max-regression-abs <n>    Allowed regression absolute units (ms for latency metrics)
  --higher-is-better          Use for throughput metrics (e.g., files_per_sec)
  --no-require-same-mode      Allow comparison even if payload.mode differs
`);
  process.exit(code);
}

function readJson(filePath: string): BenchOutput {
  const absPath = path.resolve(filePath);
  const raw = fs.readFileSync(absPath, 'utf8');
  const parsed = JSON.parse(raw) as BenchOutput;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid JSON object in ${filePath}`);
  }
  return parsed;
}

function getByPath(obj: unknown, pathValue: string): unknown {
  const parts = pathValue.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function detectMetricPath(bench: BenchOutput): string {
  const candidates = [
    'payload.timing.p95_ms',
    'payload.timing.avg_ms',
    'payload.elapsed_ms',
    'total_ms',
  ];
  for (const candidate of candidates) {
    const value = getByPath(bench, candidate);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return candidate;
    }
  }
  throw new Error('Could not auto-detect a numeric metric. Pass --metric <dot.path>.');
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Metric "${label}" is missing or non-numeric.`);
  }
  return value;
}

function computeRegressionPct(regressionAbs: number, baselineMetric: number, candidateMetric: number): number {
  const absBaseline = Math.abs(baselineMetric);
  const scale = Math.max(1, absBaseline, Math.abs(candidateMetric));
  const effectivelyZeroBaseline = absBaseline <= Number.EPSILON * scale;
  if (effectivelyZeroBaseline) {
    if (regressionAbs === 0) {
      return 0;
    }
    return regressionAbs > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  const ratio = regressionAbs / baselineMetric;
  if (!Number.isFinite(ratio)) {
    if (ratio === 0) {
      return 0;
    }
    return ratio > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  if (Math.abs(ratio) > Number.MAX_VALUE / 100) {
    return ratio > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  const pct = ratio * 100;
  if (!Number.isFinite(pct)) {
    return pct > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return pct;
}

function readRequiredProvenanceField(
  provenance: ProvenanceMetadata | undefined,
  field: keyof ProvenanceMetadata,
  label: string
): string {
  const value = provenance?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required provenance field "${String(field)}" in ${label} artifact.`);
  }
  return value.trim();
}

function assertProvenanceIntegrity(baseline: BenchOutput, candidate: BenchOutput): void {
  readRequiredProvenanceField(baseline.provenance, 'timestamp_utc', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'timestamp_utc', 'candidate');
  const baselineMode = readRequiredProvenanceField(baseline.provenance, 'bench_mode', 'baseline');
  const candidateMode = readRequiredProvenanceField(candidate.provenance, 'bench_mode', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'branch_or_tag', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'branch_or_tag', 'candidate');
  const baselineWorkspace = readRequiredProvenanceField(baseline.provenance, 'workspace_fingerprint', 'baseline');
  const candidateWorkspace = readRequiredProvenanceField(candidate.provenance, 'workspace_fingerprint', 'candidate');
  const baselineIndex = readRequiredProvenanceField(baseline.provenance, 'index_fingerprint', 'baseline');
  const candidateIndex = readRequiredProvenanceField(candidate.provenance, 'index_fingerprint', 'candidate');
  const baselineDataset = readRequiredProvenanceField(baseline.provenance, 'dataset_id', 'baseline');
  const candidateDataset = readRequiredProvenanceField(candidate.provenance, 'dataset_id', 'candidate');
  const baselineDatasetHash = readRequiredProvenanceField(baseline.provenance, 'dataset_hash', 'baseline');
  const candidateDatasetHash = readRequiredProvenanceField(candidate.provenance, 'dataset_hash', 'candidate');
  const baselineRetrievalProvider = readRequiredProvenanceField(baseline.provenance, 'retrieval_provider', 'baseline');
  const candidateRetrievalProvider = readRequiredProvenanceField(candidate.provenance, 'retrieval_provider', 'candidate');
  const baselineFeatureFlags = readRequiredProvenanceField(baseline.provenance, 'feature_flags_snapshot', 'baseline');
  const candidateFeatureFlags = readRequiredProvenanceField(candidate.provenance, 'feature_flags_snapshot', 'candidate');

  const baselineCommit = readRequiredProvenanceField(baseline.provenance, 'commit_sha', 'baseline');
  const candidateCommit = readRequiredProvenanceField(candidate.provenance, 'commit_sha', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'node_version', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'node_version', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'os_version', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'os_version', 'candidate');
  readRequiredProvenanceField(baseline.provenance, 'env_fingerprint', 'baseline');
  readRequiredProvenanceField(candidate.provenance, 'env_fingerprint', 'candidate');

  const isCi = String(process.env.CI ?? '').toLowerCase() === 'true';
  if (isCi && baselineCommit === candidateCommit) {
    throw new Error('Invalid baseline: baseline and candidate commit_sha must differ in CI mode.');
  }

  if (baselineMode !== candidateMode) {
    throw new Error(`Provenance mode mismatch: baseline=${baselineMode} candidate=${candidateMode}`);
  }
  if (baselineDataset !== candidateDataset) {
    throw new Error(`Dataset mismatch: baseline=${baselineDataset} candidate=${candidateDataset}`);
  }
  if (baselineDatasetHash !== candidateDatasetHash) {
    throw new Error(`Dataset hash mismatch: baseline=${baselineDatasetHash} candidate=${candidateDatasetHash}`);
  }
  if (baselineWorkspace !== candidateWorkspace) {
    throw new Error(`Workspace fingerprint mismatch: baseline=${baselineWorkspace} candidate=${candidateWorkspace}`);
  }
  if (baselineIndex !== candidateIndex) {
    throw new Error(`Index fingerprint mismatch: baseline=${baselineIndex} candidate=${candidateIndex}`);
  }
  if (baselineRetrievalProvider !== candidateRetrievalProvider) {
    throw new Error(
      `Retrieval provider mismatch: baseline=${baselineRetrievalProvider} candidate=${candidateRetrievalProvider}`
    );
  }
  if (baselineFeatureFlags !== candidateFeatureFlags) {
    throw new Error('Feature-flag snapshot mismatch: baseline and candidate artifacts must share the same snapshot.');
  }
}

function main(): void {
  let args: CompareArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const baseline = readJson(args.baselinePath);
    const candidate = readJson(args.candidatePath);
    assertProvenanceIntegrity(baseline, candidate);

    if (args.requireSameMode) {
      const baselineMode = baseline.payload?.mode ?? baseline.provenance?.bench_mode;
      const candidateMode = candidate.payload?.mode ?? candidate.provenance?.bench_mode;
      if (typeof baselineMode === 'string' && typeof candidateMode === 'string' && baselineMode !== candidateMode) {
        throw new Error(`Mode mismatch: baseline=${baselineMode} candidate=${candidateMode}`);
      }
    }

    const metricPath = args.metricPath ?? detectMetricPath(baseline);
    const baselineMetric = asFiniteNumber(getByPath(baseline, metricPath), `baseline:${metricPath}`);
    const candidateMetric = asFiniteNumber(getByPath(candidate, metricPath), `candidate:${metricPath}`);

    const regressionAbs = args.higherIsBetter ? baselineMetric - candidateMetric : candidateMetric - baselineMetric;
    const regressionPct = computeRegressionPct(regressionAbs, baselineMetric, candidateMetric);

    const breachedPct = args.maxRegressionPct != null && regressionPct > args.maxRegressionPct;
    const breachedAbs = args.maxRegressionAbs != null && regressionAbs > args.maxRegressionAbs;
    const failed = breachedPct || breachedAbs;

    // eslint-disable-next-line no-console
    console.log(`metric=${metricPath}`);
    // eslint-disable-next-line no-console
    console.log(`baseline=${baselineMetric}`);
    // eslint-disable-next-line no-console
    console.log(`candidate=${candidateMetric}`);
    // eslint-disable-next-line no-console
    console.log(`regression_abs=${regressionAbs}`);
    // eslint-disable-next-line no-console
    console.log(`regression_pct=${Number.isFinite(regressionPct) ? regressionPct.toFixed(2) : 'Infinity'}`);
    // eslint-disable-next-line no-console
    console.log(`thresholds: max_regression_pct=${args.maxRegressionPct ?? 'n/a'} max_regression_abs=${args.maxRegressionAbs ?? 'n/a'}`);

    if (failed) {
      // eslint-disable-next-line no-console
      console.error('Benchmark threshold breached.');
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('Benchmark comparison passed.');
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
