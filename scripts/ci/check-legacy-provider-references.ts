#!/usr/bin/env node
/**
 * Deterministic CI guard to block legacy provider references.
 *
 * Usage:
 *   node --import tsx scripts/ci/check-legacy-provider-references.ts [--allowlist <path>] [--roots <csv>] [--strict]
 *
 * Exit codes:
 * - 0: clean scan (no violations)
 * - 1: one or more violations detected
 * - 2: usage/parsing error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type CliArgs = {
  allowlistPath?: string;
  roots: string[];
  strict: boolean;
};

type Violation = {
  file: string;
  line: number;
  pattern: string;
};

const DEFAULT_ROOTS = [
  'src',
  'scripts',
  'tests',
  '.github/workflows',
  'docs',
  'package.json',
  'package-lock.json',
  'verify-setup.js',
  'bin/context-engine-mcp.js',
];

const BLOCKED_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: '@augmentcode/auggie-sdk', regex: /@augmentcode\/auggie-sdk/i },
  { label: 'augment_legacy', regex: /\baugment_legacy\b/i },
  { label: 'DirectContext', regex: /\bDirectContext\b/i },
  { label: 'CE_FORCE_LEGACY', regex: /\bCE_FORCE_LEGACY\b/i },
  {
    label: 'CE_RETRIEVAL_PROVIDER=augment_legacy',
    regex: /\bCE_RETRIEVAL_PROVIDER\s*=\s*augment_legacy\b/i,
  },
];

function printUsage(code: number): never {
  // eslint-disable-next-line no-console
  console.log(
    'Usage: node --import tsx scripts/ci/check-legacy-provider-references.ts [--allowlist <path>] [--roots <csv>] [--strict]'
  );
  process.exit(code);
}

function normalizeRelative(targetPath: string): string {
  return targetPath.split(path.sep).join('/');
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    roots: [...DEFAULT_ROOTS],
    strict: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printUsage(0);
    }

    if (arg === '--allowlist') {
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --allowlist');
      }
      args.allowlistPath = next.trim();
      i += 1;
      continue;
    }

    if (arg === '--roots') {
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --roots');
      }
      const parsedRoots = next
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (parsedRoots.length === 0) {
        throw new Error('Expected at least one root in --roots CSV');
      }
      args.roots = parsedRoots;
      i += 1;
      continue;
    }

    if (arg === '--strict') {
      args.strict = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function walkDirectory(dirPath: string, collector: Set<string>): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, collector);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    collector.add(path.resolve(fullPath));
  }
}

function collectFiles(roots: string[], strict: boolean): { files: string[]; missingRoots: string[] } {
  const files = new Set<string>();
  const missingRoots: string[] = [];

  for (const root of roots) {
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved)) {
      missingRoots.push(root);
      continue;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walkDirectory(resolved, files);
      continue;
    }
    if (stat.isFile()) {
      files.add(resolved);
      continue;
    }

    missingRoots.push(root);
  }

  if (strict && missingRoots.length > 0) {
    throw new Error(`Missing roots in strict mode: ${missingRoots.join(', ')}`);
  }

  return {
    files: Array.from(files).sort((a, b) => a.localeCompare(b)),
    missingRoots,
  };
}

function readAllowlist(allowlistPath: string): Set<string> {
  const resolved = path.resolve(allowlistPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Allowlist file not found: ${allowlistPath}`);
  }

  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  const items = new Set<string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    items.add(normalizeRelative(line));
  }
  return items;
}

function isAllowlisted(relativePath: string, allowlist: Set<string>): boolean {
  if (allowlist.has(relativePath)) {
    return true;
  }
  for (const entry of allowlist) {
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3);
      if (relativePath.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

function findViolations(files: string[], allowlist: Set<string>): Violation[] {
  const violations: Violation[] = [];

  for (const filePath of files) {
    const relative = normalizeRelative(path.relative(process.cwd(), filePath));
    if (isAllowlisted(relative, allowlist)) {
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const blocked of BLOCKED_PATTERNS) {
        if (blocked.regex.test(line)) {
          violations.push({
            file: relative,
            line: index + 1,
            pattern: blocked.label,
          });
        }
      }
    }
  }

  return violations;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printUsage(2);
  }

  let allowlist = new Set<string>();
  try {
    if (args.allowlistPath) {
      allowlist = readAllowlist(args.allowlistPath);
    }

    const { files, missingRoots } = collectFiles(args.roots, args.strict);
    const violations = findViolations(files, allowlist);

    if (missingRoots.length > 0 && !args.strict) {
      // eslint-disable-next-line no-console
      console.log(`Skipped missing roots: ${missingRoots.join(', ')}`);
    }

    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error('No-legacy provider reference check failed.');
      for (const violation of violations) {
        // eslint-disable-next-line no-console
        console.error(`${violation.file}:${violation.line}:${violation.pattern}`);
      }
      // eslint-disable-next-line no-console
      console.error(
        `Summary: scanned_files=${files.length} allowlisted_files=${allowlist.size} violations=${violations.length}`
      );
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('No-legacy provider reference check passed.');
    // eslint-disable-next-line no-console
    console.log(`Summary: scanned_files=${files.length} allowlisted_files=${allowlist.size} violations=0`);
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
