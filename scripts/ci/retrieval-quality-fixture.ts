import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export const SUPPORTED_NORMALIZATION = 'trim_lower_whitespace_collapse';

export class RetrievalQualityFixtureError extends Error {}

export interface RetrievalQualityJudgment {
  path: string;
  grade: number;
}

export interface RetrievalQualityCase {
  id: string;
  query: string;
  judgments: RetrievalQualityJudgment[];
}

export interface RetrievalQualityDataset {
  description?: string;
  queries?: string[];
  cases?: RetrievalQualityCase[];
}

export interface RetrievalQualityHoldout {
  enabled?: boolean;
  default_dataset_id?: string;
  datasets?: Record<string, RetrievalQualityDataset>;
  leakage_guard?: {
    training_dataset_id?: string;
    holdout_dataset_id?: string;
    normalization?: string;
  };
}

export interface RetrievalQualityFixturePack {
  schema_version?: number;
  generated_for?: string;
  holdout?: RetrievalQualityHoldout;
  calibration?: unknown;
  checks?: unknown;
  gate_rules?: unknown;
}

type RawDataset = {
  description?: unknown;
  queries?: unknown;
  cases?: unknown;
};

type RawCase = {
  id?: unknown;
  query?: unknown;
  expected_paths?: unknown;
  relevant_paths?: unknown;
  judgments?: unknown;
};

type RawJudgment = {
  path?: unknown;
  grade?: unknown;
};

export function normalizeQuery(raw: string, normalization: string = SUPPORTED_NORMALIZATION): string {
  if (normalization === SUPPORTED_NORMALIZATION) {
    return raw.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  throw new RetrievalQualityFixtureError(`Unsupported normalization mode: ${normalization}`);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readFixturePack(
  filePath: string
): { rawText: string; parsed: RetrievalQualityFixturePack; resolvedPath: string } {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Fixture pack not found: ${resolvedPath}`);
  }
  const rawText = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fixture pack must be a JSON object');
  }
  return {
    rawText,
    parsed: parsed as RetrievalQualityFixturePack,
    resolvedPath,
  };
}

function normalizeFixturePath(rawPath: string, fieldLabel: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new RetrievalQualityFixtureError(`${fieldLabel} must not be empty`);
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new RetrievalQualityFixtureError(`${fieldLabel} must be repo-relative`);
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new RetrievalQualityFixtureError(`${fieldLabel} must stay within the repository`);
  }
  return normalized;
}

function parseQueries(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" missing queries[]`);
  }
  const queries = raw
    .map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new RetrievalQualityFixtureError(`Dataset "${label}" query[${index}] must be a string`);
      }
      return entry.trim();
    })
    .filter((entry) => entry.length > 0);
  if (queries.length === 0) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" has no usable queries`);
  }
  return queries;
}

function toJudgments(
  rawCase: RawCase,
  datasetLabel: string,
  caseIndex: number
): RetrievalQualityJudgment[] {
  const label = `Dataset "${datasetLabel}" case[${caseIndex}]`;
  const explicitJudgments = Array.isArray(rawCase.judgments) ? rawCase.judgments : [];
  const expectedPaths = Array.isArray(rawCase.expected_paths)
    ? rawCase.expected_paths
    : Array.isArray(rawCase.relevant_paths)
      ? rawCase.relevant_paths
      : [];

  const judgments = new Map<string, RetrievalQualityJudgment>();
  for (const [judgmentIndex, entry] of explicitJudgments.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RetrievalQualityFixtureError(`${label} judgments[${judgmentIndex}] must be an object`);
    }
    const rawJudgment = entry as RawJudgment;
    if (typeof rawJudgment.path !== 'string') {
      throw new RetrievalQualityFixtureError(`${label} judgments[${judgmentIndex}].path must be a string`);
    }
    const grade = typeof rawJudgment.grade === 'number' ? rawJudgment.grade : 1;
    if (!Number.isInteger(grade) || grade < 1) {
      throw new RetrievalQualityFixtureError(`${label} judgments[${judgmentIndex}].grade must be an integer >= 1`);
    }
    const normalizedPath = normalizeFixturePath(rawJudgment.path, `${label} judgments[${judgmentIndex}].path`);
    const existing = judgments.get(normalizedPath);
    if (!existing || grade > existing.grade) {
      judgments.set(normalizedPath, { path: normalizedPath, grade });
    }
  }

  for (const [pathIndex, entry] of expectedPaths.entries()) {
    if (typeof entry !== 'string') {
      throw new RetrievalQualityFixtureError(`${label} expected_paths[${pathIndex}] must be a string`);
    }
    const normalizedPath = normalizeFixturePath(entry, `${label} expected_paths[${pathIndex}]`);
    const existing = judgments.get(normalizedPath);
    if (!existing) {
      judgments.set(normalizedPath, { path: normalizedPath, grade: 1 });
    }
  }

  const output = Array.from(judgments.values()).sort((left, right) => left.path.localeCompare(right.path));
  if (output.length === 0) {
    throw new RetrievalQualityFixtureError(`${label} must include expected_paths[] or judgments[]`);
  }
  return output;
}

