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
  const scriptPath = path.join(process.cwd(), 'scripts', 'ci', 'check-brand-detachment.ts');
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

describe('scripts/ci/check-brand-detachment.ts', () => {
  it('passes on a clean temp fixture', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brand-clean-'));
    writeFile(path.join(tmp, 'src', 'clean.ts'), 'export const clean = true;\n');

    const result = runCheck(tmp, ['--roots', 'src']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Brand detachment check passed.');
    expect(result.stdout).toContain('violations=0');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails on blocked pattern in non-allowlisted file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brand-fail-'));
    writeFile(path.join(tmp, 'src', 'bad.ts'), 'const legacy = "@augmentcode/auggie-sdk";\n');

    const result = runCheck(tmp, ['--roots', 'src']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Brand detachment check failed.');
    expect(result.stderr).toContain('src/bad.ts:1:@augmentcode/auggie-sdk');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes when blocked pattern exists in allowlisted file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brand-allow-'));
    writeFile(path.join(tmp, 'src', 'legacy.ts'), 'const legacy = "augment_legacy";\n');
    writeFile(path.join(tmp, 'allowlist.txt'), '# intentionally allow temp fixture\nsrc/legacy.ts\n');

    const result = runCheck(tmp, ['--roots', 'src', '--allowlist', 'allowlist.txt']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Brand detachment check passed.');
    expect(result.stdout).toContain('allowlisted_files=1');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports allowlist directory prefixes via /** patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brand-allow-prefix-'));
    writeFile(path.join(tmp, 'docs', 'legacy-note.md'), 'uses @augmentcode/auggie-sdk for archived context\n');
    writeFile(path.join(tmp, 'allowlist.txt'), 'docs/**\n');

    const result = runCheck(tmp, ['--roots', 'docs', '--allowlist', 'allowlist.txt']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Brand detachment check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
