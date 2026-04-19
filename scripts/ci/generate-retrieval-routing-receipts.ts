#!/usr/bin/env node
/**
 * Generate aggregated routing-diagnostics receipt artifact used by shadow gate assertions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import {
  SUPPORTED_NORMALIZATION,
  computeDatasetHash,
  getDatasetCases,
  getDatasetMap,
  getDatasetQueries,
  getHoldoutConfig,
  readFixturePack,
  resolveSelectedDatasetId,
} from './retrieval-quality-fixture.js';

interface CliArgs {
  fixturePackPath: string;
  outPath: string;
  holdoutArtifactPath: string;
  workspace: string;
  datasetId?: string;
  perfProfile?: 'default' | 'fast' | 'quality';
  bypassCache: boolean;
  declarationRoutingEnabled: boolean;
  shadowCompareEnabled: boolean;
  shadowSampleRate?: number;
}

const DEFAULT_FIXTURE_PACK_PATH = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-routing-receipts.json');
const DEFAULT_HOLDOUT_ARTIFACT_PATH = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');

function isPerfProfile(value: string): value is 'default' | 'fast' | 'quality' {
  return value === 'default' || value === 'fast' || value === 'quality';
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturePackPath: DEFAULT_FIXTURE_PACK_PATH,
    outPath: DEFAULT_OUT_PATH,
    holdoutArtifactPath: DEFAULT_HOLDOUT_ARTIFACT_PATH,
    workspace: process.cwd(),
    bypassCache: false,
    declarationRoutingEnabled: false,
    shadowCompareEnabled: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--fixture-pack') {
      if (!next) throw new Error('Missing value for --fixture-pack');
      args.fixturePackPath = next;
      i += 1;
      continue;
    }
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
    if (arg === '--workspace') {
      if (!next) throw new Error('Missing value for --workspace');
      args.workspace = next;
      i += 1;
      continue;
    }
    if (arg === '--dataset-id') {
      if (!next) throw new Error('Missing value for --dataset-id');
      args.datasetId = next;
      i += 1;
      continue;
    }
    if (arg === '--perf-profile') {
      if (!next) throw new Error('Missing value for --perf-profile');
      if (!isPerfProfile(next)) {
        throw new Error(`Invalid value for --perf-profile: ${next}. Expected default, fast, or quality.`);
      }
      args.perfProfile = next;
      i += 1;
      continue;
    }
    if (arg === '--bypass-cache') {
      args.bypassCache = true;
      continue;
    }
    if (arg === '--declaration-routing-enabled') {
      args.declarationRoutingEnabled = true;
      continue;
    }
    if (arg === '--shadow-compare-enabled') {
      args.shadowCompareEnabled = true;
      continue;
    }
    if (arg === '--shadow-sample-rate') {
      if (!next) throw new Error('Missing value for --shadow-sample-rate');
      const sampleRate = Number(next);
      if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        throw new Error(`Invalid value for --shadow-sample-rate: ${next}. Expected a number between 0 and 1.`);
      }
      args.shadowSampleRate = sampleRate;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: node --import tsx scripts/ci/generate-retrieval-routing-receipts.ts [--fixture-pack <path>] [--holdout-artifact <path>] [--workspace <path>] [--dataset-id <id>] [--perf-profile <default|fast|quality>] [--declaration-routing-enabled] [--shadow-compare-enabled] [--shadow-sample-rate <0..1>] [--bypass-cache] [--out <path>]'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
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
  fixturePackPath: string,
  datasetIdOverride: string | undefined
): { datasetId: string; datasetHash: string; datasetHashLength: number; source: 'fixture' | 'env' } {
  const fromEnvId = envStr('CE_QA_DATASET_ID');
  const fromEnvHash = envStr('CE_QA_DATASET_HASH');
  const fixture = readFixturePack(fixturePackPath).parsed;
  const holdout = getHoldoutConfig(fixture);
  const datasets = getDatasetMap(holdout);
  const selectedDatasetId = resolveSelectedDatasetId(holdout, datasetIdOverride);
  const dataset = datasets[selectedDatasetId];
  if (!dataset) {
    throw new Error(`Fixture dataset not found: ${selectedDatasetId}`);
  }
  const queries = getDatasetQueries(dataset, selectedDatasetId);
  const normalizationMode =
    typeof holdout.leakage_guard?.normalization === 'string' && holdout.leakage_guard.normalization.trim().length > 0
      ? holdout.leakage_guard.normalization
      : SUPPORTED_NORMALIZATION;
  const datasetHash = computeDatasetHash(queries, normalizationMode);
  if (fromEnvId && fromEnvHash) {
    if (fromEnvId !== selectedDatasetId || fromEnvHash !== datasetHash) {
      throw new Error(
        `CE_QA_DATASET_ID/CE_QA_DATASET_HASH do not match the selected fixture dataset (${selectedDatasetId}).`
      );
    }
    return {
      datasetId: fromEnvId,
      datasetHash: fromEnvHash,
      datasetHashLength: fromEnvHash.length,
      source: 'env',
    };
  }

  return {
    datasetId: selectedDatasetId,
    datasetHash,
    datasetHashLength: datasetHash.length,
    source: 'fixture',
  };
}

type RoutingReceiptSample = {
  id: string;
  query: string;
};

type RoutingReceiptRollup = {
  totalBundleCount: number;
  routingDiagnosticsCount: number;
  symbolRouteCount: number;
  shadowCompareReceiptCount: number;
  shadowCompareExecutedCount: number;
  receiptCoveragePct: number;
};

async function collectRoutingReceiptRollup(args: CliArgs): Promise<RoutingReceiptRollup> {
  if (!fs.existsSync(args.workspace)) {
    throw new Error(`Workspace not found: ${path.resolve(args.workspace)}`);
  }

  const fixture = readFixturePack(args.fixturePackPath).parsed;
  const holdout = getHoldoutConfig(fixture);
  const datasets = getDatasetMap(holdout);
  const selectedDatasetId = resolveSelectedDatasetId(holdout, args.datasetId);
  const dataset = datasets[selectedDatasetId];
  if (!dataset) {
    throw new Error(`Fixture dataset not found: ${selectedDatasetId}`);
  }

  if (args.declarationRoutingEnabled) {
    process.env.CE_RETRIEVAL_DECLARATION_ROUTING_V1 = 'true';
  }
  if (envStr('CE_RETRIEVAL_DECLARATION_ROUTING_V1').toLowerCase() !== 'true') {
    throw new Error('CE_RETRIEVAL_DECLARATION_ROUTING_V1 must be enabled explicitly for routing receipt generation.');
  }
  if (args.shadowCompareEnabled) {
    process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED = 'true';
  }
  if (args.shadowSampleRate !== undefined) {
    process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE = String(args.shadowSampleRate);
  }
  if (args.perfProfile) {
    process.env.CE_PERF_PROFILE = args.perfProfile;
  }

  const { ContextServiceClient } = await import('../../src/mcp/serviceClient.js');
  const client = new ContextServiceClient(args.workspace);
  const statusBefore = client.getIndexStatus();
  const shouldRefreshIndex =
    !statusBefore ||
    statusBefore.status !== 'idle' ||
    typeof statusBefore.fileCount !== 'number' ||
    statusBefore.fileCount === 0;
  if (shouldRefreshIndex) {
    await client.indexWorkspace();
  }

  const cases = getDatasetCases(dataset, selectedDatasetId);
  const queries = getDatasetQueries(dataset, selectedDatasetId);
  const samples: RoutingReceiptSample[] = cases.length > 0
    ? cases.map((entry) => ({ id: entry.id, query: entry.query }))
    : queries.map((query, index) => ({ id: `query-${index + 1}`, query }));

  let routingDiagnosticsCount = 0;
  let symbolRouteCount = 0;
  let shadowCompareReceiptCount = 0;
  let shadowCompareExecutedCount = 0;

  for (const sample of samples) {
    const bundle = await client.getContextForPrompt(sample.query, {
      maxFiles: 1,
      tokenBudget: 1200,
      includeRelated: false,
      includeSummaries: false,
      includeMemories: false,
      bypassCache: args.bypassCache,
    });
    const routingDiagnostics = bundle.metadata.routingDiagnostics;
    if (!routingDiagnostics) {
      continue;
    }
    routingDiagnosticsCount += 1;
    if (
      routingDiagnostics.selectedRoute === 'lookup_definition'
      || routingDiagnostics.selectedRoute === 'lookup_references'
      || routingDiagnostics.selectedRoute === 'lookup_body'
    ) {
      symbolRouteCount += 1;
      if (routingDiagnostics.shadowCompare) {
        shadowCompareReceiptCount += 1;
        if (routingDiagnostics.shadowCompare.executed) {
          shadowCompareExecutedCount += 1;
        }
      }
    }
  }

  return {
    totalBundleCount: samples.length,
    routingDiagnosticsCount,
    symbolRouteCount,
    shadowCompareReceiptCount,
    shadowCompareExecutedCount,
    receiptCoveragePct: symbolRouteCount === 0 ? 100 : (shadowCompareExecutedCount / symbolRouteCount) * 100,
  };
}

async function run(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const datasetInfo = resolveDatasetInfo(args.fixturePackPath, args.datasetId);
    if (args.perfProfile) {
      process.env.CE_PERF_PROFILE = args.perfProfile;
    }
    if (args.declarationRoutingEnabled) {
      process.env.CE_RETRIEVAL_DECLARATION_ROUTING_V1 = 'true';
    }
    const holdoutArtifact = tryReadJson(args.holdoutArtifactPath);
    const holdoutSummary = holdoutArtifact?.summary;
    const holdoutDatasetId =
      typeof holdoutSummary === 'object' && holdoutSummary && !Array.isArray(holdoutSummary)
        ? (holdoutSummary as Record<string, unknown>).dataset_id
        : undefined;
    const holdoutDatasetHash =
      typeof holdoutSummary === 'object' && holdoutSummary && !Array.isArray(holdoutSummary)
        ? (holdoutSummary as Record<string, unknown>).dataset_hash
        : undefined;
    if (holdoutDatasetId !== datasetInfo.datasetId || holdoutDatasetHash !== datasetInfo.datasetHash) {
      throw new Error(
        `Holdout artifact dataset does not match routing receipt dataset (holdout=${String(holdoutDatasetId)} fixture=${datasetInfo.datasetId}).`
      );
    }
    const { resolveCommitSha, resolveEnvFingerprint, resolveFeatureFlagsSnapshot, resolveWorkspaceFingerprint } =
      await import('./bench-provenance.js');
    const commitSha = resolveCommitSha();
    const rollup = await collectRoutingReceiptRollup(args);
    const configSnapshot: Record<string, string | null> = {
      fixture_pack: path.resolve(args.fixturePackPath),
      holdout_artifact: path.resolve(args.holdoutArtifactPath),
      workspace: path.resolve(args.workspace),
      dataset_id: args.datasetId ?? null,
      CE_PERF_PROFILE: process.env.CE_PERF_PROFILE ?? null,
      CE_RETRIEVAL_DECLARATION_ROUTING_V1: process.env.CE_RETRIEVAL_DECLARATION_ROUTING_V1 ?? null,
      declaration_routing_enabled: args.declarationRoutingEnabled ? 'true' : 'false',
      CE_RETRIEVAL_SHADOW_COMPARE_ENABLED: process.env.CE_RETRIEVAL_SHADOW_COMPARE_ENABLED ?? null,
      CE_RETRIEVAL_SHADOW_SAMPLE_RATE: process.env.CE_RETRIEVAL_SHADOW_SAMPLE_RATE ?? null,
      shadow_compare_enabled: args.shadowCompareEnabled ? 'true' : 'false',
    };
    const configSnapshotHash = createHash('sha256')
      .update(JSON.stringify(configSnapshot))
      .digest('hex');

    const payload = {
      generated_at: new Date().toISOString(),
      routing_diagnostics: {
        total_bundle_count: rollup.totalBundleCount,
        routing_diagnostics_count: rollup.routingDiagnosticsCount,
        symbol_route_count: rollup.symbolRouteCount,
        shadow_compare_receipt_count: rollup.shadowCompareReceiptCount,
        shadow_compare_executed_count: rollup.shadowCompareExecutedCount,
        receipt_coverage_pct: rollup.receiptCoveragePct,
      },
      reproducibility_lock: {
        commit_sha: commitSha,
        dataset_id: datasetInfo.datasetId,
        dataset_hash: datasetInfo.datasetHash,
        dataset_hash_length: datasetInfo.datasetHashLength,
        dataset_source: datasetInfo.source,
        workspace_fingerprint: resolveWorkspaceFingerprint(args.workspace),
        feature_flags_snapshot: resolveFeatureFlagsSnapshot(),
        env_fingerprint: resolveEnvFingerprint(),
        config_snapshot_hash: configSnapshotHash,
        config_key_count: Object.keys(configSnapshot).length,
        config_snapshot: configSnapshot,
      },
    };

    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`retrieval_routing_receipts generated: ${outPath}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

run().then((code) => {
  process.exitCode = code;
});
