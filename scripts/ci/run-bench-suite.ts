#!/usr/bin/env node
/**
 * CI benchmark suite runner (PR/nightly).
 *
 * Responsibilities:
 * - Generate deterministic baseline + candidate JSON artifacts.
 * - Prefer retrieve/search benchmarks based on retrieval provider preference.
 * - Fallback to scan benchmark when higher-signal modes are unavailable.
 * - Compare baseline vs candidate using scripts/ci/bench-compare.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

type SuiteMode = 'pr' | 'nightly';
type BenchMode = 'scan' | 'search' | 'retrieve';
type RetrievalProvider = 'openai_session' | 'augment_legacy';

interface SuiteArgs {
  mode: SuiteMode;
  workspace: string;
  outDir: string;
}

interface BenchOutput {
  total_ms?: number;
  payload?: Record<string, unknown>;
  provenance?: ProvenanceMetadata;
  [key: string]: unknown;
}

interface ProvenanceMetadata {
  commit_sha: string;
  bench_mode: BenchMode;
  retrieval_provider?: RetrievalProvider;
  dataset_id: string;
  node_version: string;
  env_fingerprint: string;
}

interface Thresholds {
  maxRegressionPct: number;
  maxRegressionAbs: number;
}

interface RunConfig {
  benchMode: BenchMode;
  metricPath: string;
  baselineArgs: string[];
  candidateArgs: string[];
  thresholds: Thresholds;
  aggregateCount: number;
}

function parseArgs(argv: string[]): SuiteArgs {
  const args: SuiteArgs = {
    mode: 'pr',
    workspace: process.cwd(),
    outDir: path.join(process.cwd(), 'artifacts', 'bench'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];

    if (a === '--mode' && next()) {
      const mode = next() as SuiteMode;
      if (mode !== 'pr' && mode !== 'nightly') {
        throw new Error(`Invalid --mode: ${mode}`);
      }
      args.mode = mode;
      i++;
      continue;
    }
    if ((a === '--workspace' || a === '-w') && next()) {
      args.workspace = path.resolve(next()!);
      i++;
      continue;
    }
    if (a === '--out-dir' && next()) {
      args.outDir = path.resolve(next()!);
      i++;
      continue;
    }
    if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  return args;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/run-bench-suite.ts --mode pr
  node --import tsx scripts/ci/run-bench-suite.ts --mode nightly

Options:
  --mode <pr|nightly>     Suite mode (default: pr)
  --workspace, -w <path>  Workspace path (default: cwd)
  --out-dir <path>        Artifact output directory (default: artifacts/bench)
`);
  process.exit(code);
}

function summarizeMs(samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const pick = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx] ?? 0;
  };
  return {
    count: samples.length,
    avg_ms: samples.length ? sum / samples.length : 0,
    p50_ms: pick(50),
    p95_ms: pick(95),
    p99_ms: pick(99),
    min_ms: sorted[0] ?? 0,
    max_ms: sorted[sorted.length - 1] ?? 0,
  };
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

function runGit(args: string[]): string | undefined {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const value = (result.stdout || '').trim();
  return value || undefined;
}

function resolveCommitSha(): string {
  const fromEnv = (
    process.env.GITHUB_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.BUILDKITE_COMMIT ||
    process.env.CIRCLE_SHA1 ||
    process.env.TRAVIS_COMMIT
  )?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return runGit(['rev-parse', 'HEAD']) ?? 'unknown';
}

function resolveDatasetId(workspace: string): string {
  const fromEnv = process.env.BENCH_DATASET_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return `workspace:${path.basename(workspace) || 'root'}`;
}

function normalizeEnvValue(value: string | undefined): string {
  return (value ?? '').replace(/\\/g, '/');
}

function resolveEnvFingerprint(): string {
  const keys = [
    'CI',
    'GITHUB_ACTIONS',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'CE_RETRIEVAL_PROVIDER',
    'CE_AI_PROVIDER',
    'AUGMENT_API_URL',
    'AUGMENT_API_TOKEN',
    'npm_config_user_agent',
  ];
  const canonical = keys
    .slice()
    .sort()
    .map(key => `${key}=${normalizeEnvValue(process.env[key])}`)
    .join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function makeProvenance(
  benchMode: BenchMode,
  workspace: string,
  retrievalProvider: RetrievalProvider
): ProvenanceMetadata {
  return {
    commit_sha: resolveCommitSha(),
    bench_mode: benchMode,
    retrieval_provider: retrievalProvider,
    dataset_id: resolveDatasetId(workspace),
    node_version: process.version,
    env_fingerprint: resolveEnvFingerprint(),
  };
}

function assertProvenanceForSuite(
  mode: SuiteMode,
  baseline: BenchOutput,
  candidate: BenchOutput
): void {
  const baselineProv = baseline.provenance;
  const candidateProv = candidate.provenance;
  if (!baselineProv || !candidateProv) {
    throw new Error('Missing provenance metadata in suite artifacts.');
  }

  if (baselineProv.dataset_id !== candidateProv.dataset_id) {
    throw new Error(
      `Dataset mismatch for suite compare: baseline=${baselineProv.dataset_id} candidate=${candidateProv.dataset_id}.`
    );
  }
  if (baselineProv.bench_mode !== candidateProv.bench_mode) {
    throw new Error(
      `Benchmark mode mismatch for suite compare: baseline=${baselineProv.bench_mode} candidate=${candidateProv.bench_mode}.`
    );
  }
  const baselineProvider = baselineProv.retrieval_provider ?? 'augment_legacy';
  const candidateProvider = candidateProv.retrieval_provider ?? 'augment_legacy';
  if (baselineProvider !== candidateProvider) {
    throw new Error(
      `Retrieval provider mismatch for suite compare: baseline=${baselineProvider} candidate=${candidateProvider}.`
    );
  }

  if (mode === 'pr' && String(process.env.CI).toLowerCase() === 'true') {
    if (candidateProv.commit_sha === 'unknown') {
      throw new Error(
        'Candidate commit_sha is unknown in CI mode. Set GITHUB_SHA/CI_COMMIT_SHA or ensure git metadata is available.'
      );
    }
    if (baselineProv.commit_sha === candidateProv.commit_sha) {
      throw new Error(
        `Invalid PR baseline: baseline commit_sha matches candidate (${candidateProv.commit_sha}). Provide a baseline from a different commit.`
      );
    }
  }
}

function runBenchOnce(benchArgs: string[]): BenchOutput {
  const result = runNodeTsScript(path.join('scripts', 'bench.ts'), benchArgs);
  const raw = (result.stdout || '').trim();
  if (!raw) {
    throw new Error('Benchmark command produced empty output.');
  }
  try {
    return JSON.parse(raw) as BenchOutput;
  } catch (error) {
    throw new Error(`Failed to parse benchmark JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readArtifact(filePath: string): BenchOutput {
  const absPath = path.resolve(filePath);
  const raw = fs.readFileSync(absPath, 'utf8');
  const parsed = JSON.parse(raw) as BenchOutput;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid benchmark artifact JSON: ${filePath}`);
  }
  return parsed;
}

function hasTimingP95(out: BenchOutput): boolean {
  const timing = out.payload?.timing as Record<string, unknown> | undefined;
  return typeof timing?.p95_ms === 'number' && Number.isFinite(timing.p95_ms as number);
}

function normalizeForCompare(out: BenchOutput): BenchOutput {
  const normalized = { ...out };
  const payload = { ...(normalized.payload ?? {}) };

  if (hasTimingP95(normalized)) {
    normalized.payload = payload;
    return normalized;
  }

  const elapsedMs = typeof payload.elapsed_ms === 'number' ? payload.elapsed_ms : undefined;
  const totalMs = typeof normalized.total_ms === 'number' ? normalized.total_ms : undefined;
  const metric = elapsedMs ?? totalMs;

  if (metric == null || !Number.isFinite(metric)) {
    throw new Error('Cannot derive latency metric for compare; missing payload.elapsed_ms and total_ms.');
  }

  const timing = {
    count: 1,
    avg_ms: metric,
    p50_ms: metric,
    p95_ms: metric,
    p99_ms: metric,
    min_ms: metric,
    max_ms: metric,
  };

  payload.timing = timing;
  normalized.payload = payload;
  return normalized;
}

function aggregateRuns(
  label: 'baseline' | 'candidate',
  benchMode: BenchMode,
  runs: BenchOutput[],
  provenance: ProvenanceMetadata
): BenchOutput {
  if (runs.length === 0) {
    throw new Error(`No successful ${label} runs captured.`);
  }

  const first = normalizeForCompare(runs[0]!);
  const p95Samples: number[] = [];
  for (const out of runs) {
    const normalized = normalizeForCompare(out);
    const timing = normalized.payload?.timing as Record<string, unknown>;
    const p95 = timing?.p95_ms;
    if (typeof p95 === 'number' && Number.isFinite(p95)) {
      p95Samples.push(p95);
    }
  }

  if (p95Samples.length !== runs.length) {
    throw new Error(`Failed to collect p95 for all ${label} runs.`);
  }

  const timing = summarizeMs(p95Samples);
  return {
    ...first,
    provenance,
    suite: {
      role: label,
      bench_mode: benchMode,
      aggregated_from_runs: runs.length,
      p95_samples_ms: p95Samples,
    },
    payload: {
      ...(first.payload ?? {}),
      timing,
    },
  };
}

function makeRunConfig(mode: SuiteMode, benchMode: BenchMode, workspace: string): RunConfig {
  const isNightly = mode === 'nightly';
  const query = 'search queue';

  if (benchMode === 'scan') {
    return {
      benchMode,
      metricPath: 'payload.timing.p95_ms',
      baselineArgs: ['--mode', 'scan', '--workspace', workspace, '--read', '--json'],
      candidateArgs: ['--mode', 'scan', '--workspace', workspace, '--read', '--json'],
      // Scan fallback is a low-signal substitute when semantic modes are unavailable.
      // Keep thresholds intentionally loose to avoid false regression failures from
      // filesystem/background jitter in non-token/local environments.
      thresholds: isNightly ? { maxRegressionPct: 150, maxRegressionAbs: 800 } : { maxRegressionPct: 200, maxRegressionAbs: 1000 },
      aggregateCount: isNightly ? 9 : 5,
    };
  }

  if (benchMode === 'search') {
    const iterations = isNightly ? '80' : '30';
    return {
      benchMode,
      metricPath: 'payload.timing.p95_ms',
      baselineArgs: [
        '--mode', 'search',
        '--workspace', workspace,
        '--query', query,
        '--topk', '10',
        '--iterations', iterations,
        '--cold',
        '--json',
      ],
      candidateArgs: [
        '--mode', 'search',
        '--workspace', workspace,
        '--query', query,
        '--topk', '10',
        '--iterations', iterations,
        '--cold',
        '--json',
      ],
      thresholds: isNightly ? { maxRegressionPct: 10, maxRegressionAbs: 25 } : { maxRegressionPct: 14, maxRegressionAbs: 35 },
      aggregateCount: 1,
    };
  }

  const iterations = isNightly ? '80' : '30';
  return {
    benchMode,
    metricPath: 'payload.timing.p95_ms',
    baselineArgs: [
      '--mode', 'retrieve',
      '--workspace', workspace,
      '--query', query,
      '--topk', '10',
      '--iterations', iterations,
      '--retrieve-mode', 'fast',
      '--cold',
      '--json',
    ],
    candidateArgs: [
      '--mode', 'retrieve',
      '--workspace', workspace,
      '--query', query,
      '--topk', '10',
      '--iterations', iterations,
      '--retrieve-mode', 'fast',
      '--cold',
      '--json',
    ],
    thresholds: isNightly ? { maxRegressionPct: 8, maxRegressionAbs: 20 } : { maxRegressionPct: 12, maxRegressionAbs: 30 },
    aggregateCount: 1,
  };
}

function resolveRetrievalProvider(): {
  provider: RetrievalProvider;
  source: 'CE_RETRIEVAL_PROVIDER' | 'default';
  raw: string | null;
} {
  const raw = process.env.CE_RETRIEVAL_PROVIDER?.trim();
  if (!raw) {
    return { provider: 'openai_session', source: 'default', raw: null };
  }
  if (raw === 'openai_session' || raw === 'augment_legacy') {
    return { provider: raw, source: 'CE_RETRIEVAL_PROVIDER', raw };
  }

  // eslint-disable-next-line no-console
  console.error(
    `[run-bench-suite] Unsupported CE_RETRIEVAL_PROVIDER="${raw}". Falling back to openai_session.`
  );
  return { provider: 'openai_session', source: 'default', raw };
}

function resolveRunConfig(
  mode: SuiteMode,
  workspace: string,
  retrievalProvider: RetrievalProvider
): RunConfig {
  const modeOrder: BenchMode[] =
    retrievalProvider === 'augment_legacy'
      ? ['retrieve', 'search', 'scan']
      : ['retrieve', 'search', 'scan'];
  const errors: string[] = [];

  for (const benchMode of modeOrder) {
    const config = makeRunConfig(mode, benchMode, workspace);
    const probe = runNodeTsScript(path.join('scripts', 'bench.ts'), config.candidateArgs, true);
    if (probe.status === 0) {
      return config;
    }
    const err = (probe.stderr || probe.stdout || '').trim();
    errors.push(`${benchMode}: ${err || 'unknown error'}`);
  }

  throw new Error(`Unable to run benchmark in any supported mode. ${errors.join(' | ')}`);
}

function withWorkspaceArgs(args: string[], workspace: string): string[] {
  const copy = [...args];
  const idx = copy.findIndex(a => a === '--workspace');
  if (idx >= 0 && idx + 1 < copy.length) {
    copy[idx + 1] = workspace;
    return copy;
  }
  copy.push('--workspace', workspace);
  return copy;
}

function runCompare(
  baselinePath: string,
  candidatePath: string,
  metricPath: string,
  thresholds: Thresholds
): void {
  const args = [
    '--baseline', baselinePath,
    '--candidate', candidatePath,
    '--metric', metricPath,
    '--max-regression-pct', String(thresholds.maxRegressionPct),
    '--max-regression-abs', String(thresholds.maxRegressionAbs),
  ];

  const result = runNodeTsScript(path.join('scripts', 'ci', 'bench-compare.ts'), args, true);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  const retrievalProvider = resolveRetrievalProvider();
  const runConfig = resolveRunConfig(args.mode, args.workspace, retrievalProvider.provider);
  const suitePrefix = args.mode;
  const baselinePath = path.join(args.outDir, `${suitePrefix}-baseline.json`);
  const candidatePath = path.join(args.outDir, `${suitePrefix}-candidate.json`);
  const isCi = String(process.env.CI).toLowerCase() === 'true';
  const configuredBaselinePath = process.env.BENCH_BASELINE_PATH?.trim()
    ? path.resolve(process.env.BENCH_BASELINE_PATH)
    : baselinePath;

  const candidateRuns: BenchOutput[] = [];
  for (let i = 0; i < runConfig.aggregateCount; i++) {
    candidateRuns.push(runBenchOnce(withWorkspaceArgs(runConfig.candidateArgs, args.workspace)));
  }

  let baseline: BenchOutput;
  if (args.mode === 'pr' && isCi) {
    if (!fs.existsSync(configuredBaselinePath)) {
      throw new Error(
        `PR suite in CI requires an existing baseline artifact. Set BENCH_BASELINE_PATH or provide ${configuredBaselinePath}.`
      );
    }
    baseline = readArtifact(configuredBaselinePath);
  } else {
    const baselineRuns: BenchOutput[] = [];
    for (let i = 0; i < runConfig.aggregateCount; i++) {
      baselineRuns.push(runBenchOnce(withWorkspaceArgs(runConfig.baselineArgs, args.workspace)));
    }
    baseline = aggregateRuns(
      'baseline',
      runConfig.benchMode,
      baselineRuns,
      makeProvenance(runConfig.benchMode, args.workspace, retrievalProvider.provider)
    );
  }

  const candidate = aggregateRuns(
    'candidate',
    runConfig.benchMode,
    candidateRuns,
    makeProvenance(runConfig.benchMode, args.workspace, retrievalProvider.provider)
  );

  assertProvenanceForSuite(args.mode, baseline, candidate);

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));

  // eslint-disable-next-line no-console
  console.log(`Suite mode: ${args.mode}`);
  // eslint-disable-next-line no-console
  console.log(`Benchmark mode: ${runConfig.benchMode}`);
  // eslint-disable-next-line no-console
  console.log(`Retrieval provider: ${retrievalProvider.provider} (${retrievalProvider.source})`);
  // eslint-disable-next-line no-console
  console.log(`Baseline artifact: ${baselinePath}`);
  // eslint-disable-next-line no-console
  console.log(`Candidate artifact: ${candidatePath}`);
  // eslint-disable-next-line no-console
  console.log(`Compare metric: ${runConfig.metricPath}`);

  runCompare(baselinePath, candidatePath, runConfig.metricPath, runConfig.thresholds);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
