#!/usr/bin/env node
/**
 * Deterministic validator for docs/MASTER_PLAN_CHECKLIST.md.
 *
 * Validates structure and checklist hygiene without requiring all items to be complete.
 *
 * Exit codes:
 * - 0: checklist structure/format is valid
 * - 1: structural or formatting issues detected
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CHECKLIST_PATH = 'docs/MASTER_PLAN_CHECKLIST.md';
const REQUIRED_HEADINGS = [
  '## A) Completed Foundation Waves (Already Implemented)',
  '## B) Remaining Master Roadmap (Implement All)',
  '## B1) Shared Foundations (Cross-Tool Standardization)',
  '## B2) Tool Family Completion Batches',
  '## C) Global Validation Gates (Must Pass Before “All Done”)',
  '## D) Definition of Done (Master)',
];

const CHECKBOX_LINE_REGEX = /^- \[( |x)\] .+/;
const DATE_PREFIX_REGEX = /^- \d{4}-\d{2}-\d{2}:/;

type ValidationResult = {
  errors: string[];
  warnings: string[];
  stats: {
    totalLines: number;
    checkboxLines: number;
    checkedItems: number;
    uncheckedItems: number;
    progressSections: number;
  };
};

function resolveChecklistPath(argv: string[]): string {
  const candidate = argv[2]?.trim();
  if (!candidate) {
    return path.resolve(DEFAULT_CHECKLIST_PATH);
  }
  return path.resolve(candidate);
}

function validateChecklist(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const heading of REQUIRED_HEADINGS) {
    if (!content.includes(heading)) {
      errors.push(`Missing required heading: ${heading}`);
    }
  }

  let checkboxLines = 0;
  let checkedItems = 0;
  let uncheckedItems = 0;
  let progressSections = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('- [')) {
      checkboxLines += 1;
      if (!CHECKBOX_LINE_REGEX.test(trimmed)) {
        errors.push(`Malformed checkbox line at ${i + 1}: ${trimmed}`);
      }
      if (trimmed.startsWith('- [x]')) {
        checkedItems += 1;
      } else if (trimmed.startsWith('- [ ]')) {
        uncheckedItems += 1;
      }
    }

    if (trimmed === 'Progress notes:' || trimmed === '## Changelog') {
      progressSections += 1;
      const next = lines[i + 1]?.trim() ?? '';
      if (!next.startsWith('- ')) {
        errors.push(`Section at line ${i + 1} is missing list entries`);
      }
    }

    if (trimmed.startsWith('- 20') && !DATE_PREFIX_REGEX.test(trimmed)) {
      errors.push(`Invalid dated entry format at line ${i + 1}: ${trimmed}`);
    }

    if (trimmed.includes('TODO') || trimmed.includes('FIXME')) {
      warnings.push(`Found TODO/FIXME marker at line ${i + 1}`);
    }
  }

  if (checkboxLines === 0) {
    errors.push('No checklist checkbox lines found');
  }

  return {
    errors,
    warnings,
    stats: {
      totalLines: lines.length,
      checkboxLines,
      checkedItems,
      uncheckedItems,
      progressSections,
    },
  };
}

function main(): void {
  const checklistPath = resolveChecklistPath(process.argv);
  if (!fs.existsSync(checklistPath)) {
    // eslint-disable-next-line no-console
    console.error(`Master plan checklist not found: ${checklistPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(checklistPath, 'utf8');
  const result = validateChecklist(content);

  // eslint-disable-next-line no-console
  console.log('Master plan validation');
  // eslint-disable-next-line no-console
  console.log(`Checklist: ${checklistPath}`);
  // eslint-disable-next-line no-console
  console.log(`Lines: ${result.stats.totalLines}`);
  // eslint-disable-next-line no-console
  console.log(
    `Items: ${result.stats.checkboxLines} (checked=${result.stats.checkedItems}, unchecked=${result.stats.uncheckedItems})`
  );

  if (result.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.log('Warnings:');
    for (const warning of result.warnings) {
      // eslint-disable-next-line no-console
      console.log(`- ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Validation errors:');
    for (const error of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    // eslint-disable-next-line no-console
    console.error('Master plan validation failed.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Master plan validation passed.');
  process.exit(0);
}

main();