export function parseDatasetCases(rawDataset: RawDataset | undefined, label: string): RetrievalQualityCase[] {
  if (!rawDataset || !Array.isArray(rawDataset.cases)) {
    return [];
  }
  const cases = rawDataset.cases.map((entry, caseIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RetrievalQualityFixtureError(`Dataset "${label}" case[${caseIndex}] must be an object`);
    }
    const rawCase = entry as RawCase;
    if (typeof rawCase.id !== 'string' || rawCase.id.trim().length === 0) {
      throw new RetrievalQualityFixtureError(`Dataset "${label}" case[${caseIndex}].id must be a non-empty string`);
    }
    if (typeof rawCase.query !== 'string' || rawCase.query.trim().length === 0) {
      throw new RetrievalQualityFixtureError(
        `Dataset "${label}" case[${caseIndex}].query must be a non-empty string`
      );
    }
    return {
      id: rawCase.id.trim(),
      query: rawCase.query.trim(),
      judgments: toJudgments(rawCase, label, caseIndex),
    } satisfies RetrievalQualityCase;
  });

  const duplicateIds = cases
    .map((entry) => entry.id)
    .filter((entry, index, source) => source.indexOf(entry) !== index);
  if (duplicateIds.length > 0) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" contains duplicate case ids: ${duplicateIds.join(', ')}`);
  }
  return cases;
}

export function parseDataset(rawDataset: unknown, label: string): RetrievalQualityDataset {
  if (!rawDataset || typeof rawDataset !== 'object' || Array.isArray(rawDataset)) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" must be an object`);
  }
  const dataset = rawDataset as RawDataset;
  const cases = parseDatasetCases(dataset, label);
  let queries: string[] | undefined;
  if (dataset.queries !== undefined) {
    queries = parseQueries(dataset.queries, label);
  } else if (cases.length > 0) {
    queries = cases.map((entry) => entry.query);
  }

  return {
    description: typeof dataset.description === 'string' ? dataset.description : undefined,
    queries,
    cases: cases.length > 0 ? cases : undefined,
  };
}

export function getHoldoutConfig(parsed: RetrievalQualityFixturePack): RetrievalQualityHoldout {
  const holdout = parsed.holdout;
  if (!holdout || typeof holdout !== 'object' || Array.isArray(holdout)) {
    throw new Error('Fixture pack missing holdout object');
  }
  return holdout;
}

export function getDatasetMap(holdout: RetrievalQualityHoldout): Record<string, RetrievalQualityDataset> {
  const rawDatasets = holdout.datasets;
  if (!rawDatasets || typeof rawDatasets !== 'object' || Array.isArray(rawDatasets)) {
    throw new Error('Fixture holdout.datasets must be an object');
  }
  const datasets: Record<string, RetrievalQualityDataset> = {};
  for (const [datasetId, dataset] of Object.entries(rawDatasets)) {
    datasets[datasetId] = parseDataset(dataset, datasetId);
  }
  return datasets;
}

export function resolveSelectedDatasetId(
  holdout: RetrievalQualityHoldout,
  datasetId?: string
): string {
  if (datasetId && datasetId.trim().length > 0) {
    return datasetId.trim();
  }
  if (typeof holdout.default_dataset_id === 'string' && holdout.default_dataset_id.trim().length > 0) {
    return holdout.default_dataset_id.trim();
  }
  throw new Error('No holdout dataset id selected');
}

export function getDatasetQueries(dataset: RetrievalQualityDataset | undefined, label: string): string[] {
  if (!dataset) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" missing`);
  }
  const queries = dataset.queries ?? dataset.cases?.map((entry) => entry.query) ?? [];
  const usable = queries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (usable.length === 0) {
    throw new RetrievalQualityFixtureError(`Dataset "${label}" missing queries[]`);
  }
  return usable;
}

export function getDatasetCases(dataset: RetrievalQualityDataset | undefined, _label: string): RetrievalQualityCase[] {
  return dataset?.cases ? [...dataset.cases] : [];
}

export function computeDatasetHash(
  queries: string[],
  normalizationMode: string = SUPPORTED_NORMALIZATION
): string {
  return sha256Hex(JSON.stringify(queries.map((query) => normalizeQuery(query, normalizationMode))));
}

export function normalizeRetrievedPath(rawPath: string): string {
  return normalizeFixturePath(rawPath, 'retrieval result path');
}

export function countDatasetJudgments(cases: RetrievalQualityCase[]): number {
  return cases.reduce((sum, entry) => sum + entry.judgments.length, 0);
}
