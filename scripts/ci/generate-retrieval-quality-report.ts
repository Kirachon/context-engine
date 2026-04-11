#!/usr/bin/env node
/**
 * Retrieval quality report generator from a deterministic fixture pack.
 *
 * Exit codes:
 * - 0: report generated
 * - 2: usage/parsing/schema error
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  SUPPORTED_NORMALIZATION,
  RetrievalQualityFixtureError,
  computeDatasetHash,
  countDatasetJudgments,
  getDatasetCases,
  getDatasetMap,
  getDatasetQueries,
  getHoldoutConfig,
  readFixturePack,
  resolveSelectedDatasetId,
  type RetrievalQualityCase,
  type RetrievalQualityFixturePack,
} from './retrieval-quality-fixture.js';
import {
  aggregateRetrievalEval,
  buildQualityMetricMap,
  evaluateRetrievalCase,
  type RetrievalEvalAggregateMetrics,
  type RetrievalEvalCaseResult,
} from './retrieval-quality-evaluator.js';

type EvalStatus = 'pass' | 'fail' | 'skip';
type Comparator =
  | 'delta_pct_min'
  | 'threshold_max'
  | 'threshold_min'
  | 'json_path_threshold_max'
  | 'json_path_threshold_min';
type MissingStatus = 'skip' | 'fail';
type RetrieveMode = 'fast' | 'deep';
type PerfProfile = 'default' | 'fast' | 'quality';

interface CliArgs {
  fixturePackPath: string;
  holdoutArtifactPath: string;
  outPath: string;
  workspace: string;
  datasetId?: string;
  topK: number;
  retrieveMode: RetrieveMode;
  bypassCache: boolean;
  perfProfile?: PerfProfile;
}

interface GateRules {
  min_pass_rate?: number;
  required_ids?: string[];
}

interface CalibrationWeightSnapshot {
  ranking_mode: 'v3';
  semantic_weight: number;
  lexical_weight: number;
  dense_weight: number;
}

interface CalibrationMetadata {
  approved_baseline_report_path: string;
  tuning_dataset_id: string;
  holdout_dataset_id: string;
  weight_snapshot: CalibrationWeightSnapshot;
}

interface BaseCheck {
  id: string;
  kind: Comparator;
}

interface MetricBackedCheck {
  metric?: string;
}

interface DeltaPctMinCheck extends BaseCheck, MetricBackedCheck {
  kind: 'delta_pct_min';
  baseline: number;
  candidate?: number;
  min_delta_pct: number;
}

interface ThresholdMaxCheck extends BaseCheck, MetricBackedCheck {
  kind: 'threshold_max';
  value?: number;
  max: number;
}

interface ThresholdMinCheck extends BaseCheck, MetricBackedCheck {
  kind: 'threshold_min';
  value?: number;
  min: number;
}

interface JsonPathThresholdMaxCheck extends BaseCheck {
  kind: 'json_path_threshold_max';
  path: string;
  json_path: string;
  max: number;
  missing_status?: MissingStatus;
}

interface JsonPathThresholdMinCheck extends BaseCheck {
  kind: 'json_path_threshold_min';
  path: string;
  json_path: string;
  min: number;
  missing_status?: MissingStatus;
}

type MetricCheck =
  | DeltaPctMinCheck
  | ThresholdMaxCheck
  | ThresholdMinCheck
  | JsonPathThresholdMaxCheck
  | JsonPathThresholdMinCheck;

interface EvaluationResult {
  id: string;
  status: EvalStatus;
  value: number;
  observed_value?: number;
  source_metric?: string;
  message: string;
}

interface OfflineEvalArtifact {
  dataset_id: string;
  dataset_hash: string;
  query_count: number;
  case_count: number;
  judged_path_count: number;
  top_k: number;
  retrieve_mode: RetrieveMode;
  bypass_cache: boolean;
  workspace_fingerprint: string;
  indexing: {
    refreshed: boolean;
    status_before: string | null;
    file_count_before: number | null;
    indexed: number | null;
    skipped: number | null;
    errors: number;
  };
  aggregate_metrics: RetrievalEvalAggregateMetrics;
  cases: RetrievalEvalCaseResult[];
}

interface OutputArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    fixture_pack: string;
    holdout_artifact: string;
    workspace: string;
    dataset_id: string | null;
    perf_profile: PerfProfile | null;
    top_k: number;
    retrieve_mode: RetrieveMode;
    bypass_cache: boolean;
    out: string;
  };
  offline_eval?: OfflineEvalArtifact;
  metrics: Record<string, number>;
  evaluations: EvaluationResult[];
  summary: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    pass_rate: number;
  };
  gate_rules: {
    min_pass_rate: number;
    required_ids: string[];
  };
  calibration?: CalibrationMetadata;
  gate: {
    status: 'pass' | 'fail';
    reasons: string[];
  };
  reproducibility_lock: {
    commit_sha: string;
    dataset_id: string;
    dataset_hash: string;
    fixture_pack_hash: string;
    workspace_fingerprint: string;
    feature_flags_snapshot: string;
    config_snapshot: Record<string, string | number | boolean | null>;
  };
}

type HoldoutArtifactSummary = {
  dataset_id?: string;
  dataset_hash?: string;
};

const DEFAULT_FIXTURE_PACK = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');
const DEFAULT_HOLDOUT_ARTIFACT_PATH = path.join('artifacts', 'bench', 'retrieval-holdout-check.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-report.json');

function isPerfProfile(value: string): value is PerfProfile {
  return value === 'default' || value === 'fast' || value === 'quality';
}

function getActivePerfProfile(explicitProfile?: PerfProfile): PerfProfile | null {
  if (explicitProfile) {
    return explicitProfile;
  }
  const fromEnv = process.env.CE_PERF_PROFILE?.trim();
  return fromEnv && isPerfProfile(fromEnv) ? fromEnv : null;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-retrieval-quality-report.ts [options]

Options:
  --fixture-pack <path>      Fixture-pack JSON (default: ${DEFAULT_FIXTURE_PACK})
  --holdout-artifact <path>  Holdout check artifact path (default: ${DEFAULT_HOLDOUT_ARTIFACT_PATH})
  --workspace <path>         Workspace to evaluate (default: cwd)
  --dataset-id <id>          Fixture dataset id override (default: holdout.default_dataset_id)
  --perf-profile <name>      Perf profile for retrieval/runtime loading (default: current env)
  --top-k <n>                Retrieval top K for offline eval (default: 10)
  --retrieve-mode <fast|deep> Retrieval mode for offline eval (default: fast)
  --bypass-cache             Bypass retrieval caches during offline eval
  --out <path>               Output report path (default: ${DEFAULT_OUT_PATH})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturePackPath: DEFAULT_FIXTURE_PACK,
    holdoutArtifactPath: DEFAULT_HOLDOUT_ARTIFACT_PATH,
    outPath: DEFAULT_OUT_PATH,
    workspace: process.cwd(),
    topK: 10,
    retrieveMode: 'fast',
    bypassCache: false,
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
        throw new Error(`Invalid --perf-profile: ${next}`);
      }
      args.perfProfile = next;
      i += 1;
      continue;
    }
    if (arg === '--top-k') {
      if (!next) throw new Error('Missing value for --top-k');
      const topK = Number.parseInt(next, 10);
      if (!Number.isInteger(topK) || topK < 1) {
        throw new Error('--top-k must be an integer >= 1');
      }
      args.topK = topK;
      i += 1;
      continue;
    }
    if (arg === '--retrieve-mode') {
      if (!next) throw new Error('Missing value for --retrieve-mode');
      if (next !== 'fast' && next !== 'deep') {
        throw new Error(`Invalid --retrieve-mode: ${next}`);
      }
      args.retrieveMode = next;
      i += 1;
      continue;
    }
    if (arg === '--bypass-cache') {
      args.bypassCache = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  args.workspace = path.resolve(args.workspace);
  return args;
}

function readJsonFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

function tryReadJsonObject(filePath: string): Record<string, unknown> | null {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function asObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid numeric field: ${field}`);
  }
  return value;
}

function asOptionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asFiniteNumber(value, field);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid string field: ${field}`);
  }
  return value.trim();
}

function asOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asNonEmptyString(value, field);
}

function toCalibrationMetadata(raw: unknown): CalibrationMetadata | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const obj = asObject(raw, 'Fixture pack calibration must be a JSON object');
  const weightSnapshot = asObject(
    obj.weight_snapshot,
    'Fixture pack calibration.weight_snapshot must be a JSON object'
  );

  const rankingMode = asNonEmptyString(weightSnapshot.ranking_mode, 'calibration.weight_snapshot.ranking_mode');
  if (rankingMode !== 'v3') {
    throw new Error('Invalid calibration.weight_snapshot.ranking_mode: must be "v3"');
  }

  return {
    approved_baseline_report_path: asNonEmptyString(
      obj.approved_baseline_report_path,
      'calibration.approved_baseline_report_path'
    ),
    tuning_dataset_id: asNonEmptyString(obj.tuning_dataset_id, 'calibration.tuning_dataset_id'),
    holdout_dataset_id: asNonEmptyString(obj.holdout_dataset_id, 'calibration.holdout_dataset_id'),
    weight_snapshot: {
      ranking_mode: 'v3',
      semantic_weight: asFiniteNumber(weightSnapshot.semantic_weight, 'calibration.weight_snapshot.semantic_weight'),
      lexical_weight: asFiniteNumber(weightSnapshot.lexical_weight, 'calibration.weight_snapshot.lexical_weight'),
      dense_weight: asFiniteNumber(weightSnapshot.dense_weight, 'calibration.weight_snapshot.dense_weight'),
    },
  };
}

function requireValueSource(
  metric: string | undefined,
  literalValue: number | undefined,
  field: string
): void {
  if (metric === undefined && literalValue === undefined) {
    throw new Error(`Invalid ${field}: must provide either a literal value or metric reference`);
  }
}

function toMetricChecks(rawChecks: unknown): MetricCheck[] {
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    throw new Error('Fixture pack missing checks[]');
  }

  return rawChecks.map((raw, index) => {
    const obj = asObject(raw, `Invalid checks[${index}] entry`);
    const id = obj.id;
    const kind = obj.kind;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`Invalid checks[${index}].id`);
    }
    if (
      kind !== 'delta_pct_min' &&
      kind !== 'threshold_max' &&
      kind !== 'threshold_min' &&
      kind !== 'json_path_threshold_max' &&
      kind !== 'json_path_threshold_min'
    ) {
      throw new Error(`Invalid checks[${index}].kind`);
    }

    if (kind === 'delta_pct_min') {
      const candidate = asOptionalFiniteNumber(obj.candidate, `${id}.candidate`);
      const metric = asOptionalNonEmptyString(obj.metric, `${id}.metric`);
      requireValueSource(metric, candidate, `${id}.candidate`);
      return {
        id,
        kind,
        baseline: asFiniteNumber(obj.baseline, `${id}.baseline`),
        candidate,
        metric,
        min_delta_pct: asFiniteNumber(obj.min_delta_pct, `${id}.min_delta_pct`),
      } satisfies DeltaPctMinCheck;
    }
    if (kind === 'threshold_max') {
      const value = asOptionalFiniteNumber(obj.value, `${id}.value`);
      const metric = asOptionalNonEmptyString(obj.metric, `${id}.metric`);
      requireValueSource(metric, value, `${id}.value`);
      return {
        id,
        kind,
        value,
        metric,
        max: asFiniteNumber(obj.max, `${id}.max`),
      } satisfies ThresholdMaxCheck;
    }
    if (kind === 'json_path_threshold_max') {
      return {
        id,
        kind,
        path: asNonEmptyString(obj.path, `${id}.path`),
        json_path: asNonEmptyString(obj.json_path, `${id}.json_path`),
        max: asFiniteNumber(obj.max, `${id}.max`),
        missing_status: obj.missing_status === 'fail' ? 'fail' : 'skip',
      } satisfies JsonPathThresholdMaxCheck;
    }
    if (kind === 'json_path_threshold_min') {
      return {
        id,
        kind,
        path: asNonEmptyString(obj.path, `${id}.path`),
        json_path: asNonEmptyString(obj.json_path, `${id}.json_path`),
        min: asFiniteNumber(obj.min, `${id}.min`),
        missing_status: obj.missing_status === 'fail' ? 'fail' : 'skip',
      } satisfies JsonPathThresholdMinCheck;
    }

    const value = asOptionalFiniteNumber(obj.value, `${id}.value`);
    const metric = asOptionalNonEmptyString(obj.metric, `${id}.metric`);
    requireValueSource(metric, value, `${id}.value`);
    return {
      id,
      kind,
      value,
      metric,
      min: asFiniteNumber(obj.min, `${id}.min`),
    } satisfies ThresholdMinCheck;
  });
}

function readJsonPathValue(filePath: string, jsonPath: string): number | null {
  try {
    const parsed = readJsonFile(filePath) as Record<string, unknown>;
    const tokens = jsonPath.split('.').map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) return null;
    let cursor: unknown = parsed;
    for (const token of tokens) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
      cursor = (cursor as Record<string, unknown>)[token];
    }
    if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return null;
    return cursor;
  } catch {
    return null;
  }
}

function resolveMetricValue(
  metrics: Record<string, number>,
  metric: string | undefined
): number | null {
  if (!metric) return null;
  const value = metrics[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function evaluateCheck(check: MetricCheck, metrics: Record<string, number>): EvaluationResult {
  if (check.kind === 'delta_pct_min') {
    const observed = check.metric ? resolveMetricValue(metrics, check.metric) : (check.candidate ?? null);
    if (observed === null) {
      return {
        id: check.id,
        status: 'fail',
        value: 0,
        source_metric: check.metric,
        message: `FAIL ${check.id}: missing metric ${check.metric ?? 'candidate'}`,
      };
    }
    const baseline = check.baseline;
    if (baseline <= 0) {
      return {
        id: check.id,
        status: 'skip',
        value: 0,
        observed_value: observed,
        source_metric: check.metric,
        message: `SKIP ${check.id}: baseline must be > 0 for delta_pct_min`,
      };
    }
    const deltaPct = ((observed - baseline) / baseline) * 100;
    const status: EvalStatus = deltaPct >= check.min_delta_pct ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value: deltaPct,
      observed_value: observed,
      source_metric: check.metric,
      message:
        `${status.toUpperCase()} ${check.id}: observed=${observed.toFixed(6)} baseline=${baseline.toFixed(6)} ` +
        `delta_pct=${deltaPct.toFixed(3)} min=${check.min_delta_pct}`,
    };
  }

  if (check.kind === 'threshold_max') {
    const value = check.metric ? resolveMetricValue(metrics, check.metric) : (check.value ?? null);
    if (value === null) {
      return {
        id: check.id,
        status: 'fail',
        value: 0,
        source_metric: check.metric,
        message: `FAIL ${check.id}: missing metric ${check.metric ?? 'value'}`,
      };
    }
    const status: EvalStatus = value <= check.max ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value,
      source_metric: check.metric,
      message: `${status.toUpperCase()} ${check.id}: value=${value} max=${check.max}`,
    };
  }

  if (check.kind === 'json_path_threshold_max') {
    const value = readJsonPathValue(check.path, check.json_path);
    if (value === null) {
      const status: EvalStatus = check.missing_status === 'fail' ? 'fail' : 'skip';
      return {
        id: check.id,
        status,
        value: 0,
        message: `${status.toUpperCase()} ${check.id}: missing value at ${check.path}#${check.json_path}`,
      };
    }
    const status: EvalStatus = value <= check.max ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value,
      message: `${status.toUpperCase()} ${check.id}: value=${value} max=${check.max}`,
    };
  }

  if (check.kind === 'json_path_threshold_min') {
    const value = readJsonPathValue(check.path, check.json_path);
    if (value === null) {
      const status: EvalStatus = check.missing_status === 'fail' ? 'fail' : 'skip';
      return {
        id: check.id,
        status,
        value: 0,
        message: `${status.toUpperCase()} ${check.id}: missing value at ${check.path}#${check.json_path}`,
      };
    }
    const status: EvalStatus = value >= check.min ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value,
      message: `${status.toUpperCase()} ${check.id}: value=${value} min=${check.min}`,
    };
  }

  const value = check.metric ? resolveMetricValue(metrics, check.metric) : (check.value ?? null);
  if (value === null) {
    return {
      id: check.id,
      status: 'fail',
      value: 0,
      source_metric: check.metric,
      message: `FAIL ${check.id}: missing metric ${check.metric ?? 'value'}`,
    };
  }
  const status: EvalStatus = value >= check.min ? 'pass' : 'fail';
  return {
    id: check.id,
    status,
    value,
    source_metric: check.metric,
    message: `${status.toUpperCase()} ${check.id}: value=${value} min=${check.min}`,
  };
}

function buildRetrieveOptions(topK: number, retrieveMode: RetrieveMode, bypassCache: boolean): Record<string, unknown> {
  if (retrieveMode === 'deep') {
    return {
      topK,
      perQueryTopK: Math.min(50, topK * 3),
      maxVariants: 6,
      timeoutMs: 0,
      bypassCache,
      maxOutputLength: topK * 4000,
      enableExpansion: true,
    };
  }
  return {
    topK,
    perQueryTopK: topK,
    maxVariants: 1,
    timeoutMs: 0,
    bypassCache,
    maxOutputLength: topK * 2000,
    enableExpansion: false,
  };
}

function parseHoldoutArtifactSummary(filePath: string): HoldoutArtifactSummary | null {
  const parsed = tryReadJsonObject(filePath);
  if (!parsed) {
    return null;
  }
  const summary = parsed.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }
  const summaryObj = summary as Record<string, unknown>;
  return {
    dataset_id: typeof summaryObj.dataset_id === 'string' ? summaryObj.dataset_id : undefined,
    dataset_hash: typeof summaryObj.dataset_hash === 'string' ? summaryObj.dataset_hash : undefined,
  };
}

async function evaluateOfflineDataset(
  args: CliArgs,
  fixturePack: RetrievalQualityFixturePack
): Promise<OfflineEvalArtifact | undefined> {
  const { resolveWorkspaceFingerprint } = await import('./bench-provenance.js');
  const { ContextServiceClient } = await import('../../src/mcp/serviceClient.js');
  const { internalRetrieveCode } = await import('../../src/internal/handlers/retrieval.js');
  if (!fixturePack.holdout) {
    return undefined;
  }

  const holdout = getHoldoutConfig(fixturePack);
  const datasets = getDatasetMap(holdout);
  const selectedDatasetId = resolveSelectedDatasetId(holdout, args.datasetId);
  const dataset = datasets[selectedDatasetId];
  const queries = getDatasetQueries(dataset, selectedDatasetId);
  const cases = getDatasetCases(dataset, selectedDatasetId);
  const normalizationMode =
    typeof holdout.leakage_guard?.normalization === 'string' && holdout.leakage_guard.normalization.trim().length > 0
      ? holdout.leakage_guard.normalization
      : SUPPORTED_NORMALIZATION;
  const datasetHash = computeDatasetHash(queries, normalizationMode);

  if (cases.length === 0) {
    return {
      dataset_id: selectedDatasetId,
      dataset_hash: datasetHash,
      query_count: queries.length,
      case_count: 0,
      judged_path_count: 0,
      top_k: args.topK,
      retrieve_mode: args.retrieveMode,
      bypass_cache: args.bypassCache,
      workspace_fingerprint: resolveWorkspaceFingerprint(args.workspace),
      indexing: {
        refreshed: false,
        status_before: null,
        file_count_before: null,
        indexed: null,
        skipped: null,
        errors: 0,
      },
      aggregate_metrics: {
        mrr_at_10: 0,
        ndcg_at_10: 0,
        recall_at_10: 0,
        p_at_1: 0,
        case_count: 0,
        judged_path_count: 0,
      },
      cases: [],
    };
  }

  if (!fs.existsSync(args.workspace)) {
    throw new Error(`Workspace not found: ${args.workspace}`);
  }

  const client = new ContextServiceClient(args.workspace);
  const statusBefore = client.getIndexStatus();
  const shouldRefreshIndex =
    !statusBefore ||
    statusBefore.status !== 'idle' ||
    typeof statusBefore.fileCount !== 'number' ||
    statusBefore.fileCount === 0;

  const indexReceipt = shouldRefreshIndex ? await client.indexWorkspace() : null;
  const retrievalOptions = buildRetrieveOptions(args.topK, args.retrieveMode, args.bypassCache);
  const caseResults: RetrievalEvalCaseResult[] = [];
  for (const caseDef of cases) {
    const result = await internalRetrieveCode(caseDef.query, client, retrievalOptions);
    const actualPaths = result.results
      .map((entry) => (typeof entry.path === 'string' ? entry.path : ''))
      .filter((entry) => entry.length > 0);
    caseResults.push(evaluateRetrievalCase(caseDef, actualPaths, args.topK));
  }
  const aggregateMetrics = aggregateRetrievalEval(caseResults);

  return {
    dataset_id: selectedDatasetId,
    dataset_hash: datasetHash,
    query_count: queries.length,
    case_count: cases.length,
    judged_path_count: countDatasetJudgments(cases),
    top_k: args.topK,
    retrieve_mode: args.retrieveMode,
    bypass_cache: args.bypassCache,
    workspace_fingerprint: resolveWorkspaceFingerprint(args.workspace),
    indexing: {
      refreshed: shouldRefreshIndex,
      status_before: typeof statusBefore?.status === 'string' ? statusBefore.status : null,
      file_count_before: typeof statusBefore?.fileCount === 'number' ? statusBefore.fileCount : null,
      indexed:
        indexReceipt && typeof (indexReceipt as Record<string, unknown>).indexed === 'number'
          ? ((indexReceipt as Record<string, unknown>).indexed as number)
          : null,
      skipped:
        indexReceipt && typeof (indexReceipt as Record<string, unknown>).skipped === 'number'
          ? ((indexReceipt as Record<string, unknown>).skipped as number)
          : null,
      errors:
        indexReceipt && Array.isArray((indexReceipt as Record<string, unknown>).errors)
          ? ((indexReceipt as Record<string, unknown>).errors as unknown[]).length
          : 0,
    },
    aggregate_metrics: aggregateMetrics,
    cases: caseResults,
  };
}

function createInitialMetricsMap(offlineEval: OfflineEvalArtifact | undefined): Record<string, number> {
  if (!offlineEval) {
    return {};
  }
  return buildQualityMetricMap(offlineEval.aggregate_metrics);
}

async function run(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.perfProfile) {
      process.env.CE_PERF_PROFILE = args.perfProfile;
    }
    const activePerfProfile = getActivePerfProfile(args.perfProfile);
    const {
      resolveCommitSha,
      resolveEnvFingerprint,
      resolveFeatureFlagsSnapshot,
      resolveWorkspaceFingerprint,
    } = await import('./bench-provenance.js');
    const fixture = readFixturePack(args.fixturePackPath);
    const fixtureObj = fixture.parsed;
    const checks = toMetricChecks(fixtureObj.checks);
    const calibration = toCalibrationMetadata(fixtureObj.calibration);
    const offlineEval = await evaluateOfflineDataset(args, fixtureObj);
    const metrics = createInitialMetricsMap(offlineEval);
    const evaluations = checks.map((check) => evaluateCheck(check, metrics));
    const pass = evaluations.filter((item) => item.status === 'pass').length;
    const fail = evaluations.filter((item) => item.status === 'fail').length;
    const skip = evaluations.filter((item) => item.status === 'skip').length;
    const total = evaluations.length;
    const passRate = total > 0 ? pass / total : 0;

    const rules: OutputArtifact['gate_rules'] = {
      min_pass_rate: (fixtureObj.gate_rules as GateRules | undefined)?.min_pass_rate ?? 1,
      required_ids: (fixtureObj.gate_rules as GateRules | undefined)?.required_ids ?? [],
    };

    const reasons: string[] = [];
    if (passRate < rules.min_pass_rate) {
      reasons.push(`pass_rate ${passRate.toFixed(3)} below min_pass_rate ${rules.min_pass_rate}`);
    }

    for (const requiredId of rules.required_ids) {
      const evalResult = evaluations.find((item) => item.id === requiredId);
      if (!evalResult) {
        reasons.push(`required metric missing: ${requiredId}`);
        continue;
      }
      if (evalResult.status !== 'pass') {
        reasons.push(`required metric not pass: ${requiredId} (${evalResult.status})`);
      }
    }

    const holdoutSummary = parseHoldoutArtifactSummary(args.holdoutArtifactPath);
    if (offlineEval) {
      if (
        holdoutSummary?.dataset_id &&
        holdoutSummary.dataset_id.trim().length > 0 &&
        holdoutSummary.dataset_id !== offlineEval.dataset_id
      ) {
        reasons.push(
          `holdout artifact dataset mismatch: holdout=${holdoutSummary.dataset_id} report=${offlineEval.dataset_id}`
        );
      }
      if (
        holdoutSummary?.dataset_hash &&
        holdoutSummary.dataset_hash.trim().length > 0 &&
        holdoutSummary.dataset_hash !== offlineEval.dataset_hash
      ) {
        reasons.push('holdout artifact dataset_hash mismatch');
      }
    }

    const fixtureHash = createHash('sha256').update(fixture.rawText).digest('hex');
    const reproducibilityDatasetId = offlineEval?.dataset_id ?? holdoutSummary?.dataset_id ?? 'unknown';
    const reproducibilityDatasetHash = offlineEval?.dataset_hash ?? holdoutSummary?.dataset_hash ?? 'unknown';
    const output: OutputArtifact = {
      schema_version: 2,
      generated_at: new Date().toISOString(),
      inputs: {
        fixture_pack: fixture.resolvedPath,
        holdout_artifact: path.resolve(args.holdoutArtifactPath),
        workspace: args.workspace,
        dataset_id: offlineEval?.dataset_id ?? null,
        perf_profile: activePerfProfile,
        top_k: args.topK,
        retrieve_mode: args.retrieveMode,
        bypass_cache: args.bypassCache,
        out: path.resolve(args.outPath),
      },
      offline_eval: offlineEval,
      metrics,
      evaluations,
      summary: {
        total,
        pass,
        fail,
        skip,
        pass_rate: passRate,
      },
      gate_rules: rules,
      calibration,
      gate: {
        status: reasons.length === 0 ? 'pass' : 'fail',
        reasons,
      },
      reproducibility_lock: {
        commit_sha: resolveCommitSha(),
        dataset_id: reproducibilityDatasetId,
        dataset_hash: reproducibilityDatasetHash,
        fixture_pack_hash: fixtureHash,
        workspace_fingerprint: resolveWorkspaceFingerprint(args.workspace),
        feature_flags_snapshot: resolveFeatureFlagsSnapshot(),
        config_snapshot: {
          fixture_pack: fixture.resolvedPath,
          holdout_artifact: path.resolve(args.holdoutArtifactPath),
          workspace: args.workspace,
          CE_PERF_PROFILE: process.env.CE_PERF_PROFILE ?? null,
          top_k: args.topK,
          retrieve_mode: args.retrieveMode,
          bypass_cache: args.bypassCache,
          CE_QA_DATASET_ID: process.env.CE_QA_DATASET_ID ?? null,
          CE_QA_DATASET_HASH: process.env.CE_QA_DATASET_HASH ?? null,
          env_fingerprint: resolveEnvFingerprint(),
        },
      },
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(
      `retrieval_quality_report generated: ${outPath} gate_status=${output.gate.status} pass_rate=${passRate.toFixed(3)}`
    );
    return 0;
  } catch (error) {
    if (error instanceof RetrievalQualityFixtureError) {
      // eslint-disable-next-line no-console
      console.error(`Error: ${error.message}`);
      return 2;
    }
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

void run().then((code) => {
  process.exitCode = code;
});
