/**
 * Layer 3: MCP Interface Layer - Invariants Check Tool
 *
 * Thin wrapper that runs the YAML invariants engine against a provided diff.
 * Intended as a standalone deterministic check for CI/IDE integrations.
 */

import { ContextServiceClient } from '../serviceClient.js';
import type { ParsedDiff } from '../types/codeReview.js';
import { parseUnifiedDiff } from '../../reviewer/diff/parse.js';
import { runDeterministicPreflight } from '../../reviewer/checks/preflight.js';
import { loadInvariantsConfig } from '../../reviewer/checks/invariants/load.js';
import { runInvariants } from '../../reviewer/checks/invariants/runner.js';
import { assertNonEmptyDiffScope, normalizeRequiredDiffInput } from '../tooling/diffInput.js';
import { normalizeWorkspaceRelativePaths } from '../../workspace/pathValidation.js';

export interface CheckInvariantsArgs {
  diff: string;
  changed_files?: string[];
  invariants_path?: string;
}

export async function handleCheckInvariants(
  args: CheckInvariantsArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const diff = normalizeRequiredDiffInput(
    args.diff,
    'Missing or invalid "diff" argument. Provide a unified diff string.'
  );
  const changedFiles = args.changed_files
    ? normalizeWorkspaceRelativePaths(args.changed_files, 'changed_files', { rejectOptionLike: true })
    : undefined;
  assertNonEmptyDiffScope(diff, changedFiles);

  const workspacePath = serviceClient.getWorkspacePath();
  const invariantsPath = args.invariants_path ?? '.review-invariants.yml';

  const parsedDiff: ParsedDiff = parseUnifiedDiff(diff);
  const preflight = runDeterministicPreflight(parsedDiff, changedFiles);

  const warnings: string[] = [];
  try {
    const config = loadInvariantsConfig(workspacePath, invariantsPath);
    const runResult = runInvariants(parsedDiff, preflight.changed_files, config);
    return JSON.stringify(
      {
        success: true,
        invariants_path: invariantsPath,
        checked_invariants: runResult.checked_invariants,
        warnings: [...warnings, ...runResult.warnings],
        findings: runResult.findings,
      },
      null,
      2
    );
  } catch (e) {
    return JSON.stringify(
      {
        success: false,
        invariants_path: invariantsPath,
        checked_invariants: 0,
        warnings,
        error: String(e),
        findings: [],
      },
      null,
      2
    );
  }
}

export const checkInvariantsTool = {
  name: 'check_invariants',
  description: 'Run YAML invariants deterministically against a unified diff (no LLM).',
  inputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Unified diff content' },
      changed_files: { type: 'array', items: { type: 'string' }, description: 'Optional list of changed file paths' },
      invariants_path: {
        type: 'string',
        description: 'Path to invariants config file (relative to workspace). Default: .review-invariants.yml',
        default: '.review-invariants.yml',
      },
    },
    required: ['diff'],
  },
};
