import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runVersionCheck(cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = path.join(process.cwd(), 'scripts', 'ci', 'check-version-literals.ts');
  const res = spawnSync(process.execPath, [tsxCli, scriptPath], {
    cwd,
    env: { ...process.env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function seedWorkspace(tmpRoot: string, versions: { packageVersion: string; manifestVersion: string; reviewDiffVersion: string }): void {
  writeFile(
    path.join(tmpRoot, 'package.json'),
    JSON.stringify({ name: 'tmp', version: versions.packageVersion }, null, 2)
  );

  writeFile(
    path.join(tmpRoot, 'src', 'mcp', 'tools', 'manifest.ts'),
    [
      `export const MCP_SERVER_VERSION = '${versions.manifestVersion}';`,
      '',
    ].join('\n')
  );

  writeFile(
    path.join(tmpRoot, 'src', 'reviewer', 'reviewDiff.ts'),
    [
      `const TOOL_VERSION = '${versions.reviewDiffVersion}';`,
      'export {};',
      '',
    ].join('\n')
  );
}

describe('scripts/ci/check-version-literals.ts', () => {
  it('passes when required version literals match package.json version', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-version-literals-pass-'));
    seedWorkspace(tmp, {
      packageVersion: '1.9.0',
      manifestVersion: '1.9.0',
      reviewDiffVersion: '1.9.0',
    });

    const result = runVersionCheck(tmp);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Version literal consistency check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required version literal differs from package.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-version-literals-fail-'));
    seedWorkspace(tmp, {
      packageVersion: '1.9.0',
      manifestVersion: '1.9.0',
      reviewDiffVersion: '1.8.9',
    });

    const result = runVersionCheck(tmp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Version literal consistency check failed.');
    expect(result.stderr).toContain('reviewDiff.ts (TOOL_VERSION) expected 1.9.0 but found 1.8.9');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
