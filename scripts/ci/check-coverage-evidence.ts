#!/usr/bin/env node
/**
 * Q2 - Coverage evidence provenance checker.
 *
 * Independently re-verifies the coverage evidence envelope written by
 * `generate-coverage-evidence.ts` earlier in the *same* job/run, before the
 * workflow uploads a coverage report. Fails closed when:
 * - no evidence envelope exists (generation was skipped or failed silently);
 * - the LCOV report or coverage summary named by the envelope no longer
 *   exists on disk (missing LCOV);
 * - the envelope's config hash, thresholds, coverage totals, LCOV content
 *   hash, or commit SHA no longer match the checked-in contract and live
 *   coverage state (mismatched provenance).
 *
 * This is the gate that lets the workflow's "Upload coverage" step trust
 * that it is uploading the exact threshold-enforced report generated in this
 * run, attributable to one commit and one config.
 *
 * Exit codes:
 * - 0: evidence is present and its provenance is truthful
 * - 1: missing evidence/LCOV, provenance mismatch, or threshold violation
 * - 2: usage error
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  collectLiveCoverageState,
  type CoverageEvidence,
  CoverageEvidenceError,
  readCoverageThresholdContract,
  validateCoverageEvidence,
} from './lib/coverageEvidence.js';
import { resolveCommitSha } from './bench-provenance.js';

const DEFAULT_CONTRACT_PATH = 'config/ci/coverage-threshold-contract.json';

interface CliArgs {
  contractPath: string;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-coverage-evidence.ts [options]

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

function readEvidence(evidencePath: string): CoverageEvidence {
  if (!fs.existsSync(evidencePath)) {
    throw new CoverageEvidenceError(
      `Coverage evidence not found at ${evidencePath}. Run "npm run ci:generate:coverage-evidence" in this job before verification.`
    );
  }
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as CoverageEvidence;
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
    const evidencePath = path.isAbsolute(contract.evidence_path)
      ? contract.evidence_path
      : path.join(process.cwd(), contract.evidence_path);
    const evidence = readEvidence(evidencePath);
    const live = collectLiveCoverageState(contract);
    const resolvedCommitSha = resolveCommitSha();
    const expectedCommitSha = resolvedCommitSha === 'unknown' ? undefined : resolvedCommitSha;

    const errors = validateCoverageEvidence(evidence, contract, live, expectedCommitSha);

    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Coverage evidence provenance verification failed:');
      for (const error of errors) {
        // eslint-disable-next-line no-console
        console.error(`- ${error}`);
      }
      return 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      `coverage_evidence_verified commit=${evidence.commit_sha} config_hash=${evidence.config_hash.slice(0, 12)} lcov=${evidence.lcov_path}`
    );
    return 0;
  } catch (error) {
    if (error instanceof CoverageEvidenceError) {
      // eslint-disable-next-line no-console
      console.error(`Coverage evidence verification failed: ${error.message}`);
      return 1;
    }
    // eslint-disable-next-line no-console
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

process.exitCode = run();
