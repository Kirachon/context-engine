#!/usr/bin/env node
/**
 * Deterministic docs-governance checker for enhance_prompt examples.
 *
 * Validates EXAMPLES.md contract expectations for enhance_prompt docs.
 *
 * Exit codes:
 * - 0: all checks pass
 * - 1: one or more checks fail
 * - 2: usage / argument error
 */

import * as fs from 'fs';
import * as path from 'path';

interface Args {
  examplesPath: string;
}

interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

const DEFAULT_EXAMPLES_PATH = 'EXAMPLES.md';
const ENHANCE_HEADING = '### enhance_prompt Tool';

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-enhance-doc-contract.ts [options]

Options:
  --examples <path>   Path to EXAMPLES.md (default: EXAMPLES.md)
`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { examplesPath: DEFAULT_EXAMPLES_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--examples' && next) {
      args.examplesPath = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function extractEnhanceSection(content: string): string | null {
  const start = content.indexOf(ENHANCE_HEADING);
  if (start < 0) {
    return null;
  }
  const tail = content.slice(start + ENHANCE_HEADING.length);
  const nextHeadingIndex = tail.search(/\n###\s+/);
  if (nextHeadingIndex < 0) {
    return content.slice(start);
  }
  return content.slice(start, start + ENHANCE_HEADING.length + nextHeadingIndex);
}

function extractJsonBlocks(section: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(section)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function hasDeprecatedArgsInEnhanceExamples(section: string): {
  foundEnhanceExample: boolean;
  deprecatedKeys: string[];
} {
  const deprecated = new Set<string>();
  const blocks = extractJsonBlocks(section);
  let foundEnhanceExample = false;

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed?.name !== 'enhance_prompt') {
        continue;
      }
      foundEnhanceExample = true;
      const args = parsed.arguments ?? {};
      if (Object.prototype.hasOwnProperty.call(args, 'use_ai')) {
        deprecated.add('use_ai');
      }
      if (Object.prototype.hasOwnProperty.call(args, 'max_files')) {
        deprecated.add('max_files');
      }
    } catch {
      // Ignore non-parseable blocks to keep the checker deterministic and read-only.
    }
  }

  return { foundEnhanceExample, deprecatedKeys: [...deprecated].sort() };
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  const resolvedExamplesPath = path.resolve(args.examplesPath);
  if (!fs.existsSync(resolvedExamplesPath)) {
    // eslint-disable-next-line no-console
    console.error(`EXAMPLES file not found: ${resolvedExamplesPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolvedExamplesPath, 'utf-8');
  const section = extractEnhanceSection(content);
  if (!section) {
    // eslint-disable-next-line no-console
    console.error(`Missing required section: ${ENHANCE_HEADING}`);
    process.exit(1);
  }

  const checkResults: CheckResult[] = [];
  const deprecatedArgCheck = hasDeprecatedArgsInEnhanceExamples(section);
  if (!deprecatedArgCheck.foundEnhanceExample) {
    checkResults.push({
      id: 'deprecated-args',
      ok: false,
      detail: 'No enhance_prompt JSON examples found in enhance_prompt section.',
    });
  } else if (deprecatedArgCheck.deprecatedKeys.length > 0) {
    checkResults.push({
      id: 'deprecated-args',
      ok: false,
      detail: `Deprecated args found under enhance_prompt examples: ${deprecatedArgCheck.deprecatedKeys.join(', ')}`,
    });
  } else {
    checkResults.push({
      id: 'deprecated-args',
      ok: true,
      detail: 'No deprecated args (use_ai, max_files) found in enhance_prompt examples.',
    });
  }

  const hasStructuredMarkdownDefault =
    /structured markdown/i.test(section) &&
    /(default|standard)/i.test(section) &&
    /(text output|response format)/i.test(section);
  const hasNoFallbackBehavior =
    /(no|without)\s+.*fallback\s+template/i.test(section) &&
    /(transient|upstream|failure)/i.test(section);
  checkResults.push({
    id: 'behavior-notes',
    ok: hasStructuredMarkdownDefault && hasNoFallbackBehavior,
    detail:
      hasStructuredMarkdownDefault && hasNoFallbackBehavior
        ? 'Section documents structured markdown default and no-fallback-template behavior.'
        : 'Section must document structured markdown default and no deterministic fallback-template behavior.',
  });

  const hasSchemaVersion = /"schema_version"\s*:\s*"/.test(section);
  const hasTransientUpstream = /"error_code"\s*:\s*"TRANSIENT_UPSTREAM"/.test(section);
  checkResults.push({
    id: 'json-envelope',
    ok: hasSchemaVersion && hasTransientUpstream,
    detail:
      hasSchemaVersion && hasTransientUpstream
        ? 'JSON envelope examples include schema_version and TRANSIENT_UPSTREAM error_code.'
        : 'JSON envelope examples must include schema_version and error_code=TRANSIENT_UPSTREAM.',
  });

  // eslint-disable-next-line no-console
  console.log(`Enhance docs contract check: ${resolvedExamplesPath}`);

  let failures = 0;
  for (const result of checkResults) {
    if (!result.ok) {
      failures += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id}: ${result.detail}`);
  }

  // eslint-disable-next-line no-console
  console.log(`summary: checks=${checkResults.length} failed=${failures}`);
  if (failures > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main();
