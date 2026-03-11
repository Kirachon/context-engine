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

type EvalStatus = 'pass' | 'fail' | 'skip';
type Comparator =
  | 'delta_pct_min'
  | 'threshold_max'
  | 'threshold_min'
  | 'json_path_threshold_max'
  | 'json_path_threshold_min';
type MissingStatus = 'skip' | 'fail';

interface CliArgs {
  fixturePackPath: string;
  outPath: string;
}

interface GateRules {
  min_pass_rate?: number;
  required_ids?: string[];
}

interface BaseCheck {
  id: string;
  kind: Comparator;
}

interface DeltaPctMinCheck extends BaseCheck {
  kind: 'delta_pct_min';
  baseline: number;
  candidate: number;
  min_delta_pct: number;
}

interface ThresholdMaxCheck extends BaseCheck {
  kind: 'threshold_max';
  value: number;
  max: number;
}

interface ThresholdMinCheck extends BaseCheck {
  kind: 'threshold_min';
  value: number;
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

interface FixturePack {
  schema_version?: number;
  generated_for?: string;
  checks?: MetricCheck[];
  gate_rules?: GateRules;
}

interface EvaluationResult {
  id: string;
  status: EvalStatus;
  value: number;
  message: string;
}

interface OutputArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    fixture_pack: string;
    out: string;
  };
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
  gate: {
    status: 'pass' | 'fail';
    reasons: string[];
  };
}

const DEFAULT_FIXTURE_PACK = path.join('config', 'ci', 'retrieval-quality-fixture-pack.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-quality-report.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-retrieval-quality-report.ts [options]

Options:
  --fixture-pack <path>      Fixture-pack JSON (default: ${DEFAULT_FIXTURE_PACK})
  --out <path>               Output report path (default: ${DEFAULT_OUT_PATH})
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

function readJsonFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
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
      return {
        id,
        kind,
        baseline: asFiniteNumber(obj.baseline, `${id}.baseline`),
        candidate: asFiniteNumber(obj.candidate, `${id}.candidate`),
        min_delta_pct: asFiniteNumber(obj.min_delta_pct, `${id}.min_delta_pct`),
      } satisfies DeltaPctMinCheck;
    }
    if (kind === 'threshold_max') {
      return {
        id,
        kind,
        value: asFiniteNumber(obj.value, `${id}.value`),
        max: asFiniteNumber(obj.max, `${id}.max`),
      } satisfies ThresholdMaxCheck;
    }
    if (kind === 'json_path_threshold_max') {
      if (typeof obj.path !== 'string' || obj.path.trim().length === 0) {
        throw new Error(`Invalid checks[${index}].path`);
      }
      if (typeof obj.json_path !== 'string' || obj.json_path.trim().length === 0) {
        throw new Error(`Invalid checks[${index}].json_path`);
      }
      return {
        id,
        kind,
        path: obj.path,
        json_path: obj.json_path,
        max: asFiniteNumber(obj.max, `${id}.max`),
        missing_status: obj.missing_status === 'fail' ? 'fail' : 'skip',
      } satisfies JsonPathThresholdMaxCheck;
    }
    if (kind === 'json_path_threshold_min') {
      if (typeof obj.path !== 'string' || obj.path.trim().length === 0) {
        throw new Error(`Invalid checks[${index}].path`);
      }
      if (typeof obj.json_path !== 'string' || obj.json_path.trim().length === 0) {
        throw new Error(`Invalid checks[${index}].json_path`);
      }
      return {
        id,
        kind,
        path: obj.path,
        json_path: obj.json_path,
        min: asFiniteNumber(obj.min, `${id}.min`),
        missing_status: obj.missing_status === 'fail' ? 'fail' : 'skip',
      } satisfies JsonPathThresholdMinCheck;
    }

    return {
      id,
      kind,
      value: asFiniteNumber(obj.value, `${id}.value`),
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

function evaluateCheck(check: MetricCheck): EvaluationResult {
  if (check.kind === 'delta_pct_min') {
    const baseline = check.baseline;
    if (baseline <= 0) {
      return {
        id: check.id,
        status: 'skip',
        value: 0,
        message: `SKIP ${check.id}: baseline must be > 0 for delta_pct_min`,
      };
    }
    const deltaPct = ((check.candidate - baseline) / baseline) * 100;
    const status: EvalStatus = deltaPct >= check.min_delta_pct ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value: deltaPct,
      message: `${status.toUpperCase()} ${check.id}: delta_pct=${deltaPct.toFixed(3)} min=${check.min_delta_pct}`,
    };
  }

  if (check.kind === 'threshold_max') {
    const status: EvalStatus = check.value <= check.max ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      value: check.value,
      message: `${status.toUpperCase()} ${check.id}: value=${check.value} max=${check.max}`,
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

  const status: EvalStatus = check.value >= check.min ? 'pass' : 'fail';
  return {
    id: check.id,
    status,
    value: check.value,
    message: `${status.toUpperCase()} ${check.id}: value=${check.value} min=${check.min}`,
  };
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const fixtureRaw = readJsonFile(args.fixturePackPath);
    const fixtureObj = asObject(fixtureRaw, 'Fixture pack must be a JSON object') as FixturePack;
    const checks = toMetricChecks(fixtureObj.checks);

    const evaluations = checks.map(evaluateCheck);
    const pass = evaluations.filter((item) => item.status === 'pass').length;
    const fail = evaluations.filter((item) => item.status === 'fail').length;
    const skip = evaluations.filter((item) => item.status === 'skip').length;
    const total = evaluations.length;
    const passRate = total > 0 ? pass / total : 0;

    const rules: OutputArtifact['gate_rules'] = {
      min_pass_rate: fixtureObj.gate_rules?.min_pass_rate ?? 1,
      required_ids: fixtureObj.gate_rules?.required_ids ?? [],
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

    const output: OutputArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        fixture_pack: path.resolve(args.fixturePackPath),
        out: path.resolve(args.outPath),
      },
      evaluations,
      summary: {
        total,
        pass,
        fail,
        skip,
        pass_rate: passRate,
      },
      gate_rules: rules,
      gate: {
        status: reasons.length === 0 ? 'pass' : 'fail',
        reasons,
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
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
