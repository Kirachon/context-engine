#!/usr/bin/env node
/**
 * Informational MCP compatibility gate runner.
 *
 * Exit codes:
 * - 0: gate completed (default informational mode, or strict pass)
 * - 1: strict mode baseline mismatch or section failure
 * - 2: usage/runtime error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableStringify, normalizeForBaseline } from '../../evals/normalizeEvalOutput.js';
import {
  runMcpCompatibility,
  writeMcpCompatibilityArtifacts,
} from '../../evals/runCompatibilityEvals.js';

interface CliArgs {
  repoRoot: string;
  outDir: string;
  baselinePath: string;
  strict: boolean;
}

const DEFAULT_OUT_DIR = path.join('artifacts', 'evals');
const DEFAULT_BASELINE = path.join('evals', 'baseline', 'mcp-compatibility.normalized.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/run-mcp-compatibility.ts [options]

Options:
  --out-dir <path>        Artifact output directory (default: ${DEFAULT_OUT_DIR})
  --baseline <path>       Baseline normalized artifact (default: ${DEFAULT_BASELINE})
  --strict                Fail when normalized output diverges from baseline or sections fail
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
    const result = runMcpCompatibility(args.repoRoot);
    const { rawPath, normalizedPath, smokeRawPath, smokeNormalizedPath } = writeMcpCompatibilityArtifacts(
      args.outDir,
      result
    );

    const normalizedText = stableStringify(normalizeForBaseline(result.normalized));
    const baselineText = readBaselineText(args.baselinePath);
    const baselineMatches = normalizedText === baselineText;
    const sectionFailures = Object.entries(result.normalized.eval_smoke.sections)
      .filter(([, status]) => status !== 'pass')
      .map(([section]) => section);
    const parityFailed = result.normalized.compatibility.tool_manifest_parity.status !== 'pass';

    // eslint-disable-next-line no-console
    console.log(
      `[mcp-compatibility] gate_mode=informational status=${result.normalized.summary.status} checks=${result.normalized.summary.checks_passed}/${result.normalized.summary.checks_total} fingerprint=${result.fingerprint}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-compatibility] eval_smoke=${result.normalized.eval_smoke.status} sections=${JSON.stringify(result.normalized.eval_smoke.sections)}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-compatibility] tool_manifest_parity=${result.normalized.compatibility.tool_manifest_parity.status}`
    );
    // eslint-disable-next-line no-console
    console.log(`[mcp-compatibility] raw=${rawPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-compatibility] normalized=${normalizedPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-compatibility] smoke_raw=${smokeRawPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-compatibility] smoke_normalized=${smokeNormalizedPath}`);
    // eslint-disable-next-line no-console
    console.log(`[mcp-compatibility] baseline_match=${baselineMatches ? 'yes' : 'no'}`);

    const hasSectionFailure = sectionFailures.length > 0 || parityFailed || result.normalized.summary.status !== 'pass';

    if (!baselineMatches) {
      const message = `[mcp-compatibility] normalized output diverged from baseline: ${args.baselinePath}`;
      if (args.strict) {
        console.error(message);
        return 1;
      }
      console.warn(`${message} (informational mode; not failing)`);
    }

    if (hasSectionFailure) {
      const message = `[mcp-compatibility] one or more sections failed: ${[
        ...sectionFailures,
        ...(parityFailed ? ['tool_manifest_parity'] : []),
      ].join(', ')}`;
      if (args.strict) {
        console.error(message);
        return 1;
      }
      console.warn(`${message} (informational mode; not failing)`);
    }

    if (baselineMatches && !hasSectionFailure) {
      // eslint-disable-next-line no-console
      console.log('[mcp-compatibility] passed.');
    }

    return 0;
  } catch (error) {
    console.error(`[mcp-compatibility] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

process.exitCode = run();
