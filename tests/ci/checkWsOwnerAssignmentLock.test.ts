import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-ws-owner-assignment-lock.ts');
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

function writeDoc(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function validArtifactBody(): string {
  return [
    '# WS13-WS21 Owner Assignment Lock',
    '',
    '| stream | owner | assignment_date | approver |',
    '| --- | --- | --- | --- |',
    '| WS13 | ws13-owner | 2026-02-28 | approver-a |',
    '| WS14 | ws14-owner | 2026-02-28 | approver-a |',
    '| WS15 | ws15-owner | 2026-02-28 | approver-a |',
    '| WS16 | ws16-owner | 2026-02-28 | approver-a |',
    '| WS17 | ws17-owner | 2026-02-28 | approver-a |',
    '| WS18 | ws18-owner | 2026-02-28 | approver-a |',
    '| WS19 | ws19-owner | 2026-02-28 | approver-a |',
    '| WS20 | ws20-owner | 2026-02-28 | approver-a |',
    '| WS21 | ws21-owner | 2026-02-28 | approver-a |',
  ].join('\n');
}

describe('scripts/ci/check-ws-owner-assignment-lock.ts', () => {
  it('passes when all WS13-WS21 streams have concrete assignment metadata', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws-owner-lock-pass-'));
    const docPath = path.join(tmp, 'WS_OWNER_ASSIGNMENT_LOCK.md');
    writeDoc(docPath, validArtifactBody());

    const result = runChecker([docPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WS owner assignment lock check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required stream is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws-owner-lock-missing-'));
    const docPath = path.join(tmp, 'WS_OWNER_ASSIGNMENT_LOCK.md');
    writeDoc(docPath, validArtifactBody().replace('| WS21 | ws21-owner | 2026-02-28 | approver-a |', ''));

    const result = runChecker([docPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required stream row: WS21');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when owner uses placeholder value', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws-owner-lock-placeholder-'));
    const docPath = path.join(tmp, 'WS_OWNER_ASSIGNMENT_LOCK.md');
    writeDoc(
      docPath,
      validArtifactBody().replace(
        '| WS19 | ws19-owner | 2026-02-28 | approver-a |',
        '| WS19 | TBD | 2026-02-28 | approver-a |'
      )
    );

    const result = runChecker([docPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stream WS19: owner must be concrete');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when assignment_date is not YYYY-MM-DD', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws-owner-lock-date-'));
    const docPath = path.join(tmp, 'WS_OWNER_ASSIGNMENT_LOCK.md');
    writeDoc(
      docPath,
      validArtifactBody().replace(
        '| WS18 | ws18-owner | 2026-02-28 | approver-a |',
        '| WS18 | ws18-owner | 2026/02/28 | approver-a |'
      )
    );

    const result = runChecker([docPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Stream WS18: assignment_date must be YYYY-MM-DD (found: 2026/02/28)'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
