import { createHash } from 'node:crypto';

export const MCP_EVAL_SMOKE_SCHEMA_VERSION = 2;
export const MCP_COMPATIBILITY_SCHEMA_VERSION = 1;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EvalSectionStatus = 'pass' | 'fail';

export interface NormalizedContextPackReceipt {
  fixture_id: string;
  pack_id: string;
  item_count: number;
  file_count: number;
  item_ids: string[];
  token_budget: {
    requested: number;
    used: number;
    truncated: boolean;
  };
  truncated: boolean;
  truncation_reasons?: string[];
}

export interface NormalizedRetrievalCaseReceipt {
  id: string;
  query_normalized: string;
  query_hash: string;
  judgment_paths: string[];
  judgment_hash: string;
}

export interface NormalizedRetrievalReceipt {
  source_fixture_pack: string;
  dataset_id: string;
  case_count: number;
  judgment_count: number;
  dataset_hash: string;
  cases: NormalizedRetrievalCaseReceipt[];
}

export interface NormalizedSafetyCaseReceipt {
  id: string;
  secrets_detected: boolean;
  detected_types: string[];
  expect_secrets: boolean;
  expect_types: string[];
  secrets_match: boolean;
  types_match: boolean;
  scrubbed_hash: string;
  status: EvalSectionStatus;
}

export interface NormalizedSafetyReceipt {
  case_count: number;
  passed_count: number;
  cases: NormalizedSafetyCaseReceipt[];
}

export interface NormalizedUsefulnessCaseReceipt {
  intent_hash: string;
  top_tool: string;
  top_one_match: boolean;
  matched_expected: boolean;
  selected_tools: string[];
  expected_tools: string[];
}

export interface NormalizedUsefulnessReceipt {
  source_fixture: string;
  case_count: number;
  top_one_rate: number;
  cases: NormalizedUsefulnessCaseReceipt[];
}

export interface NormalizedPerformanceCheck {
  id: string;
  metric: string;
  value: number;
  budget: number;
  comparator: 'min' | 'max';
  status: EvalSectionStatus;
}

export interface NormalizedPerformanceReceipt {
  check_count: number;
  passed_count: number;
  checks: NormalizedPerformanceCheck[];
}

export interface NormalizedToolManifestParityReceipt {
  runtime_count: number;
  manifest_count: number;
  missing_in_manifest: string[];
  extra_in_manifest: string[];
  status: EvalSectionStatus;
}

export interface NormalizedMcpEvalSmoke {
  schema_version: number;
  gate_mode: 'informational';
  retrieval: NormalizedRetrievalReceipt;
  context_packs: NormalizedContextPackReceipt[];
  safety: NormalizedSafetyReceipt;
  usefulness: NormalizedUsefulnessReceipt;
  performance: NormalizedPerformanceReceipt;
  summary: {
    status: EvalSectionStatus;
    checks_passed: number;
    checks_total: number;
  };
}

export interface NormalizedMcpCompatibility {
  schema_version: number;
  gate_mode: 'informational';
  eval_smoke: {
    fingerprint: string;
    status: EvalSectionStatus;
    sections: {
      retrieval: EvalSectionStatus;
      context_packs: EvalSectionStatus;
      safety: EvalSectionStatus;
      usefulness: EvalSectionStatus;
      performance: EvalSectionStatus;
    };
  };
  compatibility: {
    tool_manifest_parity: NormalizedToolManifestParityReceipt;
  };
  summary: {
    status: EvalSectionStatus;
    checks_passed: number;
    checks_total: number;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeForBaseline(value: unknown): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForBaseline(entry));
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  const normalized: Record<string, JsonValue> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (key === 'generated_at' || key === 'assembled_at' || key === 'processing_time') {
      continue;
    }
    normalized[key] = normalizeForBaseline(value[key]);
  }
  return normalized;
}

export function buildNormalizedFingerprint(normalized: NormalizedMcpEvalSmoke | NormalizedMcpCompatibility): string {
  return sha256Hex(stableStringify(normalizeForBaseline(normalized) as JsonValue));
}
