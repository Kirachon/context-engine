#!/usr/bin/env node
/**
 * Q1 - Gate-state validator.
 *
 * Standalone, deterministic CI check for `config/ci/gate-tier-contract.json`.
 * Fails when:
 * - a gate's declared tier is unknown or out of the canonical
 *   report_only -> shadow_required_artifact -> calibrated -> pr_blocker order
 *   (invalid lifecycle transition);
 * - a gate is promoted past report_only while its live workflow wiring says
 *   it is unwired (invalid lifecycle transition);
 * - a `package_script` gate references a package.json script that does not
 *   exist (missing script);
 * - a workflow-execution entry references a workflow, job, or step that does
 *   not exist in `.github/workflows/**` (missing job);
 * - the contract's declared workflow-mapping inventory disagrees with the
 *   live workflow YAML and npm script chains;
 * - a gate declares `pr_blocker` without verified external branch-protection
 *   enforcement (false blocker).
 *
 * This script never promotes a gate's own truth. It only reports whether the
 * contract's declarations are internally consistent and truthful against
 * live repository state; an uncalibrated or unwired gate is never treated as
 * a blocker.
 *
 * Exit codes:
 * - 0: contract is internally consistent and truthful
 * - 1: one or more violations found
 * - 2: usage error / contract could not be read
 */

import * as fs from 'fs';
import * as path from 'path';
import { type Contract, validateGateTierContract } from './lib/gateTierContractValidator';

const DEFAULT_CONTRACT_PATH = 'config/ci/gate-tier-contract.json';

interface CheckerArgs {
  contractPath: string;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-gate-tier-contract.ts [options]

Options:
  --contract <path>   Path to the gate-tier contract JSON file.
                       Default: ${DEFAULT_CONTRACT_PATH}
  --help, -h           Show this help message.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CheckerArgs {
  const args: CheckerArgs = { contractPath: DEFAULT_CONTRACT_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if ((arg === '--contract' || arg === '--contract-path') && next) {
      args.contractPath = next.trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function readContract(relativeOrAbsolutePath: string): Contract {
  const resolved = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(process.cwd(), relativeOrAbsolutePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Gate-tier contract not found: ${relativeOrAbsolutePath}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as Contract;
}

function main(): void {
  let args: CheckerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  // eslint-disable-next-line no-console
  console.log('Gate-tier contract validator (Q1)');
  // eslint-disable-next-line no-console
  console.log(`Contract: ${args.contractPath}`);

  let contract: Contract;
  try {
    contract = readContract(args.contractPath);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const errors = validateGateTierContract(contract);
  // eslint-disable-next-line no-console
  console.log(`gates=${contract.gates.length}`);

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Gate-tier contract validation failed.');
    for (const error of errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    // eslint-disable-next-line no-console
    console.error(`${errors.length} violation(s) found.`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Gate-tier contract validation passed.');
  process.exit(0);
}

main();
