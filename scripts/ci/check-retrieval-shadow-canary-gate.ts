#!/usr/bin/env node
/**
 * Lightweight shadow/canary gate from local artifacts only.
 *
 * Exit codes:
 * - 0: gate pass
 * - 1: gate fail (abort threshold hit)
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  qualityReportPath: string;
  telemetryPath: string;
  holdoutPath: string;
  outPath: string;
  maxSkippedDocsRatePct: number;
  maxEmbedBatchP95Ms: number;
}

interface JsonObj {
  [key: string]: unknown;
}

const DEFAULT_QUALITY_REPORT = path.join('artifacts', 'bench', 'retrieval-quality-report.json');
const DEFAULT_TELEMETRY = path.join('artifacts', 'bench', 'retrieval-quality-telemetry.json');
const DEFAULT_HOLDOUT = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');
const DEFAULT_OUT = path.join('artifacts', 'bench', 'retrieval-shadow-canary-gate.json');

function parseFiniteNonNegativeNumber(flag: string, rawValue: string): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${rawValue}. Expected a finite non-negative number.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    qualityReportPath: DEFAULT_QUALITY_REPORT,
    telemetryPath: DEFAULT_TELEMETRY,
    holdoutPath: DEFAULT_HOLDOUT,
    outPath: DEFAULT_OUT,
    maxSkippedDocsRatePct: 20,
    maxEmbedBatchP95Ms: 250,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(`
Usage:
  node --import tsx scripts/ci/check-retrieval-shadow-canary-gate.ts [options]

Options:
  --quality-report <path>          (default: ${DEFAULT_QUALITY_REPORT})
  --telemetry <path>               (default: ${DEFAULT_TELEMETRY})
  --holdout <path>                 (default: ${DEFAULT_HOLDOUT})
  --out <path>                     (default: ${DEFAULT_OUT})
  --max-skipped-docs-rate-pct <n>  (default: 20)
  --max-embed-batch-p95-ms <n>     (default: 250)
`);
      process.exit(0);
    }
    if (arg === '--quality-report') {
      if (!next) throw new Error('Missing value for --quality-report');
      args.qualityReportPath = next;
      i += 1;
      continue;
    }
    if (arg === '--telemetry') {
      if (!next) throw new Error('Missing value for --telemetry');
      args.telemetryPath = next;
      i += 1;
      continue;
    }
    if (arg === '--holdout') {
      if (!next) throw new Error('Missing value for --holdout');
      args.holdoutPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--max-skipped-docs-rate-pct') {
      if (!next) throw new Error('Missing value for --max-skipped-docs-rate-pct');
      args.maxSkippedDocsRatePct = parseFiniteNonNegativeNumber('--max-skipped-docs-rate-pct', next);
      i += 1;
      continue;
    }
    if (arg === '--max-embed-batch-p95-ms') {
      if (!next) throw new Error('Missing value for --max-embed-batch-p95-ms');
      args.maxEmbedBatchP95Ms = parseFiniteNonNegativeNumber('--max-embed-batch-p95-ms', next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readJsonObject(filePath: string): JsonObj {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing required artifact: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Artifact must be object JSON: ${resolved}`);
  }
  return parsed as JsonObj;
}

function readNumberPath(obj: JsonObj, dottedPath: string): number | null {
  const tokens = dottedPath.split('.').map((token) => token.trim()).filter(Boolean);
  let cursor: unknown = obj;
  for (const token of tokens) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as JsonObj)[token];
  }
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return null;
  return cursor;
}

function readStringPath(obj: JsonObj, dottedPath: string): string | null {
  const tokens = dottedPath.split('.').map((token) => token.trim()).filter(Boolean);
  let cursor: unknown = obj;
  for (const token of tokens) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as JsonObj)[token];
  }
  if (typeof cursor !== 'string') return null;
  const normalized = cursor.trim();
  return normalized.length > 0 ? normalized : null;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const qualityReport = readJsonObject(args.qualityReportPath);
    const telemetry = readJsonObject(args.telemetryPath);
    const holdout = readJsonObject(args.holdoutPath);
    const reasons: string[] = [];

    const qualityStatus = (qualityReport.gate as JsonObj | undefined)?.status;
    if (qualityStatus !== 'pass') {
      reasons.push('quality report gate is not pass');
    }

    const holdoutStatus = (holdout.gate as JsonObj | undefined)?.status;
    if (holdoutStatus !== 'pass') {
      reasons.push('holdout leakage/schema gate is not pass');
    }

    const skippedDocsRate = readNumberPath(telemetry, 'dense_refresh.skipped_docs_rate_pct');
    const embedBatchP95Ms = readNumberPath(telemetry, 'dense_refresh.embed_batch_p95_ms');
    if (skippedDocsRate === null) {
      reasons.push('telemetry missing dense_refresh.skipped_docs_rate_pct');
    } else if (skippedDocsRate > args.maxSkippedDocsRatePct) {
      reasons.push(
        `abort threshold exceeded: dense_refresh.skipped_docs_rate_pct=${skippedDocsRate} > ${args.maxSkippedDocsRatePct}`
      );
    }
    if (embedBatchP95Ms === null) {
      reasons.push('telemetry missing dense_refresh.embed_batch_p95_ms');
    } else if (embedBatchP95Ms > args.maxEmbedBatchP95Ms) {
      reasons.push(`abort threshold exceeded: dense_refresh.embed_batch_p95_ms=${embedBatchP95Ms} > ${args.maxEmbedBatchP95Ms}`);
    }

    const qualityCommitSha = readStringPath(qualityReport, 'reproducibility_lock.commit_sha');
    const telemetryCommitSha = readStringPath(telemetry, 'reproducibility_lock.commit_sha');
    if (qualityCommitSha && telemetryCommitSha && qualityCommitSha !== telemetryCommitSha) {
      reasons.push(`reproducibility mismatch: commit_sha quality=${qualityCommitSha} telemetry=${telemetryCommitSha}`);
    }

    const qualityDatasetId = readStringPath(qualityReport, 'reproducibility_lock.dataset_id');
    const telemetryDatasetId = readStringPath(telemetry, 'reproducibility_lock.dataset_id');
    const holdoutDatasetId = readStringPath(holdout, 'summary.dataset_id');
    if (qualityDatasetId && telemetryDatasetId && qualityDatasetId !== telemetryDatasetId) {
      reasons.push(`reproducibility mismatch: dataset_id quality=${qualityDatasetId} telemetry=${telemetryDatasetId}`);
    }
    if (qualityDatasetId && holdoutDatasetId && qualityDatasetId !== holdoutDatasetId) {
      reasons.push(`reproducibility mismatch: dataset_id quality=${qualityDatasetId} holdout=${holdoutDatasetId}`);
    }

    const qualityDatasetHash = readStringPath(qualityReport, 'reproducibility_lock.dataset_hash');
    const telemetryDatasetHash = readStringPath(telemetry, 'reproducibility_lock.dataset_hash');
    const holdoutDatasetHash = readStringPath(holdout, 'summary.dataset_hash');
    if (qualityDatasetHash && telemetryDatasetHash && qualityDatasetHash !== telemetryDatasetHash) {
      reasons.push('reproducibility mismatch: dataset_hash quality!=telemetry');
    }
    if (qualityDatasetHash && holdoutDatasetHash && qualityDatasetHash !== holdoutDatasetHash) {
      reasons.push('reproducibility mismatch: dataset_hash quality!=holdout');
    }

    const artifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        quality_report: path.resolve(args.qualityReportPath),
        telemetry: path.resolve(args.telemetryPath),
        holdout: path.resolve(args.holdoutPath),
        out: path.resolve(args.outPath),
      },
      thresholds: {
        max_skipped_docs_rate_pct: args.maxSkippedDocsRatePct,
        max_embed_batch_p95_ms: args.maxEmbedBatchP95Ms,
      },
      observed: {
        skipped_docs_rate_pct: skippedDocsRate,
        embed_batch_p95_ms: embedBatchP95Ms,
      },
      gate: {
        status: reasons.length === 0 ? 'pass' : 'fail',
        reasons,
      },
      reproducibility_lock: {
        commit_sha:
          (qualityReport.reproducibility_lock as JsonObj | undefined)?.commit_sha ??
          (telemetry.reproducibility_lock as JsonObj | undefined)?.commit_sha ??
          'unknown',
        dataset_id:
          (qualityReport.reproducibility_lock as JsonObj | undefined)?.dataset_id ??
          (telemetry.reproducibility_lock as JsonObj | undefined)?.dataset_id ??
          'unknown',
        dataset_hash:
          (qualityReport.reproducibility_lock as JsonObj | undefined)?.dataset_hash ??
          (telemetry.reproducibility_lock as JsonObj | undefined)?.dataset_hash ??
          'unknown',
      },
    };

    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`retrieval_shadow_canary_gate status=${artifact.gate.status} out=${outPath}`);
    return artifact.gate.status === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
