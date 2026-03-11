import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runCheck(cwd: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = path.join(process.cwd(), 'scripts', 'ci', 'check-auggie-no-legacy-references.ts');
  const result = spawnSync(process.execPath, [tsxCli, scriptPath, ...args], {
    cwd,
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

describe('scripts/ci/check-auggie-no-legacy-references.ts', () => {
  it('passes on a clean temp fixture', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-legacy-clean-'));
    writeFile(path.join(tmp, 'src', 'clean.ts'), 'export const clean = true;\n');

    const result = runCheck(tmp, ['--roots', 'src']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No-legacy Auggie reference check passed.');
    expect(result.stdout).toContain('violations=0');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails on blocked pattern in non-allowlisted file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-legacy-fail-'));
    writeFile(path.join(tmp, 'src', 'bad.ts'), 'const flag = "DirectContext";\n');

    const result = runCheck(tmp, ['--roots', 'src']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No-legacy Auggie reference check failed.');
    expect(result.stderr).toContain('src/bad.ts:1:DirectContext');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes when blocked pattern exists in allowlisted file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-legacy-allow-'));
    writeFile(path.join(tmp, 'src', 'bad.ts'), 'const legacy = "augment_legacy";\n');
    writeFile(path.join(tmp, 'allowlist.txt'), '# intentionally allow temp fixture\nsrc/bad.ts\n');

    const result = runCheck(tmp, ['--roots', 'src', '--allowlist', 'allowlist.txt']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No-legacy Auggie reference check passed.');
    expect(result.stdout).toContain('allowlisted_files=1');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports allowlist directory prefixes via /** patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-legacy-allow-prefix-'));
    writeFile(path.join(tmp, 'docs', 'legacy-note.md'), 'uses @augmentcode/auggie-sdk for archived context\n');
    writeFile(path.join(tmp, 'allowlist.txt'), 'docs/**\n');

    const result = runCheck(tmp, ['--roots', 'docs', '--allowlist', 'allowlist.txt']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No-legacy Auggie reference check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports mixed roots and scans single files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-legacy-mixed-roots-'));
    writeFile(path.join(tmp, 'src', 'clean.ts'), 'export const ok = true;\n');
    writeFile(path.join(tmp, 'single.md'), 'CE_FORCE_LEGACY=true\n');

    const result = runCheck(tmp, ['--roots', 'src,single.md']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('single.md:1:CE_FORCE_LEGACY');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
