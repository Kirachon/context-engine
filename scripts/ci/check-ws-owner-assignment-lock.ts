#!/usr/bin/env node
/**
 * Deterministic owner-assignment lock checker for WS13-WS21.
 *
 * Validates owner lock markdown table structure and concrete values.
 *
 * Exit codes:
 * - 0: owner lock artifact is complete and valid
 * - 1: artifact has missing/invalid rows or placeholder values
 * - 2: usage error
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LOCK_PATH = 'docs/WS_OWNER_ASSIGNMENT_LOCK.md';
const REQUIRED_STREAMS = [
  'WS13',
  'WS14',
  'WS15',
  'WS16',
  'WS17',
  'WS18',
  'WS19',
  'WS20',
  'WS21',
] as const;

const PLACEHOLDER_VALUES = new Set([
  '',
  '-',
  '_',
  'tbd',
  'pending',
  'unassigned',
  'n/a',
  'na',
]);

type AssignmentRow = {
  stream: string;
  owner: string;
  assignmentDate: string;
  approver: string;
  line: number;
};

type ValidationResult = {
  errors: string[];
  rows: AssignmentRow[];
};

function parseArgs(argv: string[]): string {
  const args = argv.map((arg) => arg.trim()).filter(Boolean);
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(
      'Usage: node --import tsx scripts/ci/check-ws-owner-assignment-lock.ts [lock-doc-path]'
    );
    process.exit(0);
  }
  if (args.length > 1) {
    // eslint-disable-next-line no-console
    console.error('Too many arguments. Expected 0 or 1 path argument.');
    process.exit(2);
  }
  return path.resolve(args[0] ?? DEFAULT_LOCK_PATH);
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDER_VALUES.has(normalized);
}

function parseRows(content: string): AssignmentRow[] {
  const rows: AssignmentRow[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      continue;
    }

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) {
      continue;
    }
    if (
      cells[0].toLowerCase() === 'stream' ||
      cells.every((cell) => cell.replace(/-/g, '') === '')
    ) {
      continue;
    }

    rows.push({
      stream: cells[0],
      owner: cells[1],
      assignmentDate: cells[2],
      approver: cells[3],
      line: i + 1,
    });
  }

  return rows;
}

function validate(content: string): ValidationResult {
  const errors: string[] = [];
  const rows = parseRows(content);
  const streamToRow = new Map<string, AssignmentRow>();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  for (const row of rows) {
    if (streamToRow.has(row.stream)) {
      errors.push(`Duplicate stream row: ${row.stream}`);
      continue;
    }
    streamToRow.set(row.stream, row);

    if (!REQUIRED_STREAMS.includes(row.stream as (typeof REQUIRED_STREAMS)[number])) {
      errors.push(`Unexpected stream id at line ${row.line}: ${row.stream}`);
    }
    if (isPlaceholder(row.owner)) {
      errors.push(`Stream ${row.stream}: owner must be concrete`);
    }
    if (isPlaceholder(row.approver)) {
      errors.push(`Stream ${row.stream}: approver must be concrete`);
    }
    if (!dateRegex.test(row.assignmentDate)) {
      errors.push(
        `Stream ${row.stream}: assignment_date must be YYYY-MM-DD (found: ${row.assignmentDate})`
      );
    }
  }

  for (const requiredStream of REQUIRED_STREAMS) {
    if (!streamToRow.has(requiredStream)) {
      errors.push(`Missing required stream row: ${requiredStream}`);
    }
  }

  return { errors, rows };
}

function main(): void {
  const lockPath = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(lockPath)) {
    // eslint-disable-next-line no-console
    console.error(`Owner assignment lock artifact not found: ${lockPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(lockPath, 'utf8');
  const result = validate(content);

  // eslint-disable-next-line no-console
  console.log('WS owner assignment lock check');
  // eslint-disable-next-line no-console
  console.log(`Artifact: ${lockPath}`);
  // eslint-disable-next-line no-console
  console.log(`Rows parsed: ${result.rows.length}`);

  if (result.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Validation errors:');
    for (const error of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    // eslint-disable-next-line no-console
    console.error('WS owner assignment lock check failed.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('WS owner assignment lock check passed.');
}

main();
