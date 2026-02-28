import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf-8');
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-governance-artifacts.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

const VALID_PRE_ROLLOUT = [
  'Artifact Type: pre_rollout_baseline_checklist',
  'Rollout ID:',
  'Baseline Snapshot ID:',
  'check-rollout-readiness command:',
  'WS20 stage gate artifact path:',
  'Checklist Complete (true/false):',
  'Approved to advance (yes/no):',
].join('\n');

const VALID_FREEZE = [
  'Artifact Type: freeze_checklist',
  'Freeze ID:',
  'Rollout ID:',
  'WS19 SLO gate status (pass/fail):',
  'WS20 stage gate status (pass/fail):',
  'WS21 rollback evidence status (pass/fail):',
  'Freeze lift approved (yes/no):',
].join('\n');

const VALID_FINAL_RELEASE = [
  'Artifact Type: final_release_summary',
  'Release ID:',
  'Version/Tag:',
  'Commit Range:',
  'Final rollout evidence entry path:',
  'Freeze checklist path:',
  'WS21 rollback drill log path:',
  'Summary status (released/blocked/rolled_back):',
].join('\n');

const VALID_ROLLOUT_LOG = [
  '## Governance Artifact Update Path',
  'docs/templates/pre-rollout-baseline-checklist.template.md',
  'docs/templates/freeze-checklist.template.md',
  'docs/templates/final-release-summary.template.md',
  'docs/templates/rollout-evidence-entry.template.md',
  'Recommended update sequence:',
].join('\n');

describe('scripts/ci/check-governance-artifacts.ts', () => {
  it('passes when all required tokens are present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-governance-pass-'));
    const preRolloutPath = path.join(tmp, 'pre-rollout.md');
    const freezePath = path.join(tmp, 'freeze.md');
    const finalReleasePath = path.join(tmp, 'final-release.md');
    const rolloutEvidencePath = path.join(tmp, 'rollout-log.md');

    writeText(preRolloutPath, VALID_PRE_ROLLOUT);
    writeText(freezePath, VALID_FREEZE);
    writeText(finalReleasePath, VALID_FINAL_RELEASE);
    writeText(rolloutEvidencePath, VALID_ROLLOUT_LOG);

    const result = runChecker([
      '--pre-rollout',
      preRolloutPath,
      '--freeze',
      freezePath,
      '--final-release',
      finalReleasePath,
      '--rollout-evidence',
      rolloutEvidencePath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Governance artifact check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required token is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-governance-missing-token-'));
    const preRolloutPath = path.join(tmp, 'pre-rollout.md');
    const freezePath = path.join(tmp, 'freeze.md');
    const finalReleasePath = path.join(tmp, 'final-release.md');
    const rolloutEvidencePath = path.join(tmp, 'rollout-log.md');

    writeText(
      preRolloutPath,
      [
        'Artifact Type: pre_rollout_baseline_checklist',
        'Rollout ID:',
        'Baseline Snapshot ID:',
      ].join('\n')
    );
    writeText(freezePath, VALID_FREEZE);
    writeText(finalReleasePath, VALID_FINAL_RELEASE);
    writeText(rolloutEvidencePath, VALID_ROLLOUT_LOG);

    const result = runChecker([
      '--pre-rollout',
      preRolloutPath,
      '--freeze',
      freezePath,
      '--final-release',
      finalReleasePath,
      '--rollout-evidence',
      rolloutEvidencePath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing token');
    expect(result.stderr).toContain('check-rollout-readiness command:');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required file is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-governance-missing-file-'));
    const preRolloutPath = path.join(tmp, 'pre-rollout.md');
    const freezePath = path.join(tmp, 'freeze.md');
    const finalReleasePath = path.join(tmp, 'final-release.md');
    const rolloutEvidencePath = path.join(tmp, 'rollout-log.md');

    writeText(preRolloutPath, VALID_PRE_ROLLOUT);
    writeText(freezePath, VALID_FREEZE);
    writeText(rolloutEvidencePath, VALID_ROLLOUT_LOG);

    const result = runChecker([
      '--pre-rollout',
      preRolloutPath,
      '--freeze',
      freezePath,
      '--final-release',
      finalReleasePath,
      '--rollout-evidence',
      rolloutEvidencePath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required file');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
