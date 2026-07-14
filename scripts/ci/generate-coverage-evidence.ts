#!/usr/bin/env node
/**
 * Q2 - Coverage evidence generator.
 *
 * Must run in the same job/run as coverage generation, immediately after the
 * threshold-enforced Jest coverage step. Reads the checked-in
 * `config/ci/coverage-threshold-contract.json`, requires the LCOV report and
 * JSON coverage summary it names to already exist, and writes a coverage
 * evidence envelope (commit SHA, threshold config hash, LCOV content hash,
 * measured totals) that a later step in the same job independently
 * re-verifies with `check-coverage-evidence.ts` before any upload.
 *
 * This script never bypasses threshold enforcement: it recomputes threshold
 * violations from the live coverage summary and fails when any are found,
 * even if an earlier step's threshold flag was looser than the checked-in
 * contract.
 *
 * Exit codes:
 * - 0: evidence generated and every declared threshold is met
 * - 1: missing LCOV/summary, or measured coverage violates the contract
 * - 2: usage error
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildCoverageEvidence,
  collectLiveCoverageState,
  CoverageEvidenceError,
  readCoverageThresholdContract,
} from './lib/coverageEvidence.js';

const DEFAULT_CONTRACT_PATH = 'config/ci/coverage-threshold-contract.json';

interface CliArgs {
  contractPath: string;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-coverage-evidence.ts [options]

Options:
  --contract <path>   Path to the coverage threshold contract JSON file.
                       Default: ${DEFAULT_CONTRACT_PATH}
  --help, -h          Show this help message.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { contractPath: DEFAULT_CONTRACT_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') printHelpAndExit(0);
    if ((arg === '--contract' || arg === '--contract-path') && next) {
      args.contractPath = next.trim();
      i += 1;
      continue;
    }
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
    const contract = readCoverageThresholdContract(args.contractPath);
    const live = collectLiveCoverageState(contract);
    const evidence = buildCoverageEvidence({ contract, live });

    const evidencePath = path.isAbsolute(contract.evidence_path)
      ? contract.evidence_path
      : path.join(process.cwd(), contract.evidence_path);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(
      `coverage_evidence status=${evidence.gate.status} commit=${evidence.commit_sha} config_hash=${evidence.config_hash.slice(0, 12)} lcov=${evidence.lcov_path} out=${evidencePath}`
    );

    if (evidence.gate.status === 'fail') {
      // eslint-disable-next-line no-console
      console.error('Coverage evidence generation found threshold violations:');
      for (const reason of evidence.gate.reasons) {
        // eslint-disable-next-line no-console
        console.error(`- ${reason}`);
      }
      return 1;
    }

    return 0;
  } catch (error) {
    if (error instanceof CoverageEvidenceError) {
      // eslint-disable-next-line no-console
      console.error(`Coverage evidence generation failed: ${error.message}`);
      return 1;
    }
    // eslint-disable-next-line no-console
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

process.exitCode = run();
