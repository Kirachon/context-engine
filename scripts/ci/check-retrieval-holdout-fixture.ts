#!/usr/bin/env node
/**
 * Deterministic holdout fixture validator with schema/hash/leakage checks.
 *
 * Exit codes:
 * - 0: pass
 * - 1: validation failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

interface CliArgs {
  fixturePackPath: string;
  datasetId?: string;
  outPath: string;
}

interface DatasetDef {
  description?: string;
  queries?: unknown;
}

interface HoldoutFixture {
  enabled?: unknown;
  default_dataset_id?: unknown;
  datasets?: unknown;
  leakage_guard?: {
    training_dataset_id?: unknown;
    holdout_dataset_id?: unknown;
    normalization?: unknown;
  };
}

const DEFAULT_FIXTURE_PACK = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');

class ValidationError extends Error {}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-retrieval-holdout-fixture.ts [options]

Options:
  --fixture-pack <path>      Fixture-pack JSON (default: ${DEFAULT_FIXTURE_PACK})
  --dataset-id <id>          Holdout dataset id (default: fixture holdout.default_dataset_id)
  --out <path>               Output artifact path (default: ${DEFAULT_OUT_PATH})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturePackPath: DEFAULT_FIXTURE_PACK,
    outPath: DEFAULT_OUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--fixture-pack') {
      if (!next) throw new Error('Missing value for --fixture-pack');
      args.fixturePackPath = next;
      i += 1;
      continue;
    }
    if (arg === '--dataset-id') {
      if (!next) throw new Error('Missing value for --dataset-id');
      args.datasetId = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

const SUPPORTED_NORMALIZATION = 'trim_lower_whitespace_collapse';

function normalizeQuery(raw: string, normalization: string): string {
  if (normalization === SUPPORTED_NORMALIZATION) {
    return raw.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  throw new ValidationError(`Unsupported normalization mode: ${normalization}`);
}

function readFixture(filePath: string): { rawText: string; parsed: Record<string, unknown> } {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Fixture pack not found: ${resolved}`);
  }
  const rawText = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fixture pack must be a JSON object');
  }
  return { rawText, parsed: parsed as Record<string, unknown> };
}

function getDatasetQueries(dataset: DatasetDef | undefined, label: string): string[] {
  if (!dataset || !Array.isArray(dataset.queries)) {
    throw new ValidationError(`Dataset "${label}" missing queries[]`);
  }
  const out = dataset.queries
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new ValidationError(`Dataset "${label}" contains non-string query entries`);
      }
      return entry.trim();
    })
    .filter((entry) => entry.length > 0);
  if (out.length === 0) throw new ValidationError(`Dataset "${label}" has no usable queries`);
  return out;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const fixture = readFixture(args.fixturePackPath);
    const holdout = fixture.parsed.holdout as HoldoutFixture | undefined;
    const holdoutObj = holdout && typeof holdout === 'object' ? holdout : undefined;
    if (!holdoutObj) {
      throw new Error('Fixture pack missing holdout object');
    }
    const datasets = holdoutObj.datasets as Record<string, DatasetDef> | undefined;
    if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) {
      throw new Error('Fixture holdout.datasets must be an object');
    }

    const selectedDatasetId =
      args.datasetId ??
      (typeof holdoutObj.default_dataset_id === 'string' && holdoutObj.default_dataset_id.trim().length > 0
        ? holdoutObj.default_dataset_id
        : undefined);
    if (!selectedDatasetId) {
      throw new Error('No holdout dataset id selected');
    }

    const leakageGuard = holdoutObj.leakage_guard;
    const normalizationMode =
      typeof leakageGuard?.normalization === 'string' && leakageGuard.normalization.trim().length > 0
        ? leakageGuard.normalization
        : SUPPORTED_NORMALIZATION;

    const selectedQueries = getDatasetQueries(datasets[selectedDatasetId], selectedDatasetId);
    const selectedNormalized = selectedQueries.map((query) => normalizeQuery(query, normalizationMode));
    const selectedDatasetHash = sha256Hex(JSON.stringify(selectedNormalized));

    const trainingDatasetId =
      typeof leakageGuard?.training_dataset_id === 'string' ? leakageGuard.training_dataset_id : undefined;
    const holdoutDatasetIdFromGuard =
      typeof leakageGuard?.holdout_dataset_id === 'string' ? leakageGuard.holdout_dataset_id : selectedDatasetId;
    if (holdoutDatasetIdFromGuard !== selectedDatasetId) {
      throw new ValidationError(
        `Selected dataset (${selectedDatasetId}) must match leakage_guard.holdout_dataset_id (${holdoutDatasetIdFromGuard})`
      );
    }
    const holdoutQueriesFromGuard = getDatasetQueries(datasets[holdoutDatasetIdFromGuard], holdoutDatasetIdFromGuard);
    const holdoutNormalizedSet = new Set(holdoutQueriesFromGuard.map((query) => normalizeQuery(query, normalizationMode)));
    const trainingQueries = trainingDatasetId ? getDatasetQueries(datasets[trainingDatasetId], trainingDatasetId) : [];
    const leakageMatches = trainingQueries
      .map((query) => normalizeQuery(query, normalizationMode))
      .filter((query) => holdoutNormalizedSet.has(query))
      .sort((a, b) => a.localeCompare(b));
    const leakageUnique = [...new Set(leakageMatches)];

    const schemaChecks = {
      has_holdout_object: true,
      has_datasets_object: true,
      has_selected_dataset: selectedQueries.length > 0,
      has_leakage_guard: Boolean(leakageGuard),
      has_training_dataset_id: Boolean(trainingDatasetId),
    };

    const schemaReasons: string[] = [];
    if (!schemaChecks.has_leakage_guard) schemaReasons.push('missing holdout.leakage_guard');
    if (!schemaChecks.has_training_dataset_id) schemaReasons.push('missing leakage_guard.training_dataset_id');

    const artifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        fixture_pack: path.resolve(args.fixturePackPath),
        dataset_id: selectedDatasetId,
        out: path.resolve(args.outPath),
      },
      summary: {
        dataset_id: selectedDatasetId,
        dataset_hash: selectedDatasetHash,
        dataset_hash_length: selectedDatasetHash.length,
        query_count: selectedQueries.length,
        leakage_count: leakageUnique.length,
        leakage_guard_training_dataset_id: trainingDatasetId ?? null,
        leakage_guard_holdout_dataset_id: holdoutDatasetIdFromGuard,
      },
      schema_checks: schemaChecks,
      leakage: {
        matches: leakageUnique,
      },
      reproducibility_lock: {
        fixture_pack_hash: sha256Hex(fixture.rawText),
        normalization: normalizationMode,
      },
      gate: {
        status: leakageUnique.length === 0 && schemaReasons.length === 0 ? 'pass' : 'fail',
        reasons: [
          ...schemaReasons,
          ...(leakageUnique.length === 0 ? [] : [`holdout leakage detected: ${leakageUnique.length} overlaps`]),
        ],
      },
    };

    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(
      `retrieval_holdout_check status=${artifact.gate.status} dataset=${selectedDatasetId} leakage=${leakageUnique.length} out=${outPath}`
    );
    return artifact.gate.status === 'pass' ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    if (error instanceof ValidationError) {
      console.error(`Validation failed: ${error.message}`);
      return 1;
    }
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
