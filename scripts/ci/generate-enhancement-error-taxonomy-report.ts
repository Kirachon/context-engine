#!/usr/bin/env node
/**
 * Generate enhancement error taxonomy artifact for release checklist gating.
 *
 * Exit codes:
 * - 0: report generated
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type CanonicalErrorCode = 'TRANSIENT_UPSTREAM' | 'AUTH_CONFIG' | 'QUOTA' | 'UNKNOWN';
type Status = 'PASS' | 'FAIL' | 'SKIP';
type ThresholdResult = 'PASS' | 'FAIL';
type WindowState = 'HAS_EVENTS' | 'ZERO_EVENTS';

interface CliArgs {
  eventsPath: string;
  startUtc: string;
  endUtcExclusive: string;
  maxTransientUpstream: number;
  maxAuthConfig: number;
  maxQuota: number;
  maxUnknown: number;
  maxMalformed: number;
  skipPolicy: boolean;
  outPath: string;
}

interface RawEvent {
  timestamp_utc?: unknown;
  error_code?: unknown;
}

interface OutputArtifact {
  schema_version: '1.0';
  status: Status;
  reporting_window: {
    start_utc: string;
    end_utc_exclusive: string;
  };
  summary: {
    total_events: number;
    processed_events: number;
    malformed_event_count: number;
    window_state: WindowState;
    threshold_result: ThresholdResult;
  };
  counts_by_error_code: Record<CanonicalErrorCode, number>;
  unknown_code_count: number;
  thresholds: {
    max_transient_upstream: number;
    max_auth_config: number;
    max_quota: number;
    max_unknown: number;
    max_malformed: number;
  };
  violations: Array<{
    id: string;
    message: string;
  }>;
}

const DEFAULT_EVENTS_PATH = path.join('artifacts', 'bench', 'enhancement-error-events.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'enhancement-error-taxonomy-report.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-enhancement-error-taxonomy-report.ts [options]

Options:
  --events <path>                   Events JSON path (default: ${DEFAULT_EVENTS_PATH})
  --start-utc <iso>                 Reporting window start UTC (inclusive)
  --end-utc-exclusive <iso>         Reporting window end UTC (exclusive)
  --max-transient-upstream <n>      Threshold for TRANSIENT_UPSTREAM
  --max-auth-config <n>             Threshold for AUTH_CONFIG
  --max-quota <n>                   Threshold for QUOTA
  --max-unknown <n>                 Threshold for UNKNOWN
  --max-malformed <n>               Threshold for malformed event count
  --skip-policy                     Emit status=SKIP (explicit policy flag)
  --out <path>                      Output report path (default: ${DEFAULT_OUT_PATH})
`);
  process.exit(code);
}

function parseNonNegativeInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid non-negative integer for ${field}: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    eventsPath: DEFAULT_EVENTS_PATH,
    startUtc: '',
    endUtcExclusive: '',
    maxTransientUpstream: -1,
    maxAuthConfig: -1,
    maxQuota: -1,
    maxUnknown: -1,
    maxMalformed: -1,
    skipPolicy: false,
    outPath: DEFAULT_OUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--events') {
      if (!next) throw new Error('Missing value for --events');
      args.eventsPath = next;
      i += 1;
      continue;
    }
    if (arg === '--start-utc') {
      if (!next) throw new Error('Missing value for --start-utc');
      args.startUtc = next;
      i += 1;
      continue;
    }
    if (arg === '--end-utc-exclusive') {
      if (!next) throw new Error('Missing value for --end-utc-exclusive');
      args.endUtcExclusive = next;
      i += 1;
      continue;
    }
    if (arg === '--max-transient-upstream') {
      if (!next) throw new Error('Missing value for --max-transient-upstream');
      args.maxTransientUpstream = parseNonNegativeInteger(next, '--max-transient-upstream');
      i += 1;
      continue;
    }
    if (arg === '--max-auth-config') {
      if (!next) throw new Error('Missing value for --max-auth-config');
      args.maxAuthConfig = parseNonNegativeInteger(next, '--max-auth-config');
      i += 1;
      continue;
    }
    if (arg === '--max-quota') {
      if (!next) throw new Error('Missing value for --max-quota');
      args.maxQuota = parseNonNegativeInteger(next, '--max-quota');
      i += 1;
      continue;
    }
    if (arg === '--max-unknown') {
      if (!next) throw new Error('Missing value for --max-unknown');
      args.maxUnknown = parseNonNegativeInteger(next, '--max-unknown');
      i += 1;
      continue;
    }
    if (arg === '--max-malformed') {
      if (!next) throw new Error('Missing value for --max-malformed');
      args.maxMalformed = parseNonNegativeInteger(next, '--max-malformed');
      i += 1;
      continue;
    }
    if (arg === '--skip-policy') {
      args.skipPolicy = true;
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

  if (!args.startUtc) throw new Error('--start-utc is required');
  if (!args.endUtcExclusive) throw new Error('--end-utc-exclusive is required');

  const missingThresholds: string[] = [];
  if (args.maxTransientUpstream < 0) missingThresholds.push('--max-transient-upstream');
  if (args.maxAuthConfig < 0) missingThresholds.push('--max-auth-config');
  if (args.maxQuota < 0) missingThresholds.push('--max-quota');
  if (args.maxUnknown < 0) missingThresholds.push('--max-unknown');
  if (args.maxMalformed < 0) missingThresholds.push('--max-malformed');
  if (missingThresholds.length > 0) {
    throw new Error(`Missing required threshold option(s): ${missingThresholds.join(', ')}`);
  }

  return args;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readEvents(eventsPath: string): RawEvent[] {
  const resolved = path.resolve(eventsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Events file not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as RawEvent[];
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).events)) {
    return (parsed as { events: RawEvent[] }).events;
  }
  throw new Error('Events payload must be an array or object with events[]');
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

function mapErrorCode(rawCode: unknown): CanonicalErrorCode {
  if (typeof rawCode !== 'string') return 'UNKNOWN';
  const normalized = rawCode.trim();
  if (normalized === 'TRANSIENT_UPSTREAM') return 'TRANSIENT_UPSTREAM';
  if (normalized === 'AUTH' || normalized === 'CONFIG') return 'AUTH_CONFIG';
  if (normalized === 'QUOTA') return 'QUOTA';
  return 'UNKNOWN';
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const events = readEvents(args.eventsPath);

    const counts: Record<CanonicalErrorCode, number> = {
      TRANSIENT_UPSTREAM: 0,
      AUTH_CONFIG: 0,
      QUOTA: 0,
      UNKNOWN: 0,
    };

    const violations: OutputArtifact['violations'] = [];
    const startMs = parseUtcTimestamp(args.startUtc);
    const endMs = parseUtcTimestamp(args.endUtcExclusive);

    let totalEvents = 0;
    let processedEvents = 0;
    let malformedEventCount = 0;

    if (startMs == null || endMs == null || startMs >= endMs) {
      violations.push({
        id: 'window.invalid',
        message: 'Invalid reporting window: require parseable UTC timestamps with start_utc < end_utc_exclusive.',
      });
    }

    for (const rawEvent of events) {
      if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
        totalEvents += 1;
        malformedEventCount += 1;
        continue;
      }

      const timestampMs = parseUtcTimestamp(rawEvent.timestamp_utc);
      const hasMissingErrorCode =
        typeof rawEvent.error_code !== 'string' || rawEvent.error_code.trim().length === 0;
      const mappedCode = mapErrorCode(rawEvent.error_code);

      if (timestampMs == null) {
        totalEvents += 1;
        malformedEventCount += 1;
        continue;
      }

      if (startMs == null || endMs == null || timestampMs < startMs || timestampMs >= endMs) {
        continue;
      }

      totalEvents += 1;
      processedEvents += 1;
      if (hasMissingErrorCode) {
        malformedEventCount += 1;
      }
      counts[mappedCode] += 1;
    }

    const thresholds = {
      max_transient_upstream: args.maxTransientUpstream,
      max_auth_config: args.maxAuthConfig,
      max_quota: args.maxQuota,
      max_unknown: args.maxUnknown,
      max_malformed: args.maxMalformed,
    };

    if (counts.TRANSIENT_UPSTREAM > thresholds.max_transient_upstream) {
      violations.push({
        id: 'threshold.transient_upstream',
        message:
          `counts_by_error_code.TRANSIENT_UPSTREAM=${counts.TRANSIENT_UPSTREAM} exceeds max_transient_upstream=` +
          `${thresholds.max_transient_upstream}`,
      });
    }
    if (counts.AUTH_CONFIG > thresholds.max_auth_config) {
      violations.push({
        id: 'threshold.auth_config',
        message:
          `counts_by_error_code.AUTH_CONFIG=${counts.AUTH_CONFIG} exceeds max_auth_config=` +
          `${thresholds.max_auth_config}`,
      });
    }
    if (counts.QUOTA > thresholds.max_quota) {
      violations.push({
        id: 'threshold.quota',
        message: `counts_by_error_code.QUOTA=${counts.QUOTA} exceeds max_quota=${thresholds.max_quota}`,
      });
    }
    if (counts.UNKNOWN > thresholds.max_unknown) {
      violations.push({
        id: 'threshold.unknown',
        message: `unknown_code_count=${counts.UNKNOWN} exceeds max_unknown=${thresholds.max_unknown}`,
      });
    }
    if (malformedEventCount > thresholds.max_malformed) {
      violations.push({
        id: 'threshold.malformed',
        message:
          `summary.malformed_event_count=${malformedEventCount} exceeds max_malformed=${thresholds.max_malformed}`,
      });
    }

    const thresholdResult: ThresholdResult =
      violations.some((item) => item.id.startsWith('threshold.')) ? 'FAIL' : 'PASS';
    const baseStatus: Status = violations.length > 0 ? 'FAIL' : 'PASS';
    const status: Status = args.skipPolicy ? 'SKIP' : baseStatus;

    const output: OutputArtifact = {
      schema_version: '1.0',
      status,
      reporting_window: {
        start_utc: args.startUtc,
        end_utc_exclusive: args.endUtcExclusive,
      },
      summary: {
        total_events: totalEvents,
        processed_events: processedEvents,
        malformed_event_count: malformedEventCount,
        window_state: totalEvents === 0 ? 'ZERO_EVENTS' : 'HAS_EVENTS',
        threshold_result: thresholdResult,
      },
      counts_by_error_code: counts,
      unknown_code_count: counts.UNKNOWN,
      thresholds,
      violations,
    };

    const outPath = path.resolve(args.outPath);
    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`enhancement_error_taxonomy_report generated: ${outPath} status=${output.status}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
