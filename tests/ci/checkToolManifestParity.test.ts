import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runParityScript(cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = path.join(process.cwd(), 'scripts', 'ci', 'check-tool-manifest-parity.ts');
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

function seedWorkspace(tmpRoot: string, manifestSource: string): void {
  const serverSource = [
    'const runtime = [',
    "  findToolByName(registry, 'tool_alpha'),",
    "  findToolByName(registry, 'tool_beta'),",
    '];',
    '',
  ].join('\n');

  writeFile(path.join(tmpRoot, 'src', 'mcp', 'server.ts'), serverSource);
  writeFile(path.join(tmpRoot, 'src', 'mcp', 'tools', 'manifest.ts'), manifestSource);
}

describe('scripts/ci/check-tool-manifest-parity.ts', () => {
  it('passes when manifest tools[] is formatted differently and has no features block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-tool-manifest-parity-pass-'));
    const manifestSource = [
      'const manifest = {',
      "  version: 'test',",
      '  tools',
      '  :',
      '  [',
      "    'tool_alpha',",
      "    'tool_beta',",
      '  ],',
      "  metadata: { note: 'features intentionally omitted' },",
      '};',
      '',
    ].join('\n');

    seedWorkspace(tmp, manifestSource);
    const result = runParityScript(tmp);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Tool manifest parity check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails with parse error when manifest tools[] is malformed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-tool-manifest-parity-malformed-'));
    const malformedManifestSource = [
      'const manifest = {',
      '  tools: [',
      "    'tool_alpha',",
      "    'tool_beta',",
      '  // Missing closing bracket on purpose',
      "  metadata: { note: 'broken' },",
      '};',
      '',
    ].join('\n');

    seedWorkspace(tmp, malformedManifestSource);
    const result = runParityScript(tmp);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to parse tools[] block from manifest.ts');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
