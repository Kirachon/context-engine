#!/usr/bin/env node
/**
 * Informational MCP eval smoke runner (shadow gate).
 *
 * Exit codes:
 * - 0: smoke completed (default informational mode, or strict pass)
 * - 1: strict mode baseline mismatch
 * - 2: usage/runtime error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableStringify, normalizeForBaseline } from '../../evals/normalizeEvalOutput.js';
import {
  resolveDefaultMcpEvalSmokePaths,
  runMcpEvalSmoke,
  writeMcpEvalSmokeArtifacts,
} from '../../evals/runSmokeEvals.js';

interface CliArgs {
  repoRoot: string;
  outDir: string;
  baselinePath: string;
  strict: boolean;
}

const DEFAULT_OUT_DIR = path.join('artifacts', 'evals');
const DEFAULT_BASELINE = path.join('evals', 'baseline', 'mcp-eval-smoke.normalized.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/run-mcp-eval-smoke.ts [options]

Options:
  --out-dir <path>        Artifact output directory (default: ${DEFAULT_OUT_DIR})
  --baseline <path>       Baseline normalized artifact (default: ${DEFAULT_BASELINE})
  --strict                Fail when normalized output diverges from baseline
  --help, -h              Show this help
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args: CliArgs = {
    repoRoot,
    outDir: path.join(repoRoot, DEFAULT_OUT_DIR),
    baselinePath: path.join(repoRoot, DEFAULT_BASELINE),
    strict: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--strict') {
      args.strict = true;
      continue;
    }
    if (arg === '--out-dir') {
      if (!next) throw new Error('Missing value for --out-dir');
      args.outDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === '--baseline') {
      if (!next) throw new Error('Missing value for --baseline');
      args.baselinePath = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readBaselineText(baselinePath: string): string {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline artifact not found: ${baselinePath}`);
  }
  return fs.readFileSync(baselinePath, 'utf8').trim();
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const paths = resolveDefaultMcpEvalSmokePaths(args.repoRoot);
    const result = runMcpEvalSmoke(paths);
    const { rawPath, normalizedPath } = writeMcpEvalSmokeArtifacts(args.outDir, result);

    const normalizedText = stableStringify(normalizeForBaseline(result.normalized));
    const baselineText = readBaselineText(args.baselinePath);
    const baselineMatches = normalizedText === baselineText;

    // eslint-disable-next-line no-console
    console.log(
      `[mcp-eval-smoke] gate_mode=informational status=${result.normalized.summary.status} checks=${result.normalized.summary.checks_passed}/${result.normalized.summary.checks_total} fingerprint=${result.fingerprint}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-eval-smoke] sections retrieval=${result.normalized.retrieval.case_count} safety=${result.normalized.safety.passed_count}/${result.normalized.safety.case_count} usefulness=${result.normalized.usefulness.top_one_rate} performance=${result.normalized.performance.passed_count}/${result.normalized.performance.check_count}`
    );
    // eslint-disable-next-line no-console
    console.log(`[mcp-eval-smoke] raw=${rawPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-eval-smoke] normalized=${normalizedPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-eval-smoke] baseline_match=${baselineMatches ? 'yes' : 'no'}`);

    if (!baselineMatches) {
      const message = `[mcp-eval-smoke] normalized output diverged from baseline: ${args.baselinePath}`;
      if (args.strict) {
        console.error(message);
        return 1;
      }
      console.warn(`${message} (informational mode; not failing)`);
    } else {
      // eslint-disable-next-line no-console
      console.log('[mcp-eval-smoke] passed.');
    }

    return 0;
  } catch (error) {
    console.error(`[mcp-eval-smoke] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

process.exitCode = run();
