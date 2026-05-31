import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildNormalizedFingerprint,
  normalizeForBaseline,
  stableStringify,
} from '../../evals/normalizeEvalOutput.js';
import {
  resolveDefaultMcpEvalSmokePaths,
  runMcpEvalSmoke,
  writeMcpEvalSmokeArtifacts,
} from '../../evals/runSmokeEvals.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const BASELINE_PATH = path.join(REPO_ROOT, 'evals', 'baseline', 'mcp-eval-smoke.normalized.json');

function runSmokeScript(args: string[] = []): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'run-mcp-eval-smoke.ts');
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('mcp eval smoke harness', () => {
  it('produces deterministic normalized output across repeated runs', () => {
    const paths = resolveDefaultMcpEvalSmokePaths(REPO_ROOT);
    const first = runMcpEvalSmoke(paths);
    const second = runMcpEvalSmoke(paths);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(stableStringify(normalizeForBaseline(first.normalized))).toBe(
      stableStringify(normalizeForBaseline(second.normalized))
    );
  });

  it('matches the committed normalized baseline artifact', () => {
    const paths = resolveDefaultMcpEvalSmokePaths(REPO_ROOT);
    const result = runMcpEvalSmoke(paths);
    const normalizedText = stableStringify(normalizeForBaseline(result.normalized));
    const baselineText = fs.readFileSync(BASELINE_PATH, 'utf8').trim();

    expect(normalizedText).toBe(baselineText);
    expect(result.fingerprint).toBe(buildNormalizedFingerprint(JSON.parse(baselineText)));
  });

  it('writes raw and normalized artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mcp-eval-smoke-'));
    const paths = resolveDefaultMcpEvalSmokePaths(REPO_ROOT);
    const result = runMcpEvalSmoke(paths);
    const { rawPath, normalizedPath } = writeMcpEvalSmokeArtifacts(tmpDir, result);

    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(normalizedPath)).toBe(true);
    expect(fs.readFileSync(normalizedPath, 'utf8').trim()).toBe(
      stableStringify(normalizeForBaseline(result.normalized))
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs informational smoke script without failing on baseline match', () => {
    const result = runSmokeScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_mode=informational');
    expect(result.stdout).toContain('baseline_match=yes');
  });

  it('documents informational gate mode in eval manifest', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'evals', 'manifest.json'), 'utf8')
    ) as { gate_mode?: string; npm_script?: string; sections?: string[] };
    expect(manifest.gate_mode).toBe('informational');
    expect(manifest.npm_script).toBe('ci:check:mcp-eval-smoke');
    expect(manifest.sections).toEqual(
      expect.arrayContaining(['retrieval', 'safety', 'usefulness', 'performance'])
    );
  });

  it('includes expanded eval sections with passing summary', () => {
    const paths = resolveDefaultMcpEvalSmokePaths(REPO_ROOT);
    const result = runMcpEvalSmoke(paths);

    expect(result.normalized.schema_version).toBe(2);
    expect(result.normalized.safety.case_count).toBeGreaterThan(0);
    expect(result.normalized.usefulness.case_count).toBeGreaterThan(0);
    expect(result.normalized.performance.check_count).toBeGreaterThan(0);
    expect(result.normalized.summary.status).toBe('pass');
  });
});
