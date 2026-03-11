#!/usr/bin/env node
/**
 * Auggie parity report generator.
 *
 * Produces a metric-level parity report from a checked-in fixture pack so the
 * existing capability gate can score journeys/domains/overall parity.
 *
 * Exit codes:
 * - 0: report generated
 * - 2: usage/parsing/schema error
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type EvalStatus = 'pass' | 'fail' | 'skip';
type Comparator = 'lte' | 'lt' | 'gte' | 'gt';
type MissingStatus = 'skip' | 'fail';

interface CliArgs {
  fixturePackPath: string;
  matrixPath: string;
  retrievalParityPath?: string;
  outPath: string;
}

interface MatrixJourney {
  metric_refs: string[];
}

interface MatrixConfig {
  journeys?: MatrixJourney[];
}

interface RetrievalParityArtifact {
  evaluations?: Array<{ id?: string; status?: string }>;
}

interface FixturePack {
  schema_version?: number;
  generated_for?: string;
  pack_id?: string;
  defaults?: {
    retrieval_parity_path?: string;
    working_directory?: string;
  };
  checks?: MetricCheck[];
}

interface BaseMetricCheck {
  id: string;
  description?: string;
}

interface CommandExitZeroCheck extends BaseMetricCheck {
  kind: 'command_exit_zero';
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

interface FileExistsCheck extends BaseMetricCheck {
  kind: 'file_exists';
  path: string;
}

interface TextContainsCheck extends BaseMetricCheck {
  kind: 'text_contains';
  path: string;
  patterns: string[];
  mode?: 'all' | 'any';
  case_insensitive?: boolean;
}

interface JsonPathCompareCheck extends BaseMetricCheck {
  kind: 'json_path_compare';
  path: string;
  json_path: string;
  comparator: Comparator;
  threshold: number;
  missing_status?: MissingStatus;
}

interface RetrievalEvalStatusCheck extends BaseMetricCheck {
  kind: 'retrieval_eval_status';
  evaluation_id: string;
  pass_statuses?: EvalStatus[];
  missing_status?: MissingStatus;
}

type MetricCheck =
  | CommandExitZeroCheck
  | FileExistsCheck
  | TextContainsCheck
  | JsonPathCompareCheck
  | RetrievalEvalStatusCheck;

interface EvaluationResult {
  id: string;
  status: EvalStatus;
  message: string;
}

interface OutputArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    fixture_pack: string;
    matrix: string;
    retrieval_parity?: string;
    out: string;
  };
  evaluations: EvaluationResult[];
  metric_values: Record<string, { value?: number | string; note?: string }>;
  case_results: Array<{
    id: string;
    kind: MetricCheck['kind'];
    status: EvalStatus;
    message: string;
  }>;
  gate: {
    status: 'pass' | 'fail';
  };
}

const DEFAULT_FIXTURE_PACK = path.join('config', 'ci', 'auggie-parity-fixture-pack.json');
const DEFAULT_MATRIX_PATH = path.join('config', 'ci', 'auggie-capability-matrix.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'retrieval-parity-pr.json');

function printHelpAndExit(code: number): never {
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-auggie-parity-report.ts [options]

Options:
  --fixture-pack <path>      Fixture-pack JSON (default: ${DEFAULT_FIXTURE_PACK})
  --matrix <path>            Capability matrix JSON (default: ${DEFAULT_MATRIX_PATH})
  --retrieval-parity <path>  Retrieval parity artifact JSON (optional; overrides pack default)
  --out <path>               Output report path (default: ${DEFAULT_OUT_PATH})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturePackPath: DEFAULT_FIXTURE_PACK,
    matrixPath: DEFAULT_MATRIX_PATH,
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
    if (arg === '--matrix') {
      if (!next) throw new Error('Missing value for --matrix');
      args.matrixPath = next;
      i += 1;
      continue;
    }
    if (arg === '--retrieval-parity') {
      if (!next) throw new Error('Missing value for --retrieval-parity');
      args.retrievalParityPath = next;
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

function asObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function collectMatrixMetricIds(matrixRaw: unknown): string[] {
  const matrix = asObject(matrixRaw, 'Matrix must be a JSON object') as MatrixConfig;
  if (!Array.isArray(matrix.journeys)) {
    throw new Error('Matrix missing journeys[]');
  }
  const ids: string[] = [];
  for (const journey of matrix.journeys) {
    if (!journey || typeof journey !== 'object' || !Array.isArray(journey.metric_refs)) {
      throw new Error('Each journey must include metric_refs[]');
    }
    for (const metricRefRaw of journey.metric_refs) {
      if (typeof metricRefRaw !== 'string') {
        throw new Error('Matrix metric_refs entries must be strings');
      }
      ids.push(metricRefRaw.replace(/^optional:/, ''));
    }
  }
  return [...new Set(ids)];
}

function normalizeFixturePack(fixtureRaw: unknown): FixturePack {
  const fixture = asObject(fixtureRaw, 'Fixture pack must be a JSON object');
  const checks = fixture.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('Fixture pack missing checks[]');
  }
  return fixture as unknown as FixturePack;
}

function validateChecks(checks: MetricCheck[], allowedMetricIds: Set<string>): Map<string, MetricCheck> {
  const out = new Map<string, MetricCheck>();
  for (const rawCheck of checks) {
    if (!rawCheck || typeof rawCheck !== 'object') {
      throw new Error('Fixture pack checks[] entries must be objects');
    }
    if (typeof rawCheck.id !== 'string' || rawCheck.id.trim().length === 0) {
      throw new Error('Each fixture check requires a non-empty id');
    }
    if (!allowedMetricIds.has(rawCheck.id)) {
      throw new Error(`Fixture check references unknown metric id: ${rawCheck.id}`);
    }
    if (out.has(rawCheck.id)) {
      throw new Error(`Duplicate fixture check id: ${rawCheck.id}`);
    }
    out.set(rawCheck.id, rawCheck);
  }

  const missing = [...allowedMetricIds].filter((id) => !out.has(id));
  if (missing.length > 0) {
    throw new Error(`Fixture pack missing metric ids: ${missing.join(', ')}`);
  }
  return out;
}

function getByPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValue(value: number, comparator: Comparator, threshold: number): boolean {
  if (comparator === 'lte') return value <= threshold;
  if (comparator === 'lt') return value < threshold;
  if (comparator === 'gte') return value >= threshold;
  return value > threshold;
}

function resolveFixturePath(rawPath: string, cwd: string, retrievalParityPath?: string): string {
  if (rawPath === '@retrieval_parity') {
    if (!retrievalParityPath) {
      throw new Error('Fixture requires retrieval parity artifact but none was provided');
    }
    return path.resolve(retrievalParityPath);
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const workspaceCwd = process.cwd();
    const fixture = normalizeFixturePack(readJsonFile(args.fixturePackPath));
    const matrixMetricIds = collectMatrixMetricIds(readJsonFile(args.matrixPath));
    const checks = validateChecks(fixture.checks ?? [], new Set(matrixMetricIds));

    const defaultWorkingDir = fixture.defaults?.working_directory
      ? path.resolve(workspaceCwd, fixture.defaults.working_directory)
      : workspaceCwd;
    const retrievalParityPath =
      args.retrievalParityPath ??
      (fixture.defaults?.retrieval_parity_path
        ? path.resolve(workspaceCwd, fixture.defaults.retrieval_parity_path)
        : undefined);

    const commandCache = new Map<string, { status: number | null; stdout: string; stderr: string; error?: string }>();
    const fileTextCache = new Map<string, string>();
    const jsonCache = new Map<string, unknown>();
    let retrievalEvaluationCache: Map<string, EvalStatus> | undefined;

    function readTextFile(filePath: string): string {
      const resolved = path.resolve(filePath);
      if (!fileTextCache.has(resolved)) {
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${resolved}`);
        }
        fileTextCache.set(resolved, fs.readFileSync(resolved, 'utf8'));
      }
      return fileTextCache.get(resolved)!;
    }

    function readCachedJson(filePath: string): unknown {
      const resolved = path.resolve(filePath);
      if (!jsonCache.has(resolved)) {
        jsonCache.set(resolved, readJsonFile(resolved));
      }
      return jsonCache.get(resolved);
    }

    function getRetrievalEvaluations(): Map<string, EvalStatus> {
      if (retrievalEvaluationCache) {
        return retrievalEvaluationCache;
      }
      if (!retrievalParityPath) {
        throw new Error('No retrieval parity artifact configured');
      }
      const artifact = asObject(
        readCachedJson(retrievalParityPath),
        'Retrieval parity artifact must be a JSON object'
      ) as RetrievalParityArtifact;
      const out = new Map<string, EvalStatus>();
      for (const evaluation of artifact.evaluations ?? []) {
        if (
          evaluation &&
          typeof evaluation.id === 'string' &&
          (evaluation.status === 'pass' || evaluation.status === 'fail' || evaluation.status === 'skip')
        ) {
          out.set(evaluation.id, evaluation.status);
        }
      }
      retrievalEvaluationCache = out;
      return out;
    }

    function evaluateCheck(check: MetricCheck): { status: EvalStatus; message: string; value?: number | string; note?: string } {
      if (check.kind === 'command_exit_zero') {
        const cwd = check.cwd ? path.resolve(defaultWorkingDir, check.cwd) : defaultWorkingDir;
        const cacheKey = JSON.stringify({ command: check.command, cwd, timeout_ms: check.timeout_ms ?? 300000 });
        if (!commandCache.has(cacheKey)) {
          const result = spawnSync(check.command, {
            cwd,
            encoding: 'utf8',
            shell: true,
            timeout: check.timeout_ms ?? 300000,
          });
          commandCache.set(cacheKey, {
            status: result.status,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error?.message,
          });
        }
        const result = commandCache.get(cacheKey)!;
        const ok = result.status === 0;
        return {
          status: ok ? 'pass' : 'fail',
          message: ok
            ? `PASS ${check.id}: command exited with status 0`
            : `FAIL ${check.id}: command exited with status ${result.status ?? 'null'}${result.error ? ` (${result.error})` : ''}`,
          note: ok ? undefined : result.stderr || result.stdout || result.error,
        };
      }

      if (check.kind === 'file_exists') {
        const resolvedPath = resolveFixturePath(check.path, defaultWorkingDir, retrievalParityPath);
        const exists = fs.existsSync(resolvedPath);
        return {
          status: exists ? 'pass' : 'fail',
          message: exists ? `PASS ${check.id}: file exists at ${resolvedPath}` : `FAIL ${check.id}: file missing at ${resolvedPath}`,
          note: resolvedPath,
        };
      }

      if (check.kind === 'text_contains') {
        const resolvedPath = resolveFixturePath(check.path, defaultWorkingDir, retrievalParityPath);
        const contents = readTextFile(resolvedPath);
        const found = check.patterns.map((pattern) => {
          const haystack = check.case_insensitive ? contents.toLowerCase() : contents;
          const needle = check.case_insensitive ? pattern.toLowerCase() : pattern;
          return haystack.includes(needle);
        });
        const mode = check.mode ?? 'all';
        const ok = mode === 'any' ? found.some(Boolean) : found.every(Boolean);
        return {
          status: ok ? 'pass' : 'fail',
          message: ok
            ? `PASS ${check.id}: ${mode} required text patterns found`
            : `FAIL ${check.id}: ${mode} required text patterns not found`,
          note: resolvedPath,
        };
      }

      if (check.kind === 'json_path_compare') {
        const resolvedPath = resolveFixturePath(check.path, defaultWorkingDir, retrievalParityPath);
        const rawValue = getByPath(readCachedJson(resolvedPath), check.json_path);
        if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
          const status: EvalStatus = (check.missing_status ?? 'skip') === 'fail' ? 'fail' : 'skip';
          return {
            status,
            message:
              status === 'fail'
                ? `FAIL ${check.id}: numeric value missing at ${check.json_path}`
                : `SKIP ${check.id}: numeric value missing at ${check.json_path}`,
            note: resolvedPath,
          };
        }
        const ok = compareValue(rawValue, check.comparator, check.threshold);
        return {
          status: ok ? 'pass' : 'fail',
          message: `${ok ? 'PASS' : 'FAIL'} ${check.id}: value=${rawValue} ${check.comparator} ${check.threshold}`,
          value: rawValue,
          note: `${resolvedPath}#${check.json_path}`,
        };
      }

      const retrievalStatus = getRetrievalEvaluations().get(check.evaluation_id);
      if (!retrievalStatus) {
        const status: EvalStatus = (check.missing_status ?? 'skip') === 'fail' ? 'fail' : 'skip';
        return {
          status,
          message:
            status === 'fail'
              ? `FAIL ${check.id}: retrieval metric ${check.evaluation_id} missing`
              : `SKIP ${check.id}: retrieval metric ${check.evaluation_id} missing`,
          note: check.evaluation_id,
        };
      }
      const passStatuses = check.pass_statuses ?? ['pass'];
      const ok = passStatuses.includes(retrievalStatus);
      return {
        status: ok ? 'pass' : retrievalStatus,
        message: `${ok ? 'PASS' : retrievalStatus.toUpperCase()} ${check.id}: retrieval metric ${check.evaluation_id} returned ${retrievalStatus}`,
        note: check.evaluation_id,
      };
    }

    const evaluations: EvaluationResult[] = [];
    const caseResults: OutputArtifact['case_results'] = [];
    const metricValues: OutputArtifact['metric_values'] = {};

    for (const metricId of matrixMetricIds) {
      const check = checks.get(metricId)!;
      const result = evaluateCheck(check);
      evaluations.push({
        id: metricId,
        status: result.status,
        message: result.message,
      });
      caseResults.push({
        id: metricId,
        kind: check.kind,
        status: result.status,
        message: result.message,
      });
      metricValues[metricId] = {
        value: result.value,
        note: result.note ?? check.description,
      };
    }

    const outputArtifact: OutputArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        fixture_pack: path.resolve(args.fixturePackPath),
        matrix: path.resolve(args.matrixPath),
        retrieval_parity: retrievalParityPath ? path.resolve(retrievalParityPath) : undefined,
        out: path.resolve(args.outPath),
      },
      evaluations,
      metric_values: metricValues,
      case_results: caseResults,
      gate: {
        status: evaluations.some((item) => item.status === 'fail') ? 'fail' : 'pass',
      },
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(outputArtifact, null, 2), 'utf8');

    console.log(`out=${outPath}`);
    console.log(`gate_status=${outputArtifact.gate.status}`);
    console.log(`evaluations=${evaluations.length}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
