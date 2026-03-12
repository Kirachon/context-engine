#!/usr/bin/env node
/**
 * Deterministic checker for R9 recommendation import templates (CSV/Markdown).
 *
 * Exit codes:
 * - 0: all selected inputs passed validation
 * - 1: one or more validation failures
 * - 2: usage/argument error
 */

import * as fs from 'fs';
import * as path from 'path';

const CANONICAL_COLUMNS = [
  'recommendation_id',
  'recommendation',
  'domain',
  'evidence',
  'impact',
  'urgency',
  'confidence',
  'effort',
  'risk',
  'score',
  'owner',
  'due_window',
  'depends_on',
  'success_metric',
  'validation',
  'rollback_abort',
] as const;

const INTEGER_1_TO_5_FIELDS = ['impact', 'urgency', 'confidence', 'effort', 'risk'] as const;
const DUE_WINDOWS = new Set(['0-30 days', '31-60 days', '61-90 days']);
const RECOMMENDATION_ID_REGEX = /^R\d+$/i;

type SourceKind = 'csv' | 'md';

interface CheckerArgs {
  csvPath: string;
  mdPath: string;
  checkCsv: boolean;
  checkMd: boolean;
  knownIds: Set<string>;
}

interface ParsedRow {
  source: SourceKind;
  rowNumber: number;
  lineNumber: number;
  cells: string[];
}

interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  parseErrors: string[];
}

const DEFAULTS: Omit<CheckerArgs, 'knownIds'> = {
  csvPath: 'docs/templates/r9-recommendation-import.template.csv',
  mdPath: 'docs/templates/r9-recommendation-import.template.md',
  checkCsv: true,
  checkMd: true,
};

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-r9-recommendation-import.ts [options]

Options:
  --csv <path>         Path to CSV template/input.
  --md <path>          Path to Markdown template/input.
  --known-id <id>      Known backlog recommendation ID (repeatable; accepts comma/semicolon-separated values).
  --skip-csv           Skip CSV validation.
  --skip-md            Skip Markdown validation.
  --help, -h           Show this help.
