#!/usr/bin/env node
/**
 * Release benchmark helper:
 * - Runs candidate benchmark 3 times
 * - Computes median candidate p95
 * - Compares median candidate vs baseline using scripts/ci/bench-compare.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type BenchMode = 'scan' | 'search' | 'retrieve';
const VALID_BENCH_MODES: readonly BenchMode[] = ['scan', 'search', 'retrieve'] as const;
const DEFAULT_ARTIFACT_DIR = path.join(process.cwd(), 'artifacts', 'bench', 'release');
const DEFAULT_BASELINE_FILE = 'nightly-baseline.json';
const DEFAULT_CANDIDATE_PREFIX = 'release-candidate';

interface Args {
  mode: BenchMode;
  workspace: string;
  outDir: string;
  baseline: string;
  candidateMedian: string;
  candidateRunPrefix: string;
}

interface BenchOutput {
  total_ms?: number;
  payload?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const outDir = process.env.BENCH_ARTIFACT_DIR ? path.resolve(process.env.BENCH_ARTIFACT_DIR) : DEFAULT_ARTIFACT_DIR;
  const args: Args = {
    mode: 'scan',
    workspace: process.cwd(),
    outDir,
    baseline: path.join(outDir, DEFAULT_BASELINE_FILE),
    candidateMedian: path.join(outDir, `${DEFAULT_CANDIDATE_PREFIX}-median.json`),
    candidateRunPrefix: path.join(outDir, `${DEFAULT_CANDIDATE_PREFIX}-run`),
  };
  let baselineInput: string | undefined;
  let candidateInput: string | undefined;
  let modeInput: string | undefined = process.env.BENCH_MODE;
  let modeFromCli = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];

    if (a === '--mode' && next()) {
      modeInput = next()!;
      modeFromCli = true;
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
    if (a === '--baseline' && next()) {
      baselineInput = next()!;
      i++;
      continue;
    }
    if (a === '--candidate' && next()) {
      candidateInput = next()!;
      i++;
      continue;
    }
    if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  args.mode = parseBenchMode(modeInput, modeFromCli ? '--mode' : 'BENCH_MODE');

  args.baseline = resolvePathInput(baselineInput ?? process.env.BASELINE_PATH, args.outDir, DEFAULT_BASELINE_FILE);
  const candidateSpec = resolveCandidatePaths(candidateInput ?? process.env.CANDIDATE_PATH_INPUT, args.outDir);
  args.candidateMedian = candidateSpec.medianPath;
  args.candidateRunPrefix = candidateSpec.runPrefix;

  return args;
}

function parseBenchMode(value: string | undefined, source: string): BenchMode {
  if (!value) {
    throw new Error(
      `Missing benchmark mode from ${source}. Allowed values: ${VALID_BENCH_MODES.join(', ')}.`
    );
  }
  if (value === 'scan' || value === 'search' || value === 'retrieve') {
    return value;
  }
  throw new Error(
    `Invalid benchmark mode from ${source}: "${value}". Allowed values: ${VALID_BENCH_MODES.join(', ')}.`
  );
}

function resolvePathInput(input: string | undefined, outDir: string, defaultFileName: string): string {
  const raw = input?.trim();
  if (!raw) {
    return path.join(outDir, defaultFileName);
  }
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  const cwdResolved = path.resolve(raw);
  if (fs.existsSync(cwdResolved)) {
    return cwdResolved;
  }
  return path.resolve(outDir, raw);
}

function resolveCandidatePaths(
  input: string | undefined,
  outDir: string
): { medianPath: string; runPrefix: string } {
  const raw = input?.trim();
  if (!raw) {
    const prefix = path.join(outDir, DEFAULT_CANDIDATE_PREFIX);
    return {
      medianPath: `${prefix}-median.json`,
      runPrefix: `${prefix}-run`,
    };
  }

  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(outDir, raw);
  const looksLikeDir =
    raw.endsWith('/') ||
    raw.endsWith('\\') ||
    (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());

  if (looksLikeDir) {
    const prefix = path.join(resolved, DEFAULT_CANDIDATE_PREFIX);
    return {
      medianPath: `${prefix}-median.json`,
      runPrefix: `${prefix}-run`,
    };
  }

  if (path.extname(resolved).toLowerCase() === '.json') {
    const stem = resolved.slice(0, -'.json'.length);
    return {
      medianPath: resolved,
      runPrefix: `${stem}-run`,
    };
  }

  return {
    medianPath: `${resolved}-median.json`,
    runPrefix: `${resolved}-run`,
  };
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/release-bench.ts --mode <scan|search|retrieve>

Options:
  --mode <scan|search|retrieve>  Required benchmark mode (or set BENCH_MODE)
  --workspace, -w <path>  Workspace path (default: cwd)
  --out-dir <path>        Artifact output directory (default: artifacts/bench/release or BENCH_ARTIFACT_DIR)
  --baseline <path>       Baseline JSON path (absolute, or relative to out-dir; default: nightly-baseline.json)
  --candidate <path>      Candidate artifact file/dir/prefix (absolute, or relative to out-dir)
`);
  process.exit(code);
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

function runBenchOnce(benchArgs: string[]): BenchOutput {
  const result = runNodeTsScript(path.join('scripts', 'bench.ts'), benchArgs);
  const raw = (result.stdout || '').trim();
  if (!raw) {
    throw new Error('Benchmark command produced empty output.');
  }
  return JSON.parse(raw) as BenchOutput;
}

function getMetricValue(out: BenchOutput): number | undefined {
  const timing = out.payload?.timing as Record<string, unknown> | undefined;
  if (typeof timing?.p95_ms === 'number' && Number.isFinite(timing.p95_ms)) {
    return timing.p95_ms as number;
  }
  if (typeof out.payload?.elapsed_ms === 'number' && Number.isFinite(out.payload.elapsed_ms)) {
    return out.payload.elapsed_ms as number;
  }
  if (typeof out.total_ms === 'number' && Number.isFinite(out.total_ms)) {
    return out.total_ms;
  }
  return undefined;
}

function buildBenchArgs(mode: BenchMode, workspace: string): string[] {
  if (mode === 'scan') {
    return ['--mode', 'scan', '--workspace', workspace, '--read', '--json'];
  }
  if (mode === 'search') {
    return [
      '--mode', 'search',
      '--workspace', workspace,
      '--query', 'search queue',
      '--topk', '10',
      '--iterations', '50',
      '--cold',
      '--json',
    ];
  }
  return [
    '--mode', 'retrieve',
    '--workspace', workspace,
    '--query', 'search queue',
    '--topk', '10',
    '--iterations', '50',
    '--retrieve-mode', 'fast',
    '--cold',
    '--json',
  ];
}

function resolveBenchArgs(mode: BenchMode, workspace: string): string[] {
  const args = buildBenchArgs(mode, workspace);
  const probe = runNodeTsScript(path.join('scripts', 'bench.ts'), args, true);
  if (probe.status === 0) {
    return args;
  }
  const err = (probe.stderr || probe.stdout || '').trim();
  throw new Error(
    `Unable to run candidate benchmark with mode "${mode}". ${err || 'unknown error'}.`
  );
}

function writeJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath: string): BenchOutput {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BenchOutput;
  } catch (error) {
    throw new Error(`Failed to parse JSON file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? Number.NaN;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  fs.mkdirSync(path.dirname(args.candidateMedian), { recursive: true });
  fs.mkdirSync(path.dirname(args.candidateRunPrefix), { recursive: true });

  if (!fs.existsSync(args.baseline)) {
    // eslint-disable-next-line no-console
    console.error(`Baseline artifact is missing: ${args.baseline}`);
    // eslint-disable-next-line no-console
    console.error('Provide --baseline <path> (absolute or relative to --out-dir) that points to an existing JSON artifact.');
    process.exit(1);
  }
  const baseline = readJson(args.baseline);
  const baselineProvenance = (baseline.provenance ?? {}) as Record<string, unknown>;

  const benchMode = args.mode;
  const benchArgs = resolveBenchArgs(args.mode, args.workspace);
  const candidateRuns: BenchOutput[] = [];
  const candidateMetrics: number[] = [];

  for (let i = 0; i < 3; i++) {
    try {
      const out = runBenchOnce(benchArgs);
      const metric = getMetricValue(out);
      if (metric == null) {
        // eslint-disable-next-line no-console
        console.error(`Candidate run ${i + 1}: missing p95-compatible metric.`);
        continue;
      }
      const candidateRunPath = `${args.candidateRunPrefix}-${i + 1}.json`;
      writeJson(candidateRunPath, out);
      candidateRuns.push(out);
      candidateMetrics.push(metric);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Candidate run ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (candidateRuns.length < 3) {
    // eslint-disable-next-line no-console
    console.error(`Insufficient candidate data: expected 3 successful runs, got ${candidateRuns.length}.`);
    process.exit(1);
  }

  const medianP95 = median(candidateMetrics);
  if (!Number.isFinite(medianP95)) {
    // eslint-disable-next-line no-console
    console.error('Unable to compute median candidate p95 from collected runs.');
    process.exit(1);
  }

  const first = candidateRuns[0]!;
  const payload = { ...(first.payload ?? {}) };
  const timing = { ...((payload.timing as Record<string, unknown> | undefined) ?? {}) };
  timing.p95_ms = medianP95;
  if (typeof timing.p50_ms !== 'number') timing.p50_ms = medianP95;
  if (typeof timing.avg_ms !== 'number') timing.avg_ms = medianP95;
  payload.timing = timing;

  const medianCandidate = {
    ...first,
    payload,
    provenance: {
      commit_sha:
        (process.env.GITHUB_SHA && String(process.env.GITHUB_SHA).trim()) ||
        (typeof baselineProvenance.commit_sha === 'string' ? baselineProvenance.commit_sha : 'local-dev'),
      bench_mode: benchMode,
      dataset_id:
        (typeof baselineProvenance.dataset_id === 'string' ? baselineProvenance.dataset_id : `workspace:${path.basename(args.workspace)}`),
      node_version: process.version,
      env_fingerprint:
        (typeof baselineProvenance.env_fingerprint === 'string'
          ? baselineProvenance.env_fingerprint
          : `${process.platform}-${process.arch}`),
    },
    release: {
      bench_mode: benchMode,
      candidate_runs: candidateMetrics,
      candidate_median_p95_ms: medianP95,
    },
  };

  const medianCandidatePath = args.candidateMedian;
  writeJson(medianCandidatePath, medianCandidate);
  if (!fs.existsSync(medianCandidatePath)) {
    // eslint-disable-next-line no-console
    console.error(`Candidate median artifact was not written: ${medianCandidatePath}`);
    process.exit(1);
  }

  const compareArgs = [
    '--baseline', args.baseline,
    '--candidate', medianCandidatePath,
    '--metric', 'payload.timing.p95_ms',
    '--max-regression-pct', args.mode === 'scan' ? '200' : '5',
    '--max-regression-abs', args.mode === 'scan' ? '1000' : '15',
  ];

  const result = runNodeTsScript(path.join('scripts', 'ci', 'bench-compare.ts'), compareArgs, true);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);

  // eslint-disable-next-line no-console
  console.log(`Release benchmark median candidate artifact: ${medianCandidatePath}`);
}

main();
