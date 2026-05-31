import * as fs from 'node:fs';
import * as path from 'node:path';

import { assembleContextPackWithTimestamp } from '../src/context/contextPackAssembler.js';
import type { ContextBundle } from '../src/mcp/serviceClient.js';
import {
  computeDatasetHash,
  getDatasetCases,
  getDatasetMap,
  getHoldoutConfig,
  normalizeQuery,
  readFixturePack,
  resolveSelectedDatasetId,
  SUPPORTED_NORMALIZATION,
  sha256Hex,
  type RetrievalQualityCase,
} from '../scripts/ci/retrieval-quality-fixture.js';
import { buildPerformanceReceipt, resolveDefaultPerformancePaths } from './performanceEval.js';
import {
  buildNormalizedFingerprint,
  MCP_EVAL_SMOKE_SCHEMA_VERSION,
  normalizeForBaseline,
  stableStringify,
  type EvalSectionStatus,
  type NormalizedContextPackReceipt,
  type NormalizedMcpEvalSmoke,
  type NormalizedRetrievalCaseReceipt,
  type NormalizedRetrievalReceipt,
} from './normalizeEvalOutput.js';
import { buildSafetyReceipt, resolveDefaultSafetyPaths } from './safetyEval.js';
import { buildUsefulnessReceipt, resolveDefaultUsefulnessPaths } from './usefulnessEval.js';

export interface ContextPackFixtureCase {
  id: string;
  bundle: ContextBundle;
  options?: {
    tokenBudget?: number;
    maxItems?: number;
  };
}

export interface ContextPackFixturesFile {
  schema_version: number;
  assembled_at: string;
  cases: ContextPackFixtureCase[];
}

export interface RetrievalFixturesFile {
  schema_version: number;
  source_fixture_pack: string;
  dataset_id: string;
  case_ids: string[];
}

export interface McpEvalSmokePaths {
  repoRoot: string;
  contextPackFixturesPath: string;
  retrievalFixturesPath: string;
}

export interface McpEvalSmokeRunResult {
  raw: NormalizedMcpEvalSmoke & { generated_at: string };
  normalized: NormalizedMcpEvalSmoke;
  fingerprint: string;
}

