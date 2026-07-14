#!/usr/bin/env node
/**
 * Q3a - Frozen corpus and threshold contract validator.
 *
 * Standalone, deterministic CI check for
 * `config/ci/q3a-frozen-corpus-contract.json`. Fails when:
 * - a pinned corpus file's content hash does not match the contract
 *   (corpus drifted without a version bump);
 * - a pinned corpus file's case count, language set, label set, or any
 *   case's `intended_lane` does not match the contract's declared metadata;
 * - the contract does not declare exactly the seven canonical lanes
 *   (pr, nightly, release, seeded_failure, ambiguity, duplicate,
 *   performance);
 * - the contract's `version` has no matching, gap-free `version_ledger`
 *   entry, or that entry's frozen fingerprint does not match the lanes
 *   content computed right now (thresholds or corpus metadata mutated
 *   without a new version being frozen).
 *
 * This script implements contract scaffolding only (Q3a). It never computes
 * retrieval quality, catch rate, ambiguity precision/recall, or performance
 * metrics against a live system; it only proves the pinned corpora and
 * predeclared thresholds are internally consistent and unchanged.
 *
 * Exit codes:
 * - 0: contract is internally consistent and every corpus hash matches
 * - 1: one or more violations found
 * - 2: usage error / contract could not be read
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type FrozenCorpusContract,
  readJson,
  validateFrozenCorpusContract,
} from './lib/frozenCorpusContract';

const DEFAULT_CONTRACT_PATH = 'config/ci/q3a-frozen-corpus-contract.json';
const DEFAULT_OUT_PATH = path.join('artifacts', 'ci', 'q3a-frozen-corpus-contract-check.json');

interface CheckerArgs {
  contractPath: string;
  baseDir: string;
  outPath: string;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-frozen-corpus-contract.ts [options]

Options:
  --contract <path>   Path to the frozen corpus contract JSON file.
                       Default: ${DEFAULT_CONTRACT_PATH}
  --base-dir <path>   Base directory corpus_path entries resolve against.
                       Default: process.cwd()
  --out <path>        Output artifact path.
                       Default: ${DEFAULT_OUT_PATH}
  --help, -h          Show this help message.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CheckerArgs {
  const args: CheckerArgs = {
    contractPath: DEFAULT_CONTRACT_PATH,
    baseDir: process.cwd(),
    outPath: DEFAULT_OUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--contract' && next) {
      args.contractPath = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--base-dir' && next) {
      args.baseDir = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--out' && next) {
      args.outPath = next.trim();
      i += 1;
      continue;
    }
    // eslint-disable-next-line no-console
    console.error(`Unknown argument: ${arg}`);
    printHelpAndExit(2);
  }

  return args;
}

function main(): void {
  let args: CheckerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Frozen corpus and threshold contract validator (Q3a)');
  // eslint-disable-next-line no-console
  console.log(`Contract: ${args.contractPath}`);

  let contract: FrozenCorpusContract;
  try {
    contract = readJson<FrozenCorpusContract>(args.contractPath);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
    return;
  }

  const result = validateFrozenCorpusContract(contract, { baseDir: args.baseDir });

  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    inputs: {
      contract: path.resolve(args.contractPath),
      base_dir: path.resolve(args.baseDir),
    },
    contract_version: contract.version,
    lanes_fingerprint: result.lanes_fingerprint_actual,
    lanes: result.lanes,
    gate: {
      status: result.status,
      reasons: result.reasons,
    },
  };

  const outPath = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`lanes=${result.lanes.length} version=${contract.version}`);

  if (result.status !== 'pass') {
    // eslint-disable-next-line no-console
    console.error('Frozen corpus contract validation failed.');
    for (const reason of result.reasons) {
      // eslint-disable-next-line no-console
      console.error(`- ${reason}`);
    }
    // eslint-disable-next-line no-console
    console.error(`${result.reasons.length} violation(s) found.`);
    process.exit(1);
    return;
  }

  // eslint-disable-next-line no-console
  console.log('Frozen corpus contract validation passed.');
  process.exit(0);
}

main();
