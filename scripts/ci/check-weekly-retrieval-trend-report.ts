#!/usr/bin/env node
/**
 * Validate weekly retrieval trend artifact contract and archive uniqueness.
 *
 * Exit codes:
 * - 0: check passed
 * - 1: check failed
 * - 2: usage/parsing error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface CliArgs {
  artifactPath: string;
  archiveDir: string;
}

interface ValidationIssue {
  code: string;
  message: string;
}

const DEFAULT_ARTIFACT_PATH = path.join('artifacts', 'bench', 'r4-weekly-trend.json');
const DEFAULT_ARCHIVE_DIR = path.join('artifacts', 'bench', 'archive', 'r4-weekly');
const PERIOD_KEY_REGEX = /^\d{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/;

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-weekly-retrieval-trend-report.ts [options]

Options:
  --artifact <path>      Weekly trend artifact path (default: ${DEFAULT_ARTIFACT_PATH})
  --archive-dir <path>   Weekly archive directory (default: ${DEFAULT_ARCHIVE_DIR})
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    artifactPath: DEFAULT_ARTIFACT_PATH,
    archiveDir: DEFAULT_ARCHIVE_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--artifact') {
      if (!next) throw new Error('Missing value for --artifact');
      args.artifactPath = next;
      i += 1;
      continue;
    }
    if (arg === '--archive-dir') {
      if (!next) throw new Error('Missing value for --archive-dir');
      args.archiveDir = next;
      i += 1;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getCurrentIsoWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function validateSchema(artifact: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (artifact.schema_version !== 1) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'schema_version must be 1' });
  }

  if (artifact.status !== 'PASS' && artifact.status !== 'FAIL') {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'status must be PASS|FAIL' });
  }
  if (artifact.status === 'FAIL') {
    issues.push({ code: 'ARTIFACT_STATUS_FAIL', message: 'Weekly trend artifact status is FAIL' });
  }

  const period = asObject(artifact.period);
  if (!period) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'period must be an object' });
  } else {
    const key = period.key;
    const startUtc = period.start_utc;
    const endUtcExclusive = period.end_utc_exclusive;
    if (typeof key !== 'string' || !PERIOD_KEY_REGEX.test(key)) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'period.key must match YYYY-Www' });
    }
    if (typeof startUtc !== 'string' || Number.isNaN(Date.parse(startUtc))) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'period.start_utc must be an ISO timestamp' });
    }
    if (typeof endUtcExclusive !== 'string' || Number.isNaN(Date.parse(endUtcExclusive))) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'period.end_utc_exclusive must be an ISO timestamp' });
    }
    if (
      typeof startUtc === 'string' &&
      typeof endUtcExclusive === 'string' &&
      !Number.isNaN(Date.parse(startUtc)) &&
      !Number.isNaN(Date.parse(endUtcExclusive)) &&
      Date.parse(startUtc) >= Date.parse(endUtcExclusive)
    ) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'period.start_utc must be before period.end_utc_exclusive' });
    }
  }

  const summary = asObject(artifact.summary);
  if (!summary) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'summary must be an object' });
  } else {
    if (!Number.isInteger(summary.pass_checks) || (summary.pass_checks as number) < 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'summary.pass_checks must be an integer >= 0' });
    }
    if (!Number.isInteger(summary.fail_checks) || (summary.fail_checks as number) < 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'summary.fail_checks must be an integer >= 0' });
    }
    if (typeof summary.retention_archive_note !== 'string' || summary.retention_archive_note.trim().length === 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'summary.retention_archive_note is required' });
    }
  }

  const metrics = asObject(artifact.metrics);
  if (!metrics) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'metrics must be an object' });
  } else {
    const metricFields = [
      'strict_parity_score',
      'quality_pass_rate',
      'ndcg_delta_pct',
      'mrr_delta_pct',
      'recall_delta_pct',
    ];
    for (const field of metricFields) {
      if (!isFiniteNumber(metrics[field])) {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `metrics.${field} must be a finite number` });
      }
    }
  }

  if (!Array.isArray(artifact.checks)) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'checks must be an array' });
  } else if (artifact.checks.length === 0) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'checks must not be empty' });
  } else {
    artifact.checks.forEach((entry, index) => {
      const check = asObject(entry);
      if (!check) {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `checks[${index}] must be an object` });
        return;
      }
      if (typeof check.id !== 'string' || check.id.trim().length === 0) {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `checks[${index}].id is required` });
      }
      if (check.status !== 'PASS' && check.status !== 'FAIL') {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `checks[${index}].status must be PASS|FAIL` });
      }
      if (typeof check.message !== 'string' || check.message.trim().length === 0) {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `checks[${index}].message is required` });
      }
    });
  }

  if (summary && Array.isArray(artifact.checks)) {
    const passChecks = summary.pass_checks;
    const failChecks = summary.fail_checks;
    if (
      Number.isInteger(passChecks) &&
      Number.isInteger(failChecks) &&
      (passChecks as number) + (failChecks as number) !== artifact.checks.length
    ) {
      issues.push({
        code: 'SCHEMA_MISMATCH',
        message: 'summary.pass_checks + summary.fail_checks must equal checks.length',
      });
    }
  }

  const retention = asObject(artifact.retention);
  if (!retention) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'retention must be an object' });
  } else {
    if (typeof retention.policy !== 'string' || retention.policy.trim().length === 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'retention.policy is required' });
    }
    if (!Number.isInteger(retention.retained_period_count) || (retention.retained_period_count as number) < 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'retention.retained_period_count must be an integer >= 0' });
    }
    if (typeof retention.retention_archive_note !== 'string' || retention.retention_archive_note.trim().length === 0) {
      issues.push({ code: 'SCHEMA_MISMATCH', message: 'retention.retention_archive_note is required' });
    }
  }

  const inputs = asObject(artifact.inputs);
  if (!inputs) {
    issues.push({ code: 'SCHEMA_MISMATCH', message: 'inputs must be an object' });
  } else {
    const requiredPathFields = ['parity_artifact_path', 'quality_artifact_path', 'out_path', 'archive_dir'];
    for (const field of requiredPathFields) {
      if (typeof inputs[field] !== 'string' || (inputs[field] as string).trim().length === 0) {
        issues.push({ code: 'SCHEMA_MISMATCH', message: `inputs.${field} is required` });
      }
    }
    const hashRegex = /^[a-f0-9]{64}$/i;
    const hashFields = ['parity_artifact_sha256', 'quality_artifact_sha256'];
    for (const field of hashFields) {
      if (typeof inputs[field] !== 'string' || !hashRegex.test(inputs[field] as string)) {
        issues.push({
          code: 'SCHEMA_MISMATCH',
          message: `inputs.${field} must be a 64-char hex SHA256`,
        });
      }
    }
  }

  return issues;
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const artifactPath = path.resolve(args.artifactPath);
    const archiveDir = path.resolve(args.archiveDir);
    const issues: ValidationIssue[] = [];

    if (!fs.existsSync(artifactPath)) {
      // eslint-disable-next-line no-console
      console.error(`MISSING_ARTIFACT: ${artifactPath}`);
      return 1;
    }

    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
    const artifact = asObject(parsed);
    if (!artifact) {
      // eslint-disable-next-line no-console
      console.error(`SCHEMA_MISMATCH: artifact must be a JSON object (${artifactPath})`);
      return 1;
    }

    issues.push(...validateSchema(artifact));

    const period = asObject(artifact.period);
    const periodKey = period?.key;

    if (typeof periodKey === 'string' && PERIOD_KEY_REGEX.test(periodKey)) {
      const expectedPeriodKey = getCurrentIsoWeekKey(new Date());
      if (periodKey !== expectedPeriodKey) {
        issues.push({
          code: 'STALE_PERIOD',
          message: `Artifact period ${periodKey} does not match current period ${expectedPeriodKey}`,
        });
      }
      if (!fs.existsSync(archiveDir)) {
        issues.push({ code: 'MISSING_ARTIFACT', message: `Archive directory not found: ${archiveDir}` });
      } else {
        const archiveEntries = fs.readdirSync(archiveDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('r4-weekly-trend-'))
          .map((entry) => path.join(archiveDir, entry.name));

        const samePeriod = archiveEntries.filter((entryPath) => {
          try {
            const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as unknown;
            const entryObj = asObject(entry);
            const entryPeriod = asObject(entryObj?.period);
            return entryPeriod?.key === periodKey;
          } catch {
            return false;
          }
        });

        if (samePeriod.length === 0) {
          issues.push({ code: 'MISSING_ARTIFACT', message: `No archived artifact for period ${periodKey}` });
        }
        if (samePeriod.length > 1) {
          issues.push({ code: 'DUPLICATE_PERIOD', message: `Found ${samePeriod.length} archived artifacts for period ${periodKey}` });
        }
      }
    }

    if (issues.length > 0) {
      for (const issue of issues) {
        // eslint-disable-next-line no-console
        console.error(`${issue.code}: ${issue.message}`);
      }
      return 1;
    }

    // eslint-disable-next-line no-console
    console.log(`r4_weekly_trend_check PASS artifact=${artifactPath}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