function readJsonFile<T>(filePath: string): T {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing fixture file: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

function buildRetrievalReceipt(
  repoRoot: string,
  retrievalFixtures: RetrievalFixturesFile
): NormalizedRetrievalReceipt {
  const sourcePath = path.resolve(repoRoot, retrievalFixtures.source_fixture_pack);
  const fixture = readFixturePack(sourcePath);
  const holdout = getHoldoutConfig(fixture.parsed);
  const datasets = getDatasetMap(holdout);
  const datasetId = resolveSelectedDatasetId(holdout, retrievalFixtures.dataset_id);
  const dataset = datasets[datasetId];
  const allCases = getDatasetCases(dataset, datasetId);
  const selectedIds = new Set(retrievalFixtures.case_ids);
  const selectedCases = allCases.filter((entry) => selectedIds.has(entry.id));

  if (selectedCases.length !== retrievalFixtures.case_ids.length) {
    const found = new Set(selectedCases.map((entry) => entry.id));
    const missing = retrievalFixtures.case_ids.filter((entry) => !found.has(entry));
    throw new Error(`Retrieval fixture cases not found in ${datasetId}: ${missing.join(', ')}`);
  }

  selectedCases.sort((left, right) => left.id.localeCompare(right.id));

  const cases: NormalizedRetrievalCaseReceipt[] = selectedCases.map((entry) =>
    buildRetrievalCaseReceipt(entry)
  );
  const queries = selectedCases.map((entry) => entry.query);
  const datasetHash = computeDatasetHash(queries, SUPPORTED_NORMALIZATION);

  return {
    source_fixture_pack: retrievalFixtures.source_fixture_pack.replace(/\\/g, '/'),
    dataset_id: datasetId,
    case_count: cases.length,
    judgment_count: cases.reduce((sum, entry) => sum + entry.judgment_paths.length, 0),
    dataset_hash: datasetHash,
    cases,
  };
}

function buildRetrievalCaseReceipt(entry: RetrievalQualityCase): NormalizedRetrievalCaseReceipt {
  const queryNormalized = normalizeQuery(entry.query, SUPPORTED_NORMALIZATION);
  const judgmentPaths = entry.judgments.map((judgment) => judgment.path).sort();
  return {
    id: entry.id,
    query_normalized: queryNormalized,
    query_hash: sha256Hex(queryNormalized),
    judgment_paths: judgmentPaths,
    judgment_hash: sha256Hex(JSON.stringify(judgmentPaths)),
  };
}

function buildContextPackReceipts(
  contextPackFixtures: ContextPackFixturesFile
): NormalizedContextPackReceipt[] {
  return contextPackFixtures.cases.map((fixtureCase) => {
    const { pack } = assembleContextPackWithTimestamp(
      fixtureCase.bundle,
      contextPackFixtures.assembled_at,
      fixtureCase.options ?? {}
    );
    return {
      fixture_id: fixtureCase.id,
      pack_id: pack.id,
      item_count: pack.metadata.item_count,
      file_count: pack.metadata.file_count,
      item_ids: pack.items.map((item) => item.id),
      token_budget: {
        requested: pack.token_budget.requested,
        used: pack.token_budget.used,
        truncated: pack.token_budget.truncated,
      },
      truncated: pack.metadata.truncated,
      ...(pack.metadata.truncation_reasons
        ? { truncation_reasons: pack.metadata.truncation_reasons }
        : {}),
    };
  });
}

function sectionStatus(passed: number, total: number): EvalSectionStatus {
  return passed === total ? 'pass' : 'fail';
}

function buildSummary(normalized: Omit<NormalizedMcpEvalSmoke, 'summary'>): NormalizedMcpEvalSmoke['summary'] {
  const contextPackChecks = normalized.context_packs.length;
  const contextPackPassed = normalized.context_packs.length;
  const safetyPassed = normalized.safety.passed_count;
  const usefulnessPassed = normalized.usefulness.cases.filter((entry) => entry.matched_expected).length;
  const performancePassed = normalized.performance.passed_count;

  const checksTotal =
    normalized.retrieval.case_count +
    contextPackChecks +
    normalized.safety.case_count +
    normalized.usefulness.case_count +
    normalized.performance.check_count;
  const checksPassed =
    normalized.retrieval.case_count +
    contextPackPassed +
    safetyPassed +
    usefulnessPassed +
    performancePassed;

  return {
    status: checksPassed === checksTotal ? 'pass' : 'fail',
    checks_passed: checksPassed,
    checks_total: checksTotal,
  };
}

export function runMcpEvalSmoke(paths: McpEvalSmokePaths): McpEvalSmokeRunResult {
  const contextPackFixtures = readJsonFile<ContextPackFixturesFile>(paths.contextPackFixturesPath);
  const retrievalFixtures = readJsonFile<RetrievalFixturesFile>(paths.retrievalFixturesPath);

  const retrieval = buildRetrievalReceipt(paths.repoRoot, retrievalFixtures);
  const contextPacks = buildContextPackReceipts(contextPackFixtures);
  const safety = buildSafetyReceipt(resolveDefaultSafetyPaths(paths.repoRoot));
  const usefulness = buildUsefulnessReceipt(resolveDefaultUsefulnessPaths(paths.repoRoot));
  const performance = buildPerformanceReceipt(resolveDefaultPerformancePaths(paths.repoRoot), {
    retrieval,
    contextPacks,
    safety,
    usefulness,
  });

  const withoutSummary: Omit<NormalizedMcpEvalSmoke, 'summary'> = {
    schema_version: MCP_EVAL_SMOKE_SCHEMA_VERSION,
    gate_mode: 'informational',
    retrieval,
    context_packs: contextPacks,
    safety,
    usefulness,
    performance,
  };

  const normalized: NormalizedMcpEvalSmoke = {
    ...withoutSummary,
    summary: buildSummary(withoutSummary),
  };

  const raw = {
    ...normalized,
    generated_at: new Date().toISOString(),
  };

  return {
    raw,
    normalized,
    fingerprint: buildNormalizedFingerprint(normalized),
  };
}

export function writeMcpEvalSmokeArtifacts(
  outDir: string,
  result: McpEvalSmokeRunResult
): { rawPath: string; normalizedPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'mcp-eval-smoke.json');
  const normalizedPath = path.join(outDir, 'mcp-eval-smoke.normalized.json');
  fs.writeFileSync(rawPath, `${JSON.stringify(result.raw, null, 2)}\n`, 'utf8');
  fs.writeFileSync(normalizedPath, `${stableStringify(normalizeForBaseline(result.normalized))}\n`, 'utf8');
  return { rawPath, normalizedPath };
}

export function resolveDefaultMcpEvalSmokePaths(repoRoot: string): McpEvalSmokePaths {
  return {
    repoRoot,
    contextPackFixturesPath: path.join(repoRoot, 'evals', 'fixtures', 'context-pack-fixtures.json'),
    retrievalFixturesPath: path.join(repoRoot, 'evals', 'fixtures', 'retrieval-fixtures.json'),
  };
}
