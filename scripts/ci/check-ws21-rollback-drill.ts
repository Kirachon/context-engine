#!/usr/bin/env node
/**
 * Deterministic WS21 rollback drill evidence checker.
 *
 * Validates required fields for one or more operator log files.
 *
 * Exit codes:
 * - 0: all files passed
 * - 1: one or more files failed validation
 * - 2: usage / parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

const REQUIRED_FIELDS = [
  'rollback_event',
  'Command Path',
  'Owner',
  'Started At (UTC)',
  'Ended At (UTC)',
  'RTO Target Minutes',
  'RTO Actual Minutes',
  'RTO Evidence',
  'Recovery Evidence',
  'Blocker Status',
] as const;

const ALLOWED_BLOCKER_STATUS = new Set(['none', 'resolved', 'open']);

type ValidationResult = {
  filePath: string;
  errors: string[];
};

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-ws21-rollback-drill.ts <log-path> [more-log-paths...]
`);
  process.exit(code);
}

function parseArgs(argv: string[]): string[] {
  const args = argv.map(arg => arg.trim()).filter(Boolean);
  if (args.includes('--help') || args.includes('-h')) {
    printHelpAndExit(0);
  }
  if (args.length === 0) {
    throw new Error('Missing required argument: at least one WS21 drill log path.');
  }
  return args;
}

function parseFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  const fieldLineRegex = /^([A-Za-z][A-Za-z0-9 ()/_-]*):\s*(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) {
      continue;
    }

    const match = fieldLineRegex.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    fields[key] = value;
  }

  return fields;
}

function parseStrictUtcIso(value: string): number | undefined {
  const strictUtcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  if (!strictUtcIso.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return timestamp;
}

function validateLogFile(filePath: string, content: string): ValidationResult {
  const errors: string[] = [];
  const fields = parseFields(content);

  for (const requiredField of REQUIRED_FIELDS) {
    const value = fields[requiredField];
    if (!value || value.trim().length === 0) {
      errors.push(`Missing required field: ${requiredField}`);
    }
  }

  const startedRaw = fields['Started At (UTC)'];
  const endedRaw = fields['Ended At (UTC)'];
  const startedAt = startedRaw ? parseStrictUtcIso(startedRaw) : undefined;
  const endedAt = endedRaw ? parseStrictUtcIso(endedRaw) : undefined;

  if (startedRaw && startedAt == null) {
    errors.push(`Invalid UTC timestamp for Started At (UTC): ${startedRaw}`);
  }
  if (endedRaw && endedAt == null) {
    errors.push(`Invalid UTC timestamp for Ended At (UTC): ${endedRaw}`);
  }
  if (startedAt != null && endedAt != null && endedAt < startedAt) {
    errors.push('Ended At (UTC) must be greater than or equal to Started At (UTC).');
  }

  const blockerStatusRaw = fields['Blocker Status'];
  if (blockerStatusRaw) {
    const blockerStatus = blockerStatusRaw.toLowerCase();
    if (!ALLOWED_BLOCKER_STATUS.has(blockerStatus)) {
      errors.push(`Invalid Blocker Status: ${blockerStatusRaw} (allowed: none|resolved|open)`);
    }
    if (blockerStatus === 'open') {
      errors.push('Blocker Status indicates unresolved blocker (open).');
    }
    if (blockerStatus === 'resolved') {
      const resolutionEvidence = fields['Blocker Resolution Evidence']?.trim() ?? '';
      if (!resolutionEvidence) {
        errors.push(
          'Blocker Resolution Evidence is required when Blocker Status is resolved.'
        );
      }
    }
  }

  const rtoTargetRaw = fields['RTO Target Minutes'];
  const rtoActualRaw = fields['RTO Actual Minutes'];
  const rtoTarget = rtoTargetRaw ? Number(rtoTargetRaw) : undefined;
  const rtoActual = rtoActualRaw ? Number(rtoActualRaw) : undefined;

  if (rtoTargetRaw && (!Number.isFinite(rtoTarget) || (rtoTarget as number) <= 0)) {
    errors.push(`RTO Target Minutes must be a positive number: ${rtoTargetRaw}`);
  }
  if (rtoActualRaw && (!Number.isFinite(rtoActual) || (rtoActual as number) < 0)) {
    errors.push(`RTO Actual Minutes must be a non-negative number: ${rtoActualRaw}`);
  }
  if (
    Number.isFinite(rtoTarget) &&
    Number.isFinite(rtoActual) &&
    (rtoActual as number) > (rtoTarget as number)
  ) {
    errors.push('RTO Actual Minutes must be less than or equal to RTO Target Minutes.');
  }

  return { filePath, errors };
}

function main(): void {
  let inputPaths: string[];
  try {
    inputPaths = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  const results: ValidationResult[] = [];
  for (const inputPath of inputPaths) {
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
      // eslint-disable-next-line no-console
      console.error(`WS21 drill log not found: ${resolved}`);
      process.exit(1);
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    results.push(validateLogFile(resolved, content));
  }

  // eslint-disable-next-line no-console
  console.log('WS21 rollback drill evidence check');
  let failed = 0;
  for (const result of results) {
    const passed = result.errors.length === 0;
    if (!passed) {
      failed += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`${passed ? 'PASS' : 'FAIL'} ${result.filePath}`);
    if (!passed) {
      for (const error of result.errors) {
        // eslint-disable-next-line no-console
        console.log(`- ${error}`);
      }
    }
  }

  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`WS21 evidence check failed for ${failed} file(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('WS21 evidence check passed.');
  process.exit(0);
}

main();
