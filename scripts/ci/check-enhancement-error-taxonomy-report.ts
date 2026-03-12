#!/usr/bin/env node
/**
 * Deterministic checker for enhancement error taxonomy report artifacts.
 *
 * Exit codes:
 * - 0: report is valid
 * - 1: report is invalid
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type Status = 'PASS' | 'FAIL' | 'SKIP';
type WindowState = 'HAS_EVENTS' | 'ZERO_EVENTS';
type ThresholdResult = 'PASS' | 'FAIL';
type CanonicalErrorCode = 'TRANSIENT_UPSTREAM' | 'AUTH_CONFIG' | 'QUOTA' | 'UNKNOWN';

interface CliArgs {
  reportPath: string;
  allowSkip: boolean;
}

interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

interface ReportArtifact {
  schema_version?: unknown;
  status?: unknown;
  reporting_window?: unknown;
  summary?: unknown;
  counts_by_error_code?: unknown;
  unknown_code_count?: unknown;
  thresholds?: unknown;
  violations?: unknown;
}

const DEFAULT_REPORT_PATH = path.join('artifacts', 'bench', 'enhancement-error-taxonomy-report.json');
const CANONICAL_KEYS: CanonicalErrorCode[] = ['TRANSIENT_UPSTREAM', 'AUTH_CONFIG', 'QUOTA', 'UNKNOWN'];

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-enhancement-error-taxonomy-report.ts [options]

Options:
  --report <path>      Report path (default: ${DEFAULT_REPORT_PATH})
  --allow-skip         Allow status=SKIP
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reportPath: DEFAULT_REPORT_PATH,
    allowSkip: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--report') {
      if (!next) throw new Error('Missing value for --report');
      args.reportPath = next;
      i += 1;
      continue;
    }
    if (arg === '--allow-skip') {
      args.allowSkip = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function parseUtcTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.includes('T') || !trimmed.endsWith('Z')) {
    return null;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function readReport(filePath: string): ReportArtifact {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  const obj = asObject(parsed);
  if (!obj) {
    throw new Error('Report must be a JSON object');
  }
  return obj as ReportArtifact;
}

function evaluate(report: ReportArtifact, allowSkip: boolean): CheckResult[] {
  const checks: CheckResult[] = [];

  const schemaVersionOk = report.schema_version === '1.0';
  checks.push({
    id: 'schema_version',
    ok: schemaVersionOk,
    detail: schemaVersionOk ? 'schema_version is 1.0.' : 'schema_version must equal "1.0".',
  });

  const status = report.status;
  const statusOk = status === 'PASS' || status === 'FAIL' || status === 'SKIP';
  checks.push({
    id: 'status_enum',
    ok: statusOk,
    detail: statusOk ? `status=${status}` : 'status must be one of PASS|FAIL|SKIP.',
  });
  checks.push({
    id: 'status_skip_policy',
    ok: status !== 'SKIP' || allowSkip,
    detail: status !== 'SKIP' || allowSkip ? 'skip policy satisfied.' : 'status=SKIP requires --allow-skip.',
  });

  const reportingWindow = asObject(report.reporting_window);
  const startUtc = reportingWindow?.start_utc;
  const endUtcExclusive = reportingWindow?.end_utc_exclusive;
  const startMs = parseUtcTimestamp(startUtc);
  const endMs = parseUtcTimestamp(endUtcExclusive);
  const windowValid = startMs != null && endMs != null && startMs < endMs;
  checks.push({
    id: 'reporting_window',
    ok: windowValid,
    detail: windowValid
      ? 'reporting window timestamps are valid and ordered.'
      : 'reporting_window.start_utc and end_utc_exclusive must be parseable UTC and start < end.',
  });

  const summary = asObject(report.summary);
  const totalEvents = asNonNegativeInteger(summary?.total_events);
  const processedEvents = asNonNegativeInteger(summary?.processed_events);
  const malformedEvents = asNonNegativeInteger(summary?.malformed_event_count);
  const windowState = summary?.window_state;
  const thresholdResult = summary?.threshold_result;

  checks.push({
    id: 'summary_fields',
    ok: totalEvents != null && processedEvents != null && malformedEvents != null,
    detail:
      totalEvents != null && processedEvents != null && malformedEvents != null
        ? 'summary numeric fields are non-negative integers.'
        : 'summary.total_events, processed_events, malformed_event_count must be non-negative integers.',
  });

  checks.push({
    id: 'summary_relations',
    ok: totalEvents != null && processedEvents != null && totalEvents >= processedEvents,
    detail:
      totalEvents != null && processedEvents != null && totalEvents >= processedEvents
        ? 'summary.total_events >= summary.processed_events.'
        : 'summary.total_events must be >= summary.processed_events.',
  });

  const windowStateOk =
    (windowState === 'ZERO_EVENTS' && totalEvents === 0) ||
    (windowState === 'HAS_EVENTS' && totalEvents != null && totalEvents > 0);
  checks.push({
    id: 'summary_window_state',
    ok: windowStateOk,
    detail: windowStateOk
      ? `summary.window_state=${String(windowState)} is consistent with total_events.`
      : 'summary.window_state must be ZERO_EVENTS only when total_events=0, otherwise HAS_EVENTS.',
  });

  const thresholdResultOk = thresholdResult === 'PASS' || thresholdResult === 'FAIL';
  checks.push({
    id: 'summary_threshold_result_enum',
    ok: thresholdResultOk,
    detail: thresholdResultOk
      ? `summary.threshold_result=${String(thresholdResult)}`
      : 'summary.threshold_result must be PASS|FAIL.',
  });

  const counts = asObject(report.counts_by_error_code);
  const countValues = counts
    ? {
        TRANSIENT_UPSTREAM: asNonNegativeInteger(counts.TRANSIENT_UPSTREAM),
        AUTH_CONFIG: asNonNegativeInteger(counts.AUTH_CONFIG),
        QUOTA: asNonNegativeInteger(counts.QUOTA),
        UNKNOWN: asNonNegativeInteger(counts.UNKNOWN),
      }
    : null;

  const keys = counts ? Object.keys(counts).sort() : [];
  const expectedKeys = [...CANONICAL_KEYS].sort();
  const keysExact = JSON.stringify(keys) === JSON.stringify(expectedKeys);
  checks.push({
    id: 'counts_keys',
    ok: keysExact,
    detail: keysExact
      ? 'counts_by_error_code has exactly canonical keys.'
      : `counts_by_error_code must contain exactly ${expectedKeys.join(', ')}.`,
  });

  const countValuesOk =
    countValues != null &&
    CANONICAL_KEYS.every((key) => countValues[key] != null && (countValues[key] as number) >= 0);
  checks.push({
    id: 'counts_values',
    ok: countValuesOk,
    detail: countValuesOk
      ? 'counts_by_error_code values are non-negative integers.'
      : 'counts_by_error_code values must be non-negative integers.',
  });

  const unknownCodeCount = asNonNegativeInteger(report.unknown_code_count);
  checks.push({
    id: 'unknown_code_count_field',
    ok: unknownCodeCount != null,
    detail:
      unknownCodeCount != null
        ? 'unknown_code_count is a non-negative integer.'
        : 'unknown_code_count must be a non-negative integer.',
  });
  checks.push({
    id: 'unknown_code_count_match',
    ok: unknownCodeCount != null && countValues?.UNKNOWN != null && unknownCodeCount === countValues.UNKNOWN,
    detail:
      unknownCodeCount != null && countValues?.UNKNOWN != null && unknownCodeCount === countValues.UNKNOWN
        ? 'unknown_code_count matches counts_by_error_code.UNKNOWN.'
        : 'unknown_code_count must equal counts_by_error_code.UNKNOWN.',
  });

  checks.push({
    id: 'processed_count_match',
    ok:
      processedEvents != null &&
      countValues != null &&
      processedEvents ===
        (countValues.TRANSIENT_UPSTREAM ?? 0) +
          (countValues.AUTH_CONFIG ?? 0) +
          (countValues.QUOTA ?? 0) +
          (countValues.UNKNOWN ?? 0),
    detail:
      processedEvents != null && countValues != null
        ? 'processed_events equals sum(counts_by_error_code).'
        : 'processed_events must equal sum(counts_by_error_code).',
  });

  const thresholds = asObject(report.thresholds);
  const maxTransientUpstream = asNonNegativeNumber(thresholds?.max_transient_upstream);
  const maxAuthConfig = asNonNegativeNumber(thresholds?.max_auth_config);
  const maxQuota = asNonNegativeNumber(thresholds?.max_quota);
  const maxUnknown = asNonNegativeNumber(thresholds?.max_unknown);
  const maxMalformed = asNonNegativeNumber(thresholds?.max_malformed);
  const thresholdsOk =
    maxTransientUpstream != null &&
    maxAuthConfig != null &&
    maxQuota != null &&
    maxUnknown != null &&
    maxMalformed != null;
  checks.push({
    id: 'threshold_fields',
    ok: thresholdsOk,
    detail: thresholdsOk
      ? 'thresholds fields are present and non-negative numbers.'
      : 'thresholds must include all max_* fields as non-negative numbers.',
  });

  const thresholdBreaches =
    countValues != null && malformedEvents != null && thresholdsOk
      ? {
          transient: countValues.TRANSIENT_UPSTREAM! > maxTransientUpstream!,
          authConfig: countValues.AUTH_CONFIG! > maxAuthConfig!,
          quota: countValues.QUOTA! > maxQuota!,
          unknown: countValues.UNKNOWN! > maxUnknown!,
          malformed: malformedEvents > maxMalformed!,
        }
      : null;

  const expectedThresholdResult: ThresholdResult | null = thresholdBreaches
    ? thresholdBreaches.transient ||
      thresholdBreaches.authConfig ||
      thresholdBreaches.quota ||
      thresholdBreaches.unknown ||
      thresholdBreaches.malformed
      ? 'FAIL'
      : 'PASS'
    : null;

  checks.push({
    id: 'threshold_semantics',
    ok: expectedThresholdResult != null && thresholdResult === expectedThresholdResult,
    detail:
      expectedThresholdResult != null && thresholdResult === expectedThresholdResult
        ? `summary.threshold_result matches computed threshold result (${expectedThresholdResult}).`
        : 'summary.threshold_result does not match computed threshold result from counts/thresholds.',
  });

  const violations = Array.isArray(report.violations) ? report.violations : null;
  const violationsShapeOk =
    violations != null &&
    violations.every((item) => {
      const obj = asObject(item);
      return !!obj && typeof obj.id === 'string' && obj.id.trim().length > 0 && typeof obj.message === 'string';
    });
  checks.push({
    id: 'violations_shape',
    ok: violationsShapeOk,
    detail: violationsShapeOk
      ? 'violations[] entries include id/message strings.'
      : 'violations must be an array of { id: string, message: string }.',
  });

  const thresholdViolationCount =
    violations?.filter((item) => {
      const obj = asObject(item);
      return !!obj && typeof obj.id === 'string' && obj.id.startsWith('threshold.');
    }).length ?? 0;
  checks.push({
    id: 'violations_threshold_consistency',
    ok:
      expectedThresholdResult == null ||
      (expectedThresholdResult === 'FAIL' ? thresholdViolationCount > 0 : thresholdViolationCount === 0),
    detail:
      expectedThresholdResult == null
        ? 'threshold consistency skipped due to prior parse errors.'
        : expectedThresholdResult === 'FAIL'
        ? 'threshold failures have threshold.* violations.'
        : 'no threshold.* violations when threshold_result=PASS.',
  });

  const structuralViolationCount = checks.filter((item) => !item.ok).length;
  const expectedStatus: Status | null =
    expectedThresholdResult == null
      ? null
      : structuralViolationCount > 0 || expectedThresholdResult === 'FAIL'
      ? 'FAIL'
      : 'PASS';

  checks.push({
    id: 'final_status_semantics',
    ok: expectedStatus != null && (status === expectedStatus || (status === 'SKIP' && allowSkip)),
    detail:
      expectedStatus != null && (status === expectedStatus || (status === 'SKIP' && allowSkip))
        ? `status is consistent (${String(status)}).`
        : 'status must be FAIL on structural/threshold violations, PASS otherwise (or SKIP only with allow-skip).',
  });

  return checks;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = readReport(args.reportPath);
    const checks = evaluate(report, args.allowSkip);
    const failures = checks.filter((item) => !item.ok);

    // eslint-disable-next-line no-console
    console.log(`Enhancement taxonomy check: ${path.resolve(args.reportPath)}`);
    for (const check of checks) {
      // eslint-disable-next-line no-console
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`);
    }
    // eslint-disable-next-line no-console
    console.log(`summary: checks=${checks.length} failed=${failures.length}`);

    return failures.length === 0 ? 0 : 1;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
