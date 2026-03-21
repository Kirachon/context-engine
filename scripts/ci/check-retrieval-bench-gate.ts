#!/usr/bin/env node
/**
 * Combined retrieval benchmark gate.
 *
 * Reuses the existing benchmark compare flow for provenance + latency and the
 * retrieval quality gate for the quality report. Intended for CI / release
 * promotion checks around the retrieval backend migration.
 *
 * Exit codes:
 * - 0: gate passed
 * - 1: gate failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

interface CliArgs {
  baselinePath: string;
  candidatePath: string;
  qualityReportPath: string;
  outPath: string;
  qualityGateOutPath: string;
  metricPath: string;
  maxRegressionPct: number;
  maxRegressionAbs: number;
}

interface BenchCompareArtifact {
  payload?: {
    timing?: {
      p95_ms?: number;
      avg_ms?: number;
      p50_ms?: number;
    };
  };
  provenance?: {
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
  };
}

interface QualityGateArtifact {
  summary?: {
    total?: number;
    pass?: number;
    fail?: number;
    skip?: number;
    pass_rate?: number;
  };
  gate_rules?: {
    min_pass_rate?: number;
    required_ids?: string[];
  };
  gate?: {
    status?: string;
    reasons?: string[];
  };
  reproducibility_lock?: {
    commit_sha?: string;
    dataset_id?: string;
    dataset_hash?: string;
    fixture_pack_hash?: string;
    report_path?: string;
  };
}

interface ParsedCompareOutput {
  metric?: string;
  baseline?: number;
  candidate?: number;
  regressionAbs?: number;
  regressionPct?: string;
  thresholds?: string;
}

interface GateArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    baseline: string;
    candidate: string;
    quality_report: string;
    quality_gate_out: string;
    out: string;
  };
  benchmark: {
    status: 'pass' | 'fail';
    compare: ParsedCompareOutput;
    compare_stdout?: string;
    compare_stderr?: string;
  };
  quality: {
    status: 'pass' | 'fail';
    report_path: string;
    gate_artifact_path: string;
    summary?: QualityGateArtifact['summary'];
    gate_rules?: QualityGateArtifact['gate_rules'];
    gate_reasons?: string[];
  };
  gate: {
    status: 'pass' | 'fail';
    reasons: string[];
  };
  reproducibility_lock: {
    benchmark_commit_sha?: string;
    benchmark_dataset_id?: string;
    benchmark_dataset_hash?: string;
    benchmark_feature_flags_snapshot?: string;
    quality_commit_sha?: string;
    quality_dataset_id?: string;
    quality_dataset_hash?: string;
    quality_fixture_pack_hash?: string;
  };
}

const DEFAULT_BASELINE_PATH = path.join('artifacts', 'bench', 'pr-baseline.json');
const DEFAULT_CANDIDATE_PATH = path.join('artifacts', 'bench', 'pr-candidate.json');
const DEFAULT_QUALITY_REPORT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-report.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-bench-gate.json');
const DEFAULT_QUALITY_GATE_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-gate.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-retrieval-bench-gate.ts [options]

Options:
  --baseline <path>              Baseline benchmark JSON (default: ${DEFAULT_BASELINE_PATH})
  --candidate <path>             Candidate benchmark JSON (default: ${DEFAULT_CANDIDATE_PATH})
  --quality-report <path>        Retrieval quality report JSON (default: ${DEFAULT_QUALITY_REPORT_PATH})
  --quality-gate-out <path>      Output path for the nested quality gate artifact (default: ${DEFAULT_QUALITY_GATE_OUT_PATH})
  --out <path>                   Combined gate artifact output path (default: ${DEFAULT_OUT_PATH})
  --metric <dot.path>            Benchmark metric path (default: payload.timing.p95_ms)
  --max-regression-pct <n>       Allowed latency regression percent (default: 10)
  --max-regression-abs <n>       Allowed latency regression absolute units (default: 25)
`);
  process.exit(code);
}

function parseNumber(value: string | undefined, name: string): number {
  if (!value) throw new Error(`Missing value for ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${name}: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    baselinePath: DEFAULT_BASELINE_PATH,
    candidatePath: DEFAULT_CANDIDATE_PATH,
    qualityReportPath: DEFAULT_QUALITY_REPORT_PATH,
    qualityGateOutPath: DEFAULT_QUALITY_GATE_OUT_PATH,
    outPath: DEFAULT_OUT_PATH,
    metricPath: 'payload.timing.p95_ms',
    maxRegressionPct: 10,
    maxRegressionAbs: 25,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--baseline') {
      if (!next) throw new Error('Missing value for --baseline');
      args.baselinePath = next;
      i += 1;
      continue;
    }
    if (arg === '--candidate') {
      if (!next) throw new Error('Missing value for --candidate');
      args.candidatePath = next;
      i += 1;
      continue;
    }
    if (arg === '--quality-report') {
      if (!next) throw new Error('Missing value for --quality-report');
      args.qualityReportPath = next;
      i += 1;
      continue;
    }
    if (arg === '--quality-gate-out') {
      if (!next) throw new Error('Missing value for --quality-gate-out');
      args.qualityGateOutPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--metric') {
      if (!next) throw new Error('Missing value for --metric');
      args.metricPath = next;
      i += 1;
      continue;
    }
    if (arg === '--max-regression-pct') {
      args.maxRegressionPct = parseNumber(next, '--max-regression-pct');
      i += 1;
      continue;
    }
    if (arg === '--max-regression-abs') {
      args.maxRegressionAbs = parseNumber(next, '--max-regression-abs');
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

function asObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function runNodeTsScript(scriptPath: string, args: string[], allowFailure = false) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0 && !allowFailure) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(`Command failed (${scriptPath}): ${err}`);
  }
  return result;
}

function parseCompareOutput(stdout: string): ParsedCompareOutput {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed: ParsedCompareOutput = {};
  for (const line of lines) {
    const metricMatch = line.match(/^metric=(.+)$/);
    if (metricMatch?.[1]) {
      parsed.metric = metricMatch[1].trim();
      continue;
    }
    const baselineMatch = line.match(/^baseline=([+-]?\d+(?:\.\d+)?)$/);
    if (baselineMatch?.[1]) {
      parsed.baseline = Number(baselineMatch[1]);
      continue;
    }
    const candidateMatch = line.match(/^candidate=([+-]?\d+(?:\.\d+)?)$/);
    if (candidateMatch?.[1]) {
      parsed.candidate = Number(candidateMatch[1]);
      continue;
    }
    const regressionAbsMatch = line.match(/^regression_abs=(.+)$/);
    if (regressionAbsMatch?.[1]) {
      parsed.regressionAbs = Number(regressionAbsMatch[1].trim());
      continue;
    }
    const regressionPctMatch = line.match(/^regression_pct=(.+)$/);
    if (regressionPctMatch?.[1]) {
      parsed.regressionPct = regressionPctMatch[1].trim();
      continue;
    }
    const thresholdsMatch = line.match(/^thresholds:\s*(.+)$/);
    if (thresholdsMatch?.[1]) {
      parsed.thresholds = thresholdsMatch[1].trim();
    }
  }
  return parsed;
}

function runBenchCompare(args: CliArgs): {
  status: number;
  stdout: string;
  stderr: string;
  parsed: ParsedCompareOutput;
} {
  const result = runNodeTsScript(path.join('scripts', 'ci', 'bench-compare.ts'), [
    '--baseline',
    path.resolve(args.baselinePath),
    '--candidate',
    path.resolve(args.candidatePath),
    '--metric',
    args.metricPath,
    '--max-regression-pct',
    String(args.maxRegressionPct),
    '--max-regression-abs',
    String(args.maxRegressionAbs),
  ], true);

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    parsed: parseCompareOutput(result.stdout ?? ''),
  };
}

function runQualityGate(args: CliArgs): {
  status: number;
  stdout: string;
  stderr: string;
  artifact?: QualityGateArtifact;
} {
  const result = runNodeTsScript(path.join('scripts', 'ci', 'check-retrieval-quality-gate.ts'), [
    '--report',
    path.resolve(args.qualityReportPath),
    '--out',
    path.resolve(args.qualityGateOutPath),
  ], true);

  const outPath = path.resolve(args.qualityGateOutPath);
  let artifact: QualityGateArtifact | undefined;
  if (fs.existsSync(outPath)) {
    try {
      const raw = readJson(outPath);
      artifact = asObject(raw, 'Quality gate artifact must be a JSON object') as QualityGateArtifact;
    } catch {
      artifact = undefined;
    }
  }

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    artifact,
  };
}

function isKnownString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().toLowerCase() !== 'unknown';
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const benchmarkResult = runBenchCompare(args);
    const qualityResult = runQualityGate(args);

    const reasons: string[] = [];
    if (benchmarkResult.status !== 0) {
      reasons.push(
        `benchmark compare failed: ${lastNonEmptyLine(benchmarkResult.stderr || benchmarkResult.stdout) || 'unknown error'}`
      );
    }
    if (qualityResult.status !== 0) {
      const qualityReasons = qualityResult.artifact?.gate?.reasons ?? [];
      if (qualityReasons.length > 0) {
        reasons.push(...qualityReasons.map((reason) => `quality gate: ${reason}`));
      } else {
        reasons.push(
          `quality gate failed: ${lastNonEmptyLine(qualityResult.stderr || qualityResult.stdout) || 'unknown error'}`
        );
      }
    }

    const benchmarkArtifact = readJson(args.baselinePath) as BenchCompareArtifact;
    const candidateArtifact = readJson(args.candidatePath) as BenchCompareArtifact;
    const benchmarkProv = asObject(benchmarkArtifact.provenance, 'Baseline benchmark artifact missing provenance.');
    const candidateProv = asObject(candidateArtifact.provenance, 'Candidate benchmark artifact missing provenance.');
    const qualityLock = qualityResult.artifact?.reproducibility_lock ?? {};

    const benchmarkCommitSha = typeof candidateProv.commit_sha === 'string' ? candidateProv.commit_sha.trim() : '';
    const benchmarkDatasetId = typeof candidateProv.dataset_id === 'string' ? candidateProv.dataset_id.trim() : '';
    const benchmarkDatasetHash = typeof candidateProv.dataset_hash === 'string' ? candidateProv.dataset_hash.trim() : '';
    const benchmarkFeatureFlagsSnapshot =
      typeof candidateProv.feature_flags_snapshot === 'string' ? candidateProv.feature_flags_snapshot.trim() : '';
    const qualityCommitSha = typeof qualityLock.commit_sha === 'string' ? qualityLock.commit_sha.trim() : '';
    const qualityDatasetId = typeof qualityLock.dataset_id === 'string' ? qualityLock.dataset_id.trim() : '';
    const qualityDatasetHash = typeof qualityLock.dataset_hash === 'string' ? qualityLock.dataset_hash.trim() : '';
    const qualityFixturePackHash =
      typeof qualityLock.fixture_pack_hash === 'string' ? qualityLock.fixture_pack_hash.trim() : '';

    if (!isKnownString(benchmarkProv.commit_sha)) {
      reasons.push('baseline benchmark provenance missing commit_sha');
    }
    if (!isKnownString(candidateProv.commit_sha)) {
      reasons.push('candidate benchmark provenance missing commit_sha');
    }
    if (isKnownString(candidateProv.commit_sha) && isKnownString(qualityCommitSha) && candidateProv.commit_sha.trim() !== qualityCommitSha) {
      reasons.push(
        `quality reproducibility mismatch: commit_sha candidate=${candidateProv.commit_sha.trim()} quality=${qualityCommitSha}`
      );
    }
    if (!isKnownString(qualityCommitSha)) {
      reasons.push('quality reproducibility missing commit_sha');
    }
    if (!isKnownString(qualityDatasetId)) {
      reasons.push('quality reproducibility missing dataset_id');
    }
    if (!isKnownString(qualityDatasetHash)) {
      reasons.push('quality reproducibility missing dataset_hash');
    }
    if (!isKnownString(qualityFixturePackHash)) {
      reasons.push('quality reproducibility missing fixture_pack_hash');
    }

    const benchmarkStatus = benchmarkResult.status === 0 ? 'pass' : 'fail';
    const qualityStatus = qualityResult.status === 0 ? 'pass' : 'fail';
    const gateStatus: 'pass' | 'fail' = reasons.length === 0 ? 'pass' : 'fail';

    const artifact: GateArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        baseline: path.resolve(args.baselinePath),
        candidate: path.resolve(args.candidatePath),
        quality_report: path.resolve(args.qualityReportPath),
        quality_gate_out: path.resolve(args.qualityGateOutPath),
        out: path.resolve(args.outPath),
      },
      benchmark: {
        status: benchmarkStatus,
        compare: benchmarkResult.parsed,
        compare_stdout: benchmarkResult.stdout.trim() || undefined,
        compare_stderr: benchmarkResult.stderr.trim() || undefined,
      },
      quality: {
        status: qualityStatus,
        report_path: path.resolve(args.qualityReportPath),
        gate_artifact_path: path.resolve(args.qualityGateOutPath),
        summary: qualityResult.artifact?.summary,
        gate_rules: qualityResult.artifact?.gate_rules,
        gate_reasons: qualityResult.artifact?.gate?.reasons,
      },
      gate: {
        status: gateStatus,
        reasons,
      },
      reproducibility_lock: {
        benchmark_commit_sha: isKnownString(benchmarkProv.commit_sha) ? benchmarkProv.commit_sha.trim() : undefined,
        benchmark_dataset_id: isKnownString(candidateProv.dataset_id) ? candidateProv.dataset_id.trim() : undefined,
        benchmark_dataset_hash: isKnownString(candidateProv.dataset_hash) ? candidateProv.dataset_hash.trim() : undefined,
        benchmark_feature_flags_snapshot: benchmarkFeatureFlagsSnapshot || undefined,
        quality_commit_sha: qualityCommitSha || undefined,
        quality_dataset_id: qualityDatasetId || undefined,
        quality_dataset_hash: qualityDatasetHash || undefined,
        quality_fixture_pack_hash: qualityFixturePackHash || undefined,
      },
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`retrieval_bench_gate status=${gateStatus} out=${outPath}`);
    return gateStatus === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
