#!/usr/bin/env node
/**
 * Deterministic smoke check for review_auto timeout passthrough on review_git_diff path.
 *
 * Exit codes:
 * - 0: all checks passed
 * - 1: one or more checks failed
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleReviewAuto } from '../../src/mcp/tools/reviewAuto.js';

type SmokeStatus = 'PASS' | 'FAIL';

interface SmokeCheck {
  id: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

interface SmokeArtifact {
  status: SmokeStatus;
  summary: string;
  checks: SmokeCheck[];
  metrics: {
    duration_ms: number;
    requested_timeout_ms: number;
    observed_timeout_ms: number | null;
  };
}

const REQUESTED_TIMEOUT_MS = 120_000;
const ARTIFACT_PATH = path.resolve('artifacts', 'review_auto_timeout_smoke.json');

function sh(bin: string, args: string[], cwd: string): string {
  return execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

function createRepoWithStagedChange(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-review-auto-timeout-smoke-'));

  sh('git', ['init'], tmp);
  sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
  sh('git', ['config', 'user.name', 'CI'], tmp);

  writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
  sh('git', ['add', '.'], tmp);
  sh('git', ['commit', '-m', 'base'], tmp);

  writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', 'export const b = 2;', ''].join('\n'));
  sh('git', ['add', '.'], tmp);

  return tmp;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeArtifact(artifact: SmokeArtifact): void {
  ensureParentDir(ARTIFACT_PATH);
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
}

function pushCheck(checks: SmokeCheck[], id: string, passed: boolean, detail: string): void {
  checks.push({
    id,
    status: passed ? 'PASS' : 'FAIL',
    detail,
  });
}

async function main(): Promise<void> {
  const start = Date.now();
  const checks: SmokeCheck[] = [];
  let observedTimeoutMs: number | null = null;

  try {
    const tmp = createRepoWithStagedChange();

    const mockServiceClient = {
      getWorkspacePath: () => tmp,
      searchAndAsk: async (_query: string, _prompt: string, opts?: { timeoutMs?: number }) => {
        observedTimeoutMs = opts?.timeoutMs ?? null;
        return JSON.stringify({
          findings: [
            {
              id: 'finding_1',
              title: 'Add input validation',
              body: 'Mocked output.',
              confidence_score: 0.95,
              priority: 1,
              category: 'correctness',
              code_location: { file_path: 'src/a.ts', line_range: { start: 2, end: 2 } },
              suggestion: { description: 'Add a guard', can_auto_fix: false },
              is_on_changed_line: true,
            },
          ],
          overall_correctness: 'needs attention',
          overall_explanation: 'Mocked output.',
          overall_confidence_score: 0.8,
        });
      },
    } as any;

    const resultStr = await handleReviewAuto(
      {
        target: 'staged',
        review_git_diff_options: {
          llm_timeout_ms: REQUESTED_TIMEOUT_MS,
        },
      },
      mockServiceClient
    );
    const parsed = JSON.parse(resultStr) as {
      selected_tool?: string;
      output?: { review?: { findings?: unknown[] } };
    };

    pushCheck(
      checks,
      'selected_review_git_diff_path',
      parsed.selected_tool === 'review_git_diff',
      `selected_tool=${String(parsed.selected_tool)}`
    );
    pushCheck(
      checks,
      'observed_timeout_matches_request',
      observedTimeoutMs === REQUESTED_TIMEOUT_MS,
      `requested=${REQUESTED_TIMEOUT_MS} observed=${String(observedTimeoutMs)}`
    );
    pushCheck(
      checks,
      'review_payload_is_present',
      Array.isArray(parsed.output?.review?.findings),
      'Expected review_auto output.review.findings array.'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushCheck(checks, 'smoke_execution', false, message);
  }

  const failedChecks = checks.filter((check) => check.status === 'FAIL');
  const status: SmokeStatus = failedChecks.length === 0 ? 'PASS' : 'FAIL';
  const artifact: SmokeArtifact = {
    status,
    summary:
      status === 'PASS'
        ? 'review_auto timeout smoke passed.'
        : `review_auto timeout smoke failed (${failedChecks.length} check(s) failed).`,
    checks,
    metrics: {
      duration_ms: Date.now() - start,
      requested_timeout_ms: REQUESTED_TIMEOUT_MS,
      observed_timeout_ms: observedTimeoutMs,
    },
  };

  writeArtifact(artifact);

  // eslint-disable-next-line no-console
  console.log(`status=${artifact.status}`);
  // eslint-disable-next-line no-console
  console.log(`summary=${artifact.summary}`);
  // eslint-disable-next-line no-console
  console.log(`artifact=${ARTIFACT_PATH}`);
  // eslint-disable-next-line no-console
  console.log(
    `metrics duration_ms=${artifact.metrics.duration_ms} requested_timeout_ms=${artifact.metrics.requested_timeout_ms} observed_timeout_ms=${String(artifact.metrics.observed_timeout_ms)}`
  );
  for (const check of artifact.checks) {
    // eslint-disable-next-line no-console
    console.log(`${check.status} ${check.id}: ${check.detail}`);
  }

  if (status === 'FAIL') {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const artifact: SmokeArtifact = {
    status: 'FAIL',
    summary: `review_auto timeout smoke failed with unhandled error: ${message}`,
    checks: [
      {
        id: 'unhandled_error',
        status: 'FAIL',
        detail: message,
      },
    ],
    metrics: {
      duration_ms: 0,
      requested_timeout_ms: REQUESTED_TIMEOUT_MS,
      observed_timeout_ms: null,
    },
  };
  writeArtifact(artifact);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
});
