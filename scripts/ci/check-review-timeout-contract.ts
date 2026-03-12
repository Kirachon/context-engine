#!/usr/bin/env node
/**
 * Deterministic CI guard for review timeout contract invariants.
 *
 * Source-only checks (no network calls) against:
 * - src/mcp/services/codeReviewService.ts
 * - src/mcp/tools/codeReview.ts
 * - src/mcp/tools/gitReview.ts
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

const CODE_REVIEW_SERVICE_PATH = path.resolve('src/mcp/services/codeReviewService.ts');
const REVIEW_CHANGES_TOOL_PATH = path.resolve('src/mcp/tools/codeReview.ts');
const REVIEW_GIT_DIFF_TOOL_PATH = path.resolve('src/mcp/tools/gitReview.ts');

function readFileOrThrow(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required source file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function evalNumericExpression(expr: string): number | null {
  if (!/^[\d_+\-*/().\s]+$/.test(expr)) {
    return null;
  }
  const normalized = expr.replace(/_/g, '');
  try {
    const value = Function(`"use strict"; return (${normalized});`)();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function checkDefaultTimeoutConstant(codeReviewServiceSource: string): CheckResult {
  const match = codeReviewServiceSource.match(
    /const\s+DEFAULT_CODE_REVIEW_AI_TIMEOUT_MS\s*=\s*([^;]+);/
  );
  if (!match || !match[1]) {
    return {
      id: 'default_timeout_constant_present',
      passed: false,
      detail: 'Could not find DEFAULT_CODE_REVIEW_AI_TIMEOUT_MS constant.',
    };
  }

  const expr = match[1].trim();
  const value = evalNumericExpression(expr);
  if (value === null) {
    return {
      id: 'default_timeout_constant_minimum',
      passed: false,
      detail: `Could not evaluate DEFAULT_CODE_REVIEW_AI_TIMEOUT_MS expression: ${expr}`,
    };
  }

  const minTimeoutMs = 120_000;
  const passed = value >= minTimeoutMs;
  return {
    id: 'default_timeout_constant_minimum',
    passed,
    detail: passed
      ? `DEFAULT_CODE_REVIEW_AI_TIMEOUT_MS=${value} (>= ${minTimeoutMs})`
      : `DEFAULT_CODE_REVIEW_AI_TIMEOUT_MS=${value} (< ${minTimeoutMs})`,
  };
}

function checkReviewChangesSchemaTimeout(reviewChangesSource: string): CheckResult {
  const hasSchemaTimeout =
    /export\s+const\s+reviewChangesTool[\s\S]*inputSchema[\s\S]*properties[\s\S]*llm_timeout_ms\s*:/.test(
      reviewChangesSource
    );

  return {
    id: 'review_changes_schema_llm_timeout_ms',
    passed: hasSchemaTimeout,
    detail: hasSchemaTimeout
      ? 'review_changes inputSchema exposes llm_timeout_ms.'
      : 'review_changes inputSchema is missing llm_timeout_ms.',
  };
}

function checkReviewGitDiffOptionsSchemaTimeout(reviewGitDiffSource: string): CheckResult {
  const hasOptionsTimeout =
    /export\s+const\s+reviewGitDiffTool[\s\S]*inputSchema[\s\S]*options\s*:[\s\S]*properties\s*:[\s\S]*llm_timeout_ms\s*:/.test(
      reviewGitDiffSource
    );

  return {
    id: 'review_git_diff_options_schema_llm_timeout_ms',
    passed: hasOptionsTimeout,
    detail: hasOptionsTimeout
      ? 'review_git_diff options schema exposes llm_timeout_ms.'
      : 'review_git_diff options schema is missing llm_timeout_ms.',
  };
}

function checkReviewChangesTimeoutRangeValidation(reviewChangesSource: string): CheckResult {
  const hasRangeGuard =
    /validateFiniteNumberInRange\(\s*args\.llm_timeout_ms\s*,\s*1_?000\s*,\s*30\s*\*\s*60\s*\*\s*1000\s*,/.test(
      reviewChangesSource
    );

  return {
    id: 'review_changes_llm_timeout_ms_range_guard',
    passed: hasRangeGuard,
    detail: hasRangeGuard
      ? 'review_changes validates llm_timeout_ms in the expected range.'
      : 'review_changes is missing llm_timeout_ms range validation.',
  };
}

function main(): void {
  // eslint-disable-next-line no-console
  console.log('Review timeout contract check');

  let codeReviewServiceSource: string;
  let reviewChangesSource: string;
  let reviewGitDiffSource: string;
  try {
    codeReviewServiceSource = readFileOrThrow(CODE_REVIEW_SERVICE_PATH);
    reviewChangesSource = readFileOrThrow(REVIEW_CHANGES_TOOL_PATH);
    reviewGitDiffSource = readFileOrThrow(REVIEW_GIT_DIFF_TOOL_PATH);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const checks: CheckResult[] = [
    checkDefaultTimeoutConstant(codeReviewServiceSource),
    checkReviewChangesSchemaTimeout(reviewChangesSource),
    checkReviewGitDiffOptionsSchemaTimeout(reviewGitDiffSource),
    checkReviewChangesTimeoutRangeValidation(reviewChangesSource),
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
    console.error(`Review timeout contract check failed with ${failedChecks.length} issue(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Review timeout contract check passed.');
  process.exit(0);
}

main();
