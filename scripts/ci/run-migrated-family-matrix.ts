#!/usr/bin/env node
/**
 * Deterministic targeted matrix gate for migrated tool families.
 *
 * Runs explicit, bounded Jest suites followed by required deterministic CI gates.
 *
 * Exit codes:
 * - 0: all matrix groups and gate scripts pass
 * - 1: any group or gate script fails
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

type MatrixGroup = {
  name: string;
  tests: string[];
};

const MATRIX_GROUPS: MatrixGroup[] = [
  {
    name: 'planning-plan-management',
    tests: [
      'tests/tools/plan.test.ts',
      'tests/tools/planManagement.test.ts',
      'tests/tools/planLifecycle.contract.test.ts',
      'tests/tools/planManagement.contract.test.ts',
    ],
  },
  {
    name: 'review-pipeline',
    tests: [
      'tests/tools/reviewChanges.validation.test.ts',
      'tests/tools/reviewDiff.test.ts',
      'tests/tools/reviewGitDiff.test.ts',
      'tests/tools/reviewAuto.test.ts',
      'tests/tools/checkInvariants.test.ts',
      'tests/tools/runStaticAnalysis.test.ts',
    ],
  },
  {
    name: 'lifecycle-search',
    tests: [
      'tests/tools/lifecycle.test.ts',
      'tests/tools/status.test.ts',
      'tests/tools/search.test.ts',
      'tests/tools/context.test.ts',
      'tests/tools/codebaseRetrieval.test.ts',
      'tests/tools/file.test.ts',
      'tests/tools/enhance.test.ts',
    ],
  },
  {
    name: 'memory-reactive',
    tests: ['tests/tools/memory.test.ts', 'tests/tools/reactiveReview.test.ts'],
  },
];

const REQUIRED_GATE_SCRIPTS: string[] = [
  'scripts/ci/check-tool-manifest-parity.ts',
  'scripts/ci/check-version-literals.ts',
  'scripts/ci/check-stale-cache-guards.ts',
];

function runOrFail(label: string, command: string, args: string[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n[matrix] ${label}`);
  // eslint-disable-next-line no-console
  console.log(`$ ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
    },
  });

  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`${label} failed with exit code ${status}`);
  }
}

function runTargetedJestGroup(group: MatrixGroup): void {
  const jestCli = path.resolve('node_modules', 'jest', 'bin', 'jest.js');
  runOrFail(
    `jest group: ${group.name}`,
    process.execPath,
    ['--experimental-vm-modules', jestCli, '--runInBand', '--silent', ...group.tests]
  );
}

function runGateScript(scriptPath: string): void {
  runOrFail(`gate script: ${scriptPath}`, process.execPath, ['--import', 'tsx', scriptPath]);
}

function main(): void {
  // eslint-disable-next-line no-console
  console.log('Migrated-family targeted matrix gate');
  // eslint-disable-next-line no-console
  console.log(`Workspace: ${process.cwd()}`);

  for (const group of MATRIX_GROUPS) {
    runTargetedJestGroup(group);
  }

  for (const scriptPath of REQUIRED_GATE_SCRIPTS) {
    runGateScript(scriptPath);
  }

  // eslint-disable-next-line no-console
  console.log('\n[matrix] All migrated-family targeted checks passed.');
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`\n[matrix] Failed: ${message}`);
  process.exit(1);
}
