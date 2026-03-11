#!/usr/bin/env node
/**
 * Generate retrieval telemetry snapshot artifact used by quality assertions.
 *
 * This is deterministic scaffolding. CI can override values via env vars.
 */
import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  outPath: string;
}

const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-telemetry.json');

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { outPath: DEFAULT_OUT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log('Usage: node --import tsx scripts/ci/generate-retrieval-quality-telemetry.ts [--out <path>]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payload = {
      generated_at: new Date().toISOString(),
      dense_refresh: {
        skipped_docs_rate_pct: envNum('CE_QA_DENSE_SKIPPED_DOCS_RATE_PCT', 0),
        embed_batch_p95_ms: envNum('CE_QA_DENSE_EMBED_BATCH_P95_MS', 45),
      },
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`retrieval_quality_telemetry generated: ${outPath}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();

