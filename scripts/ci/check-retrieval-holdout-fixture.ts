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
import {
  SUPPORTED_NORMALIZATION,
  RetrievalQualityFixtureError,
  computeDatasetHash,
  countDatasetJudgments,
  getDatasetCases,
  getDatasetMap,
  getDatasetQueries,
  getHoldoutConfig,
  normalizeQuery,
  readFixturePack,
  resolveSelectedDatasetId,
  sha256Hex,
} from './retrieval-quality-fixture.js';

interface CliArgs {
  fixturePackPath: string;
  datasetId?: string;
  outPath: string;
}

const DEFAULT_FIXTURE_PACK = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');

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

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const fixture = readFixturePack(args.fixturePackPath);
    const holdout = getHoldoutConfig(fixture.parsed);
    const datasets = getDatasetMap(holdout);
    const selectedDatasetId = resolveSelectedDatasetId(holdout, args.datasetId);
    const normalizationMode =
      typeof holdout.leakage_guard?.normalization === 'string' && holdout.leakage_guard.normalization.trim().length > 0
        ? holdout.leakage_guard.normalization
        : SUPPORTED_NORMALIZATION;

    const selectedQueries = getDatasetQueries(datasets[selectedDatasetId], selectedDatasetId);
    const selectedDatasetHash = computeDatasetHash(selectedQueries, normalizationMode);
    const selectedCases = getDatasetCases(datasets[selectedDatasetId], selectedDatasetId);
    const selectedJudgmentCount = countDatasetJudgments(selectedCases);

    const trainingDatasetId =
      typeof holdout.leakage_guard?.training_dataset_id === 'string'
        ? holdout.leakage_guard.training_dataset_id
        : undefined;
    const holdoutDatasetIdFromGuard =
      typeof holdout.leakage_guard?.holdout_dataset_id === 'string'
        ? holdout.leakage_guard.holdout_dataset_id
        : selectedDatasetId;
    if (holdoutDatasetIdFromGuard !== selectedDatasetId) {
      throw new RetrievalQualityFixtureError(
        `Selected dataset (${selectedDatasetId}) must match leakage_guard.holdout_dataset_id (${holdoutDatasetIdFromGuard})`
      );
    }

    const holdoutQueriesFromGuard = getDatasetQueries(datasets[holdoutDatasetIdFromGuard], holdoutDatasetIdFromGuard);
    const holdoutNormalizedSet = new Set(
      holdoutQueriesFromGuard.map((query) => normalizeQuery(query, normalizationMode))
    );
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
      has_leakage_guard: Boolean(holdout.leakage_guard),
      has_training_dataset_id: Boolean(trainingDatasetId),
      has_eval_cases: selectedCases.length > 0,
      has_eval_judgments: selectedJudgmentCount > 0,
    };

    const schemaReasons: string[] = [];
    if (!schemaChecks.has_leakage_guard) schemaReasons.push('missing holdout.leakage_guard');
    if (!schemaChecks.has_training_dataset_id) schemaReasons.push('missing leakage_guard.training_dataset_id');
    if (!schemaChecks.has_eval_cases) {
      schemaReasons.push(`selected dataset "${selectedDatasetId}" must define holdout evaluation cases`);
    }
    if (schemaChecks.has_eval_cases && !schemaChecks.has_eval_judgments) {
      schemaReasons.push(`selected dataset "${selectedDatasetId}" must define judged paths for each case`);
    }

    const artifact = {
      schema_version: 2,
      generated_at: new Date().toISOString(),
      inputs: {
        fixture_pack: fixture.resolvedPath,
        dataset_id: selectedDatasetId,
        out: path.resolve(args.outPath),
      },
      summary: {
        dataset_id: selectedDatasetId,
        dataset_hash: selectedDatasetHash,
        dataset_hash_length: selectedDatasetHash.length,
        query_count: selectedQueries.length,
        case_count: selectedCases.length,
        judged_path_count: selectedJudgmentCount,
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
      `retrieval_holdout_check status=${artifact.gate.status} dataset=${selectedDatasetId} leakage=${leakageUnique.length} cases=${selectedCases.length} out=${outPath}`
    );
    return artifact.gate.status === 'pass' ? 0 : 1;
  } catch (error) {
    if (error instanceof RetrievalQualityFixtureError) {
      // eslint-disable-next-line no-console
      console.error(`Validation failed: ${error.message}`);
      return 1;
    }
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
