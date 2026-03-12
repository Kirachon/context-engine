#!/usr/bin/env node
/**
 * Deterministic CI guard for enhance_prompt contract invariants.
 *
 * Source-only checks (no network calls) against:
 * - src/internal/handlers/enhancement.ts
 * - src/mcp/tools/enhance.ts
 *
 * Exit codes:
 * - 0: all checks passed
 * - 1: one or more checks failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type CheckResult = {
  id: string;
  passed: boolean;
  detail: string;
};

const ENHANCEMENT_PATH = path.resolve('src/internal/handlers/enhancement.ts');
const TOOL_HANDLER_PATH = path.resolve('src/mcp/tools/enhance.ts');

const REQUIRED_SECTION_HEADERS = [
  'Objective',
  'Critical Context',
  'Assumptions',
  'Constraints',
  'Proposed Plan',
  'Validation Checklist',
  'Risks and Mitigations',
  'Open Questions',
  'Done Definition',
];

const FORBIDDEN_FALLBACK_PHRASE = 'Improve and execute this request with clear scope and outputs';

function readFileOrThrow(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required source file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function checkRequiredSectionHeaders(enhancementSource: string): CheckResult {
  const listMatch = enhancementSource.match(
    /const\s+REQUIRED_STRUCTURED_SECTIONS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/
  );

  if (!listMatch || !listMatch[1]) {
    return {
      id: 'required_section_headers',
      passed: false,
      detail: 'Could not find REQUIRED_STRUCTURED_SECTIONS list.',
    };
  }

  const listBody = listMatch[1];
  const missingHeaders = REQUIRED_SECTION_HEADERS.filter(
    (header) => !new RegExp(`['"]${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(listBody)
  );

  if (missingHeaders.length > 0) {
    return {
      id: 'required_section_headers',
      passed: false,
      detail: `Missing required section header(s): ${missingHeaders.join(', ')}`,
    };
  }

  return {
    id: 'required_section_headers',
    passed: true,
    detail: 'REQUIRED_STRUCTURED_SECTIONS list contains all required headers.',
  };
}

function checkTransientErrorCode(enhancementSource: string): CheckResult {
  const hasTypedTransientCode = /export\s+type\s+EnhancePromptErrorCode[\s\S]*['"]TRANSIENT_UPSTREAM['"]/.test(
    enhancementSource
  );

  return {
    id: 'typed_transient_error_code',
    passed: hasTypedTransientCode,
    detail: hasTypedTransientCode
      ? 'Typed error code TRANSIENT_UPSTREAM is present.'
      : 'Typed error code TRANSIENT_UPSTREAM is missing from EnhancePromptErrorCode.',
  };
}

function checkToolHandlerSchemaFields(toolHandlerSource: string): CheckResult {
  const hasSchemaVersion = /\bschema_version\s*:/.test(toolHandlerSource);
  const hasTemplateVersion = /\btemplate_version\s*:/.test(toolHandlerSource);

  if (hasSchemaVersion && hasTemplateVersion) {
    return {
      id: 'tool_handler_schema_fields',
      passed: true,
      detail: 'Tool handler includes schema_version and template_version fields.',
    };
  }

  const missing: string[] = [];
  if (!hasSchemaVersion) missing.push('schema_version');
  if (!hasTemplateVersion) missing.push('template_version');

  return {
    id: 'tool_handler_schema_fields',
    passed: false,
    detail: `Missing required JSON schema field(s) in tool handler: ${missing.join(', ')}`,
  };
}

function checkForbiddenFallbackPhrase(enhancementSource: string): CheckResult {
  const hasForbiddenPhrase = enhancementSource.includes(FORBIDDEN_FALLBACK_PHRASE);
  return {
    id: 'forbidden_fallback_phrase_absent',
    passed: !hasForbiddenPhrase,
    detail: hasForbiddenPhrase
      ? `Forbidden fallback template phrase found in enhancement handler: "${FORBIDDEN_FALLBACK_PHRASE}"`
      : 'Forbidden fallback template phrase is absent from enhancement handler.',
  };
}

function main(): void {
  // eslint-disable-next-line no-console
  console.log('Enhance prompt contract check');

  let enhancementSource: string;
  let toolHandlerSource: string;
  try {
    enhancementSource = readFileOrThrow(ENHANCEMENT_PATH);
    toolHandlerSource = readFileOrThrow(TOOL_HANDLER_PATH);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const checks: CheckResult[] = [
    checkRequiredSectionHeaders(enhancementSource),
    checkTransientErrorCode(enhancementSource),
    checkToolHandlerSchemaFields(toolHandlerSource),
    checkForbiddenFallbackPhrase(enhancementSource),
  ];

  const failedChecks = checks.filter((check) => !check.passed);
  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`${status} ${check.id}: ${check.detail}`);
  }

  // eslint-disable-next-line no-console
  console.log(`checks=${checks.length} failed=${failedChecks.length}`);

  if (failedChecks.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Enhance prompt contract check failed with ${failedChecks.length} issue(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Enhance prompt contract check passed.');
  process.exit(0);
}

main();