`);
  process.exit(code);
}

function stripBom(value: string): string {
  return value.startsWith('\uFEFF') ? value.slice(1) : value;
}

function normalizeRecommendationId(value: string): string {
  return value.trim().toUpperCase();
}

function parseKnownIdList(raw: string): string[] {
  return raw
    .split(/[;,]/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function parseArgs(argv: string[]): CheckerArgs {
  const parsed: CheckerArgs = {
    ...DEFAULTS,
    knownIds: new Set<string>(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }

    if (arg === '--csv') {
      if (!next) {
        throw new Error('Missing value for --csv');
      }
      parsed.csvPath = next.trim();
      i += 1;
      continue;
    }

    if (arg === '--md') {
      if (!next) {
        throw new Error('Missing value for --md');
      }
      parsed.mdPath = next.trim();
      i += 1;
      continue;
    }

    if (arg === '--known-id') {
      if (!next) {
        throw new Error('Missing value for --known-id');
      }
      const ids = parseKnownIdList(next);
      for (const id of ids) {
        const normalized = normalizeRecommendationId(id);
        if (!RECOMMENDATION_ID_REGEX.test(normalized)) {
          throw new Error(`Invalid --known-id value "${id}" (expected R<number>)`);
        }
        parsed.knownIds.add(normalized);
      }
      i += 1;
      continue;
    }

    if (arg === '--skip-csv') {
      parsed.checkCsv = false;
      continue;
    }

    if (arg === '--skip-md') {
      parsed.checkMd = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.checkCsv && !parsed.checkMd) {
    throw new Error('At least one input must be enabled (remove --skip-csv or --skip-md)');
  }

  return parsed;
}

function parseCsv(content: string): ParseResult {
  const errors: string[] = [];
  const records: Array<{ fields: string[]; lineNumber: number }> = [];
  const source = stripBom(content);

  let lineNumber = 1;
  let rowStartLine = 1;
  let inQuotes = false;
  let currentField = '';
  let currentRow: string[] = [];

  const pushField = () => {
    currentRow.push(currentField);
    currentField = '';
  };

  const pushRow = () => {
    pushField();
    records.push({ fields: currentRow, lineNumber: rowStartLine });
    currentRow = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === '"') {
      if (inQuotes && source[i + 1] === '"') {
        currentField += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      pushField();
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      pushRow();
      if (ch === '\r' && source[i + 1] === '\n') {
        i += 1;
      }
      lineNumber += 1;
      rowStartLine = lineNumber;
      continue;
    }

    currentField += ch;
  }

  if (inQuotes) {
    errors.push('CSV parse error: unmatched quote at end of file');
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  const nonEmptyRecords = records.filter((record) =>
    record.fields.some((field) => stripBom(field).trim().length > 0)
  );
  if (nonEmptyRecords.length === 0) {
    return { headers: [], rows: [], parseErrors: ['CSV is empty'] };
  }

  const headerRow = nonEmptyRecords[0].fields.map((value, index) =>
    index === 0 ? stripBom(value).trim() : value.trim()
  );

  const rows: ParsedRow[] = [];
  for (let i = 1; i < nonEmptyRecords.length; i += 1) {
    const record = nonEmptyRecords[i];
    rows.push({
      source: 'csv',
      rowNumber: i,
      lineNumber: record.lineNumber,
      cells: record.fields,
    });
  }

  return {
    headers: headerRow,
    rows,
    parseErrors: errors,
  };
}

function parseMarkdownRow(line: string): { cells: string[] } | { error: string } {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return { error: 'row must start and end with pipe (|)' };
  }

  const cells: string[] = [];
  let current = '';
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];
    if (ch === '\\' && next === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return { cells };
}

function isMarkdownSeparatorCell(value: string): boolean {
  return /^:?-{3,}:?$/.test(value.trim());
}

function parseMarkdown(content: string): ParseResult {
  const errors: string[] = [];
  const lines = stripBom(content).split(/\r?\n/g);
  const headingIndex = lines.findIndex((line) => /^##\s+Recommendations\b/i.test(line.trim()));
  if (headingIndex < 0) {
    return {
      headers: [],
      rows: [],
      parseErrors: ['Markdown parse error: missing "## Recommendations" section'],
    };
  }

  let tableStart = -1;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|')) {
      tableStart = i;
      break;
    }
  }
  if (tableStart < 0) {
    return {
      headers: [],
      rows: [],
      parseErrors: ['Markdown parse error: no table found under "## Recommendations"'],
    };
  }

  const tableLines: Array<{ line: string; lineNumber: number }> = [];
  for (let i = tableStart; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|')) {
      tableLines.push({ line: lines[i], lineNumber: i + 1 });
      continue;
    }
    if (tableLines.length > 0) {
      break;
    }
  }

  if (tableLines.length < 2) {
    return {
      headers: [],
      rows: [],
      parseErrors: ['Markdown parse error: table must contain header and separator rows'],
    };
  }

  const headerParsed = parseMarkdownRow(tableLines[0].line);
  if ('error' in headerParsed) {
    return {
      headers: [],
      rows: [],
      parseErrors: [`Markdown parse error at line ${tableLines[0].lineNumber}: ${headerParsed.error}`],
    };
  }
  const headers = headerParsed.cells.map((cell) => cell.trim());

  const separatorParsed = parseMarkdownRow(tableLines[1].line);
  if ('error' in separatorParsed) {
    return {
      headers: [],
      rows: [],
      parseErrors: [`Markdown parse error at line ${tableLines[1].lineNumber}: ${separatorParsed.error}`],
    };
  }
  if (
    separatorParsed.cells.length !== headers.length ||
    !separatorParsed.cells.every((cell) => isMarkdownSeparatorCell(cell))
  ) {
    errors.push(
      `Markdown parse error at line ${tableLines[1].lineNumber}: invalid separator row for ${headers.length} columns`
    );
  }

  const rows: ParsedRow[] = [];
  for (let i = 2; i < tableLines.length; i += 1) {
    const parsed = parseMarkdownRow(tableLines[i].line);
    if ('error' in parsed) {
      errors.push(`Markdown parse error at line ${tableLines[i].lineNumber}: ${parsed.error}`);
      continue;
    }
    if (parsed.cells.every((cell) => cell.trim().length === 0)) {
      continue;
    }
    rows.push({
      source: 'md',
      rowNumber: i - 1,
      lineNumber: tableLines[i].lineNumber,
      cells: parsed.cells,
    });
  }

  if (rows.length === 0) {
    errors.push('Markdown parse error: table contains no data rows');
  }

  return {
    headers,
    rows,
    parseErrors: errors,
  };
}

function formatExpectedHeader(): string {
  return CANONICAL_COLUMNS.join(', ');
}

function validateHeaders(headers: string[], sourceLabel: string, errors: string[]): void {
  if (headers.length !== CANONICAL_COLUMNS.length) {
    errors.push(
      `${sourceLabel}: header column count mismatch (expected ${CANONICAL_COLUMNS.length}, got ${headers.length})`
    );
  }

  for (let i = 0; i < CANONICAL_COLUMNS.length; i += 1) {
    const expected = CANONICAL_COLUMNS[i];
    const actual = headers[i];
    if (actual !== expected) {
      errors.push(
        `${sourceLabel}: header mismatch at column ${i + 1} (expected "${expected}", got "${actual ?? '<missing>'}")`
      );
    }
  }
}

function isNonEmptyTrimmedString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRows(
  rows: ParsedRow[],
  sourceLabel: string,
  knownIds: Set<string>,
  errors: string[]
): number {
  const idOccurrences = new Map<string, string[]>();
  const payloadIds = new Set<string>();

  for (const row of rows) {
    if (row.cells.length !== CANONICAL_COLUMNS.length) {
      errors.push(
        `${sourceLabel}: malformed row ${row.rowNumber} (line ${row.lineNumber}) has ${row.cells.length} columns; expected ${CANONICAL_COLUMNS.length}`
      );
      continue;
    }

    const recommendationId = normalizeRecommendationId(row.cells[0]);
    if (RECOMMENDATION_ID_REGEX.test(recommendationId)) {
      payloadIds.add(recommendationId);
      const loc = `${sourceLabel} row ${row.rowNumber} (line ${row.lineNumber})`;
      const entries = idOccurrences.get(recommendationId) ?? [];
      entries.push(loc);
      idOccurrences.set(recommendationId, entries);
    }
  }

  for (const [id, locations] of idOccurrences.entries()) {
    if (locations.length > 1) {
      errors.push(
        `${sourceLabel}: duplicate recommendation_id "${id}" found at ${locations.join(', ')}`
      );
    }
  }

  const visibleIds = new Set<string>([...payloadIds, ...knownIds]);

  for (const row of rows) {
    const location = `${sourceLabel} row ${row.rowNumber} (line ${row.lineNumber})`;
    if (row.cells.length !== CANONICAL_COLUMNS.length) {
      continue;
    }

    const record: Record<(typeof CANONICAL_COLUMNS)[number], string> = {} as Record<
      (typeof CANONICAL_COLUMNS)[number],
      string
    >;
    for (let i = 0; i < CANONICAL_COLUMNS.length; i += 1) {
      record[CANONICAL_COLUMNS[i]] = row.cells[i];
    }

    for (const column of CANONICAL_COLUMNS) {
      if (!isNonEmptyTrimmedString(record[column])) {
        errors.push(`${location}: ${column} is required and must be non-empty`);
      }
    }

    const recommendationId = normalizeRecommendationId(record.recommendation_id);
    if (!RECOMMENDATION_ID_REGEX.test(recommendationId)) {
      errors.push(`${location}: recommendation_id "${record.recommendation_id}" must match R<number>`);
    }

    for (const field of INTEGER_1_TO_5_FIELDS) {
      const value = record[field].trim();
      if (!/^-?\d+$/.test(value)) {
        errors.push(`${location}: ${field} must be an integer in range 1..5`);
        continue;
      }
      const numeric = Number.parseInt(value, 10);
      if (numeric < 1 || numeric > 5) {
        errors.push(`${location}: ${field} must be an integer in range 1..5`);
      }
    }

    const scoreValue = Number(record.score.trim());
    if (!Number.isFinite(scoreValue)) {
      errors.push(`${location}: score must be a valid number`);
    }

    const dueWindow = record.due_window.trim();
    if (!DUE_WINDOWS.has(dueWindow)) {
      errors.push(
        `${location}: due_window must be one of ${Array.from(DUE_WINDOWS)
          .map((value) => `"${value}"`)
          .join(', ')}`
      );
    }

    const dependsRaw = record.depends_on.trim();
    if (!/^none$/i.test(dependsRaw)) {
      const tokens = dependsRaw
        .split(';')
        .map((token) => normalizeRecommendationId(token))
        .filter((token) => token.length > 0);
      if (tokens.length === 0) {
        errors.push(`${location}: depends_on must be "none" or semicolon-delimited IDs`);
      }

      const uniqueTokens = new Set<string>(tokens);
      for (const token of uniqueTokens) {
        if (!RECOMMENDATION_ID_REGEX.test(token)) {
          errors.push(`${location}: depends_on token "${token}" must match R<number>`);
          continue;
        }
        if (token === recommendationId) {
          errors.push(`${location}: depends_on contains self dependency "${token}"`);
        }
        if (!visibleIds.has(token)) {
          errors.push(
            `${location}: depends_on references unknown ID "${token}" (not in payload or --known-id set)`
          );
        }
      }
    }
  }

  return rows.length;
}

function runCheckForSource(
  source: SourceKind,
  filePath: string,
  knownIds: Set<string>,
  errors: string[]
): number {
  const label = source === 'csv' ? 'CSV' : 'Markdown';

  if (!fs.existsSync(filePath)) {
    errors.push(`${label}: file not found at ${filePath}`);
    return 0;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    errors.push(`${label}: failed to read file (${error instanceof Error ? error.message : String(error)})`);
    return 0;
  }

  const parsed = source === 'csv' ? parseCsv(raw) : parseMarkdown(raw);

  for (const parseError of parsed.parseErrors) {
    errors.push(`${label}: ${parseError}`);
  }

  validateHeaders(parsed.headers, label, errors);
  return validateRows(parsed.rows, label, knownIds, errors);
}

function main(): void {
  let args: CheckerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  const csvPath = path.resolve(args.csvPath);
  const mdPath = path.resolve(args.mdPath);
  const errors: string[] = [];
  let rowCount = 0;

  // eslint-disable-next-line no-console
  console.log('R9 recommendation import schema check');
  if (args.checkCsv) {
    // eslint-disable-next-line no-console
    console.log(`CSV input: ${csvPath}`);
    rowCount += runCheckForSource('csv', csvPath, args.knownIds, errors);
  }
  if (args.checkMd) {
    // eslint-disable-next-line no-console
    console.log(`Markdown input: ${mdPath}`);
    rowCount += runCheckForSource('md', mdPath, args.knownIds, errors);
  }

  // eslint-disable-next-line no-console
  console.log(`known_ids=${Array.from(args.knownIds).sort().join(',') || '<none>'}`);
  // eslint-disable-next-line no-console
  console.log(`validated_rows=${rowCount}`);

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Validation errors:');
    for (const issue of errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${issue}`);
    }
    // eslint-disable-next-line no-console
    console.error(`R9 recommendation import check failed with ${errors.length} issue(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('R9 recommendation import check passed.');
}

main();
