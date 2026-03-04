#!/usr/bin/env node
/**
 * Deterministic governance artifact completeness checker.
 *
 * Validates that required operator-facing fields exist in rollout governance docs.
 *
 * Exit codes:
 * - 0: all files and required fields are present
 * - 1: one or more required fields/files are missing
 * - 2: usage error
 */

import * as fs from 'fs';
import * as path from 'path';

type ArtifactKey = 'preRollout' | 'freeze' | 'finalRelease' | 'rolloutEvidence';

interface CheckerArgs {
  preRolloutPath: string;
  freezePath: string;
  finalReleasePath: string;
  rolloutEvidencePath: string;
}

interface ArtifactSpec {
  label: string;
  requiredTokens: string[];
}

const DEFAULTS: Record<ArtifactKey, string> = {
  preRollout: 'docs/templates/pre-rollout-baseline-checklist.template.md',
  freeze: 'docs/templates/freeze-checklist.template.md',
  finalRelease: 'docs/templates/final-release-summary.template.md',
  rolloutEvidence: 'docs/ROLLOUT_EVIDENCE_LOG.md',
};

const REQUIRED_SPECS: Record<ArtifactKey, ArtifactSpec> = {
  preRollout: {
    label: 'pre-rollout baseline checklist',
    requiredTokens: [
      'Artifact Type: pre_rollout_baseline_checklist',
      'Rollout ID:',
      'Baseline Snapshot ID:',
      'check-rollout-readiness command:',
      'WS20 stage gate artifact path:',
      'Checklist Complete (true/false):',
      'Approved to advance (yes/no):',
    ],
  },
  freeze: {
    label: 'freeze checklist',
    requiredTokens: [
      'Artifact Type: freeze_checklist',
      'Freeze ID:',
      'Rollout ID:',
      'WS19 SLO gate status (pass/fail):',
      'WS20 stage gate status (pass/fail):',
      'WS21 rollback evidence status (pass/fail):',
      'Freeze lift approved (yes/no):',
    ],
  },
  finalRelease: {
    label: 'final release summary',
    requiredTokens: [
      'Artifact Type: final_release_summary',
      'Release ID:',
      'Version/Tag:',
      'Commit Range:',
      'Final rollout evidence entry path:',
      'Freeze checklist path:',
      'WS21 rollback drill log path:',
      'Summary status (released/blocked/rolled_back):',
    ],
  },
  rolloutEvidence: {
    label: 'rollout evidence log update path',
    requiredTokens: [
      '## Governance Artifact Update Path',
      'docs/templates/pre-rollout-baseline-checklist.template.md',
      'docs/templates/freeze-checklist.template.md',
      'docs/templates/final-release-summary.template.md',
      'docs/templates/rollout-evidence-entry.template.md',
      'docs/WS21_ROLLBACK_DRILL_TEMPLATE.md',
      'config/rollout-go-no-go-thresholds.json',
      'Recommended update sequence:',
    ],
  },
};

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-governance-artifacts.ts [options]

Options:
  --pre-rollout <path>     Path to pre-rollout baseline checklist template.
  --freeze <path>          Path to freeze checklist template.
  --final-release <path>   Path to final release summary template.
  --rollout-evidence <path> Path to rollout evidence log.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CheckerArgs {
  const args: CheckerArgs = {
    preRolloutPath: DEFAULTS.preRollout,
    freezePath: DEFAULTS.freeze,
    finalReleasePath: DEFAULTS.finalRelease,
    rolloutEvidencePath: DEFAULTS.rolloutEvidence,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if ((arg === '--pre-rollout' || arg === '--pre-rollout-path') && next) {
      args.preRolloutPath = next.trim();
      i += 1;
      continue;
    }
    if ((arg === '--freeze' || arg === '--freeze-path') && next) {
      args.freezePath = next.trim();
      i += 1;
      continue;
    }
    if ((arg === '--final-release' || arg === '--final-release-path') && next) {
      args.finalReleasePath = next.trim();
      i += 1;
      continue;
    }
    if ((arg === '--rollout-evidence' || arg === '--rollout-evidence-path') && next) {
      args.rolloutEvidencePath = next.trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function validateRequiredTokens(
  resolvedPath: string,
  spec: ArtifactSpec
): { errors: string[]; checkCount: number } {
  const errors: string[] = [];
  if (!fs.existsSync(resolvedPath)) {
    errors.push(`Missing required file: ${resolvedPath} (${spec.label})`);
    return { errors, checkCount: 1 };
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  for (const token of spec.requiredTokens) {
    if (!content.includes(token)) {
      errors.push(`Missing token in ${resolvedPath}: "${token}"`);
    }
  }

  return { errors, checkCount: spec.requiredTokens.length };
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

  const targets: Array<{ key: ArtifactKey; filePath: string }> = [
    { key: 'preRollout', filePath: args.preRolloutPath },
    { key: 'freeze', filePath: args.freezePath },
    { key: 'finalRelease', filePath: args.finalReleasePath },
    { key: 'rolloutEvidence', filePath: args.rolloutEvidencePath },
  ];

  const failures: string[] = [];
  let totalChecks = 0;
  // eslint-disable-next-line no-console
  console.log('Governance artifact completeness check');
  for (const target of targets) {
    const resolvedPath = path.resolve(target.filePath);
    const spec = REQUIRED_SPECS[target.key];
    const result = validateRequiredTokens(resolvedPath, spec);
    totalChecks += result.checkCount;

    if (result.errors.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`PASS ${spec.label}: ${resolvedPath}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`FAIL ${spec.label}: ${resolvedPath}`);
      failures.push(...result.errors);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`checks=${totalChecks}`);
  if (failures.length > 0) {
    for (const failure of failures) {
      // eslint-disable-next-line no-console
      console.error(`- ${failure}`);
    }
    // eslint-disable-next-line no-console
    console.error(`Governance artifact check failed with ${failures.length} issue(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Governance artifact check passed.');
  process.exit(0);
}

main();
