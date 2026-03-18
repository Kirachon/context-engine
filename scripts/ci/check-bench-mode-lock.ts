#!/usr/bin/env node
/**
 * Benchmark mode-lock checker.
 *
 * Ensures KPI acceptance artifacts were produced using high-signal modes
 * (`retrieve` / `search`) and not low-signal `scan`.
 *
 * Exit codes:
 * - 0: gate passed
 * - 1: gate failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type BenchMode = 'scan' | 'search' | 'retrieve';

interface CliArgs {
  baselinePath: string;
  candidatePath: string;
  outPath: string;
  allowModes: BenchMode[];
}

interface Artifact {
  provenance?: {
    bench_mode?: string;
  };
  payload?: {
    mode?: string;
  };
}

const DEFAULT_BASELINE = path.join('artifacts', 'bench', 'pr-baseline.json');
const DEFAULT_CANDIDATE = path.join('artifacts', 'bench', 'pr-candidate.json');
const DEFAULT_OUT = path.join('artifacts', 'bench', 'bench-mode-lock-gate.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-bench-mode-lock.ts [options]

Options:
  --baseline <path>      Baseline artifact path (default: ${DEFAULT_BASELINE})
  --candidate <path>     Candidate artifact path (default: ${DEFAULT_CANDIDATE})
  --out <path>           Output gate artifact path (default: ${DEFAULT_OUT})
  --allow-modes <list>   Comma-separated allowed modes (default: retrieve,search)
`);
  process.exit(code);
}

function parseMode(raw: string): BenchMode {
  if (raw === 'scan' || raw === 'search' || raw === 'retrieve') return raw;
  throw new Error(`Invalid bench mode: ${raw}`);
}

function asKnownMode(raw: string): BenchMode | null {
  try {
    return parseMode(raw);
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    baselinePath: DEFAULT_BASELINE,
    candidatePath: DEFAULT_CANDIDATE,
    outPath: DEFAULT_OUT,
    allowModes: ['retrieve', 'search'],
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
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--allow-modes') {
      if (!next) throw new Error('Missing value for --allow-modes');
      const parsed = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map(parseMode);
      if (parsed.length === 0) {
        throw new Error('At least one allowed mode is required.');
      }
      args.allowModes = [...new Set(parsed)];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readArtifact(filePath: string): Artifact {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Artifact must be a JSON object: ${resolved}`);
  }
  return raw as Artifact;
}

function resolveMode(artifact: Artifact): string | null {
  const fromProv = artifact.provenance?.bench_mode;
  if (typeof fromProv === 'string' && fromProv.trim().length > 0) return fromProv.trim();
  const fromPayload = artifact.payload?.mode;
  if (typeof fromPayload === 'string' && fromPayload.trim().length > 0) return fromPayload.trim();
  return null;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const baseline = readArtifact(args.baselinePath);
    const candidate = readArtifact(args.candidatePath);

    const reasons: string[] = [];
    const baselineMode = resolveMode(baseline);
    const candidateMode = resolveMode(candidate);

    if (!baselineMode) reasons.push('baseline missing bench mode (provenance.bench_mode or payload.mode)');
    if (!candidateMode) reasons.push('candidate missing bench mode (provenance.bench_mode or payload.mode)');
    if (baselineMode) {
      const known = asKnownMode(baselineMode);
      if (!known) {
        reasons.push(`baseline mode invalid: ${baselineMode}`);
      } else if (!args.allowModes.includes(known)) {
        reasons.push(`baseline mode disallowed: ${baselineMode}`);
      }
    }
    if (candidateMode) {
      const known = asKnownMode(candidateMode);
      if (!known) {
        reasons.push(`candidate mode invalid: ${candidateMode}`);
      } else if (!args.allowModes.includes(known)) {
        reasons.push(`candidate mode disallowed: ${candidateMode}`);
      }
    }
    if (baselineMode && candidateMode && baselineMode !== candidateMode) {
      reasons.push(`mode mismatch: baseline=${baselineMode} candidate=${candidateMode}`);
    }

    const status: 'pass' | 'fail' = reasons.length === 0 ? 'pass' : 'fail';
    const artifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        baseline: path.resolve(args.baselinePath),
        candidate: path.resolve(args.candidatePath),
        out: path.resolve(args.outPath),
        allow_modes: args.allowModes,
      },
      observed: {
        baseline_mode: baselineMode,
        candidate_mode: candidateMode,
      },
      gate: {
        status,
        reasons,
      },
    };

    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`bench_mode_lock_gate status=${status} out=${outPath}`);
    return status === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
