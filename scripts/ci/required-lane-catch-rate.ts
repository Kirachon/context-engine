#!/usr/bin/env node
/**
 * Q3b — Required-lane catch-rate evaluator CLI.
 *
 * Exit codes:
 * - 0: catch rate meets frozen threshold; provenance-valid report written
 * - 1: gate fail (catch rate below threshold, false positives, corpus drift)
 * - 2: usage / missing evaluator or corpus
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildCatchRateReport,
  DEFAULT_CONTRACT_PATH,
  DEFAULT_OUT_PATH,
  RequiredLaneCatchRateError,
  writeCatchRateReport,
} from './lib/requiredLaneCatchRate.js';
import { FrozenCorpusContractError } from './lib/frozenCorpusContract.js';

interface CliArgs {
  contractPath: string;
  outPath: string;
  repoRoot: string;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/required-lane-catch-rate.ts [options]

Options:
  --contract <path>   Q3a frozen corpus contract (default: ${DEFAULT_CONTRACT_PATH})
  --out <path>        Report output path (default: ${DEFAULT_OUT_PATH})
  --repo-root <path>  Repository root to evaluate (default: cwd)
  --help, -h          Show this help message
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    contractPath: DEFAULT_CONTRACT_PATH,
    outPath: DEFAULT_OUT_PATH,
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') printHelpAndExit(0);
    if ((arg === '--contract' || arg === '--contract-path') && next) {
      args.contractPath = next.trim();
      i += 1;
      continue;
    }
    if ((arg === '--out' || arg === '--out-path') && next) {
      args.outPath = next.trim();
      i += 1;
      continue;
    }
    if ((arg === '--repo-root' || arg === '--cwd') && next) {
      args.repoRoot = path.resolve(next.trim());
      i += 1;
      continue;
    }
    throw new RequiredLaneCatchRateError(`Unknown or incomplete argument: ${arg}`);
  }

  return args;
}

function run(): number {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    if (!fs.existsSync(path.join(args.repoRoot, 'scripts/ci/lib/requiredLaneCatchRate.ts')) &&
        !fs.existsSync(path.join(args.repoRoot, 'scripts/ci/lib/requiredLaneCatchRate.js'))) {
      throw new RequiredLaneCatchRateError('Missing required-lane catch-rate evaluator module');
    }

    const report = buildCatchRateReport({
      repoRoot: args.repoRoot,
      contractPath: args.contractPath,
    });
    writeCatchRateReport(report, args.outPath);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        status: report.gate.status,
        catch_rate_pct: report.metrics.catch_rate_pct,
        threshold_min_catch_rate_pct: report.threshold_min_catch_rate_pct,
        out: args.outPath,
        commit_sha: report.commit_sha,
        corpus_sha256: report.corpus_sha256,
      })
    );

    if (report.gate.status === 'fail') {
      // eslint-disable-next-line no-console
      console.error(`required_lane_catch_rate_failed: ${report.gate.reasons.join('; ')}`);
      return 1;
    }

    // eslint-disable-next-line no-console
    console.log('required_lane_catch_rate_passed');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(message);
    if (
      error instanceof RequiredLaneCatchRateError ||
      error instanceof FrozenCorpusContractError
    ) {
      return 2;
    }
    return 2;
  }
}

process.exit(run());
