import { describe, it, expect } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function sh(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf-8');
}

function run(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function readJson(filePath: string): any {
  return JSON.parse(readUtf8(filePath));
}

function normalizeReviewDiffResult(result: any): any {
  const normalized = JSON.parse(JSON.stringify(result));

  // Non-deterministic values
  delete normalized.run_id;
  if (normalized.metadata) {
    delete normalized.metadata.reviewed_at;
  }
  if (normalized.stats) {
    delete normalized.stats.duration_ms;
    delete normalized.stats.timings_ms;
  }

  return normalized;
}

function runCiScript(workspace: string, env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'review-diff.ts');
  return run(process.execPath, [tsxCli, script], workspace, env);
}

function expectArtifactsAndSnapshot(tmp: string, snapshotPrefix: string): void {
  const artifactsDir = path.join(tmp, 'artifacts');
  expect(fs.existsSync(artifactsDir)).toBe(true);

  const resultPath = path.join(artifactsDir, 'review_diff_result.json');
  const sarifPath = path.join(artifactsDir, 'review_diff.sarif');
  const mdPath = path.join(artifactsDir, 'review_diff.md');

  expect(fs.existsSync(resultPath)).toBe(true);
  expect(fs.existsSync(sarifPath)).toBe(true);
  expect(fs.existsSync(mdPath)).toBe(true);

  const normalized = normalizeReviewDiffResult(readJson(resultPath));
  expect(JSON.stringify(normalized, null, 2)).toMatchSnapshot(`${snapshotPrefix} review_diff_result.json (normalized)`);

  const sarif = readJson(sarifPath);
  expect(JSON.stringify(sarif, null, 2)).toMatchSnapshot(`${snapshotPrefix} review_diff.sarif`);

  const md = readUtf8(mdPath);
  expect(md).toMatchSnapshot(`${snapshotPrefix} review_diff.md`);
}

describe('CI artifacts: scripts/ci/review-diff.ts (deterministic, LLM-off)', () => {
  it(
    'produces stable review_diff_result.json + sarif + markdown for a simple invariant violation',
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ci-artifacts-'));

      // Create a minimal repository with deterministic changes.
      sh('git', ['init'], tmp);
      sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
      sh('git', ['config', 'user.name', 'CI'], tmp);

      writeFile(
        path.join(tmp, '.review-invariants.yml'),
        [
          'security:',
          '  - id: SEC001',
          '    rule: "No eval() usage in source code"',
          '    paths: ["src/**"]',
          '    severity: CRITICAL',
          '    category: security',
          '    action: deny',
          '    deny: { regex: { pattern: "\\\\beval\\\\(" } }',
          '',
        ].join('\n')
      );

      writeFile(
        path.join(tmp, 'src/a.ts'),
        ['export function a() {', '  return 1;', '}', ''].join('\n')
      );

      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'base'], tmp);
      const baseSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      // Introduce an invariant violation (added line contains eval()).
      writeFile(
        path.join(tmp, 'src/a.ts'),
        ['export function a() {', '  eval("1+1");', '  return 1;', '}', ''].join('\n')
      );
      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'head'], tmp);
      const headSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      // Run the same script CI runs, but in this isolated workspace.
      // Ensure artifacts from previous runs aren't present.
      fs.rmSync(path.join(tmp, 'artifacts'), { recursive: true, force: true });

      const execRes = runCiScript(tmp, {
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        CE_REVIEW_ENABLE_LLM: 'false',
        CE_REVIEW_INCLUDE_SARIF: 'true',
        CE_REVIEW_INCLUDE_MARKDOWN: 'true',
        CE_REVIEW_FAIL_ON_SEVERITY: 'CRITICAL',
      });
      // This fixture intentionally violates a CRITICAL invariant; CI gate should fail (exit 1).
      expect(execRes.status).toBe(1);

      expectArtifactsAndSnapshot(tmp, '[FAIL/invariant]');
    },
    60_000
  );

  it(
    'produces stable artifacts for a PASS case (no invariant violations)',
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ci-artifacts-pass-'));

      sh('git', ['init'], tmp);
      sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
      sh('git', ['config', 'user.name', 'CI'], tmp);

      // Keep invariants, but do not violate them.
      writeFile(
        path.join(tmp, '.review-invariants.yml'),
        [
          'security:',
          '  - id: SEC001',
          '    rule: "No eval() usage in source code"',
          '    paths: ["src/**"]',
          '    severity: CRITICAL',
          '    category: security',
          '    action: deny',
          '    deny: { regex: { pattern: "\\\\beval\\\\(" } }',
          '',
        ].join('\n')
      );

      writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'base'], tmp);
      const baseSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 2;', ''].join('\n'));
      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'head'], tmp);
      const headSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      fs.rmSync(path.join(tmp, 'artifacts'), { recursive: true, force: true });
      const execRes = runCiScript(tmp, {
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        CE_REVIEW_ENABLE_LLM: 'false',
        CE_REVIEW_INCLUDE_SARIF: 'true',
        CE_REVIEW_INCLUDE_MARKDOWN: 'true',
        CE_REVIEW_FAIL_ON_SEVERITY: 'CRITICAL',
      });
      expect(execRes.status).toBe(0);

      expectArtifactsAndSnapshot(tmp, '[PASS/invariants-present]');
    },
    60_000
  );

  it(
    'produces stable artifacts when no invariants file exists (invariants skipped)',
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ci-artifacts-noinv-'));

      sh('git', ['init'], tmp);
      sh('git', ['config', 'user.email', 'ci@example.com'], tmp);
      sh('git', ['config', 'user.name', 'CI'], tmp);

      // No .review-invariants.yml on purpose.
      writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 1;', ''].join('\n'));
      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'base'], tmp);
      const baseSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      writeFile(path.join(tmp, 'src/a.ts'), ['export const a = 2;', ''].join('\n'));
      sh('git', ['add', '.'], tmp);
      sh('git', ['commit', '-m', 'head'], tmp);
      const headSha = sh('git', ['rev-parse', 'HEAD'], tmp).trim();

      fs.rmSync(path.join(tmp, 'artifacts'), { recursive: true, force: true });
      const execRes = runCiScript(tmp, {
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        CE_REVIEW_ENABLE_LLM: 'false',
        CE_REVIEW_INCLUDE_SARIF: 'true',
        CE_REVIEW_INCLUDE_MARKDOWN: 'true',
        CE_REVIEW_FAIL_ON_SEVERITY: 'CRITICAL',
      });
      expect(execRes.status).toBe(0);

      expectArtifactsAndSnapshot(tmp, '[PASS/no-invariants]');
    },
    60_000
  );
});
