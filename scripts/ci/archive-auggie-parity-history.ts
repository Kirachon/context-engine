#!/usr/bin/env node
/**
 * Archive the latest Auggie capability parity gate artifact into history.
 *
 * Exit codes:
 * - 0: archived successfully
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  artifactPath: string;
  historyDir: string;
  prefix: string;
}

const DEFAULT_ARTIFACT_PATH = path.join('artifacts', 'bench', 'auggie-capability-parity-gate.json');
const DEFAULT_HISTORY_DIR = path.join('artifacts', 'bench', 'auggie-parity-history');
const DEFAULT_PREFIX = 'auggie-capability-parity';

function printHelpAndExit(code: number): never {
  console.log(`
Usage:
  node --import tsx scripts/ci/archive-auggie-parity-history.ts [options]

Options:
  --artifact <path>   Gate artifact to archive (default: ${DEFAULT_ARTIFACT_PATH})
  --history-dir <path> History directory (default: ${DEFAULT_HISTORY_DIR})
  --prefix <value>    File prefix (default: ${DEFAULT_PREFIX})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    artifactPath: DEFAULT_ARTIFACT_PATH,
    historyDir: DEFAULT_HISTORY_DIR,
    prefix: DEFAULT_PREFIX,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--artifact') {
      if (!next) throw new Error('Missing value for --artifact');
      args.artifactPath = next;
      i += 1;
      continue;
    }
    if (arg === '--history-dir') {
      if (!next) throw new Error('Missing value for --history-dir');
      args.historyDir = next;
      i += 1;
      continue;
    }
    if (arg === '--prefix') {
      if (!next) throw new Error('Missing value for --prefix');
      args.prefix = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const artifactPath = path.resolve(args.artifactPath);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact not found: ${artifactPath}`);
    }

    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as { generated_at?: string };
    const stamp = (parsed.generated_at ?? new Date().toISOString()).replace(/[:.]/g, '-');
    const historyDir = path.resolve(args.historyDir);
    fs.mkdirSync(historyDir, { recursive: true });

    const outPath = path.join(historyDir, `${args.prefix}-${stamp}.json`);
    fs.copyFileSync(artifactPath, outPath);

    console.log(`archived=${outPath}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
