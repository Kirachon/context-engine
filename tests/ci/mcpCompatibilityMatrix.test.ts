import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type MatrixSurface = {
  id: string;
  label: string;
  tests: string[];
  scripts?: string[];
};

type McpCompatibilityMatrixConfig = {
  version: number;
  default_log_path: string;
  default_json_path: string;
  surfaces: MatrixSurface[];
};

const REPO_ROOT = process.cwd();
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'ci', 'mcp-compatibility-matrix.json');
const REQUIRED_SURFACE_IDS = [
  'structured-outputs',
  'resources',
  'policy',
  'tasks',
  'auth',
  'roots',
  'evals',
] as const;

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function runMatrixScript(args: string[] = []): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'run-mcp-compatibility-matrix.ts');
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

describe('config/ci/mcp-compatibility-matrix.json', () => {
  it('pins the S9B compatibility surfaces and receipt paths', () => {
    const config = readJson<McpCompatibilityMatrixConfig>(CONFIG_PATH);
    const packageJson = readJson<{ scripts?: Record<string, string> }>(
      path.join(REPO_ROOT, 'package.json')
    );

    expect(config.version).toBe(1);
    expect(config.default_log_path).toBe(
      'docs/rollout-evidence/2026-05-31/mcp-compatibility-matrix.log'
    );
    expect(config.default_json_path).toBe('artifacts/bench/mcp-compatibility-matrix.json');
    expect(config.surfaces.map((surface) => surface.id)).toEqual([...REQUIRED_SURFACE_IDS]);
    expect(packageJson.scripts?.['ci:check:mcp-compatibility-matrix']).toEqual(
      expect.stringContaining('run-mcp-compatibility-matrix.ts')
    );

    for (const surface of config.surfaces) {
      for (const testPath of surface.tests) {
        expect(fs.existsSync(path.join(REPO_ROOT, testPath))).toBe(true);
      }
      for (const scriptPath of surface.scripts ?? []) {
        expect(fs.existsSync(path.join(REPO_ROOT, scriptPath))).toBe(true);
      }
    }
  });
});

describe('scripts/ci/run-mcp-compatibility-matrix.ts', () => {
  it('supports dry-run mode without executing checks', () => {
    const result = runMatrixScript(['--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MCP compatibility matrix (dry run)');
    for (const surfaceId of REQUIRED_SURFACE_IDS) {
      expect(result.stdout).toContain(`[surface] ${surfaceId}:`);
    }
  });

  it('writes template evidence artifacts with pass/fail matrix markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mcp-compat-template-'));
    const logPath = path.join(tmpDir, 'mcp-compatibility-matrix.log');
    const jsonPath = path.join(tmpDir, 'mcp-compatibility-matrix.json');

    const result = runMatrixScript([
      '--write-template',
      '--log',
      logPath,
      '--json',
      jsonPath,
    ]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);

    const logText = fs.readFileSync(logPath, 'utf8');
    const artifact = readJson<{
      status: string;
      summary: {
        surfaces_total: number;
        checks_total: number;
      };
      surfaces: Array<{ id: string; status: string; checks: Array<{ status: string }> }>;
    }>(jsonPath);

    expect(logText).toContain('MCP compatibility release gate (S9B)');
    expect(logText).toContain('mode=template');
    expect(logText).toContain('status=PASS');
    expect(logText).toContain('[surface] structured-outputs:');
    expect(logText).toContain('[surface] evals:');
    expect(logText).toContain('PASS jest:');
    expect(logText).toContain('PASS script:scripts/ci/run-mcp-eval-smoke.ts');
    expect(logText).toContain('MCP compatibility matrix passed.');

    expect(artifact.status).toBe('PASS');
    expect(artifact.summary.surfaces_total).toBe(REQUIRED_SURFACE_IDS.length);
    expect(artifact.summary.checks_total).toBeGreaterThan(REQUIRED_SURFACE_IDS.length);
    expect(artifact.surfaces.every((surface) => surface.status === 'pass')).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
