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
  runMcpCompatibility,
  writeMcpCompatibilityArtifacts,
} from '../../evals/runCompatibilityEvals.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const BASELINE_PATH = path.join(REPO_ROOT, 'evals', 'baseline', 'mcp-compatibility.normalized.json');

function runCompatibilityScript(args: string[] = []): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'run-mcp-compatibility.ts');
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

describe('mcp compatibility gate', () => {
  it('produces deterministic normalized output across repeated runs', () => {
    const first = runMcpCompatibility(REPO_ROOT);
    const second = runMcpCompatibility(REPO_ROOT);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(stableStringify(normalizeForBaseline(first.normalized))).toBe(
      stableStringify(normalizeForBaseline(second.normalized))
    );
  });

  it('matches the committed normalized baseline artifact', () => {
    const result = runMcpCompatibility(REPO_ROOT);
    const normalizedText = stableStringify(normalizeForBaseline(result.normalized));
    const baselineText = fs.readFileSync(BASELINE_PATH, 'utf8').trim();

    expect(normalizedText).toBe(baselineText);
    expect(result.fingerprint).toBe(buildNormalizedFingerprint(JSON.parse(baselineText)));
  });

  it('writes compatibility and smoke artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mcp-compat-'));
    const result = runMcpCompatibility(REPO_ROOT);
    const paths = writeMcpCompatibilityArtifacts(tmpDir, result);

    expect(fs.existsSync(paths.rawPath)).toBe(true);
    expect(fs.existsSync(paths.normalizedPath)).toBe(true);
    expect(fs.existsSync(paths.smokeRawPath)).toBe(true);
    expect(fs.existsSync(paths.smokeNormalizedPath)).toBe(true);
    expect(fs.readFileSync(paths.normalizedPath, 'utf8').trim()).toBe(
      stableStringify(normalizeForBaseline(result.normalized))
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs informational compatibility script without failing on baseline match', () => {
    const result = runCompatibilityScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate_mode=informational');
    expect(result.stdout).toContain('baseline_match=yes');
    expect(result.stdout).toContain('tool_manifest_parity=pass');
  });

  it('documents informational gate mode in compatibility manifest', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'evals', 'compatibility-manifest.json'), 'utf8')
    ) as { gate_mode?: string; npm_script?: string };
    expect(manifest.gate_mode).toBe('informational');
    expect(manifest.npm_script).toBe('ci:check:mcp-compatibility');
  });

  it('includes expanded eval smoke sections in compatibility output', () => {
    const result = runMcpCompatibility(REPO_ROOT);
    expect(result.normalized.eval_smoke.sections).toEqual(
      expect.objectContaining({
        retrieval: 'pass',
        context_packs: 'pass',
        safety: 'pass',
        usefulness: 'pass',
        performance: 'pass',
      })
    );
    expect(result.normalized.compatibility.tool_manifest_parity.status).toBe('pass');
  });
});
