#!/usr/bin/env node
/**
 * Generate retrieval telemetry snapshot artifact used by quality assertions.
 *
 * This is deterministic scaffolding. CI can override values via env vars.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

interface CliArgs {
  outPath: string;
  holdoutArtifactPath: string;
  fixturePackPath: string;
}

const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-telemetry.json');
const DEFAULT_HOLDOUT_ARTIFACT_PATH = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');
const DEFAULT_FIXTURE_PACK_PATH = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outPath: DEFAULT_OUT_PATH,
    holdoutArtifactPath: DEFAULT_HOLDOUT_ARTIFACT_PATH,
    fixturePackPath: DEFAULT_FIXTURE_PACK_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--holdout-artifact') {
      if (!next) throw new Error('Missing value for --holdout-artifact');
      args.holdoutArtifactPath = next;
      i += 1;
      continue;
    }
    if (arg === '--fixture-pack') {
      if (!next) throw new Error('Missing value for --fixture-pack');
      args.fixturePackPath = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: node --import tsx scripts/ci/generate-retrieval-quality-telemetry.ts [--out <path>] [--holdout-artifact <path>] [--fixture-pack <path>]'
      );
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

function envStr(name: string, fallback = ''): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.trim();
}

function tryReadJson(filePath: string): Record<string, unknown> | null {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function resolveCommitSha(): string {
  const fromEnv = envStr('GITHUB_SHA') || envStr('CI_COMMIT_SHA') || envStr('BUILD_SOURCEVERSION');
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return 'unknown';
  }
}

function resolveDatasetInfo(
  holdoutArtifactPath: string
): { datasetId: string; datasetHash: string; datasetHashLength: number; source: 'artifact' | 'env' | 'unknown' } {
  const fromEnvId = envStr('CE_QA_DATASET_ID');
  const fromEnvHash = envStr('CE_QA_DATASET_HASH');
  if (fromEnvId && fromEnvHash) {
    return {
      datasetId: fromEnvId,
      datasetHash: fromEnvHash,
      datasetHashLength: fromEnvHash.length,
      source: 'env',
    };
  }

  const artifact = tryReadJson(holdoutArtifactPath);
  const summary = artifact?.summary;
  const datasetId = typeof summary === 'object' && summary && !Array.isArray(summary)
    ? (summary as Record<string, unknown>).dataset_id
    : undefined;
  const datasetHash = typeof summary === 'object' && summary && !Array.isArray(summary)
    ? (summary as Record<string, unknown>).dataset_hash
    : undefined;
  if (typeof datasetId === 'string' && datasetId.length > 0 && typeof datasetHash === 'string' && datasetHash.length > 0) {
    return {
      datasetId,
      datasetHash,
      datasetHashLength: datasetHash.length,
      source: 'artifact',
    };
  }

  return {
    datasetId: 'unknown',
    datasetHash: 'unknown',
    datasetHashLength: 0,
    source: 'unknown',
  };
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const fixturePath = path.resolve(args.fixturePackPath);
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture pack not found: ${fixturePath}`);
    }
    const fixtureRaw = fs.readFileSync(fixturePath, 'utf8');
    const configSnapshotHash = createHash('sha256').update(fixtureRaw).digest('hex');
    const datasetInfo = resolveDatasetInfo(args.holdoutArtifactPath);
    const commitSha = resolveCommitSha();
    const configSnapshot: Record<string, string | null> = {
      fixture_pack: path.resolve(args.fixturePackPath),
      holdout_artifact: path.resolve(args.holdoutArtifactPath),
      CE_RETRIEVAL_PROFILE_DEFAULT: process.env.CE_RETRIEVAL_PROFILE_DEFAULT ?? null,
      CE_TOOL_RESPONSE_CACHE: process.env.CE_TOOL_RESPONSE_CACHE ?? null,
      CE_INTERNAL_REQUEST_CACHE: process.env.CE_INTERNAL_REQUEST_CACHE ?? null,
      CE_SKIP_UNCHANGED_INDEXING: process.env.CE_SKIP_UNCHANGED_INDEXING ?? null,
    };
    const payload = {
      generated_at: new Date().toISOString(),
      dense_refresh: {
        skipped_docs_rate_pct: envNum('CE_QA_DENSE_SKIPPED_DOCS_RATE_PCT', 0),
        embed_batch_p95_ms: envNum('CE_QA_DENSE_EMBED_BATCH_P95_MS', 45),
      },
      reproducibility_lock: {
        commit_sha: commitSha,
        dataset_id: datasetInfo.datasetId,
        dataset_hash: datasetInfo.datasetHash,
        dataset_hash_length: datasetInfo.datasetHashLength,
        dataset_source: datasetInfo.source,
        config_snapshot_hash: configSnapshotHash,
        config_key_count: Object.keys(configSnapshot).length,
        config_snapshot: configSnapshot,
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
