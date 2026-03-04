import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-ws21-rollback-drill.ts');
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

function writeLog(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('scripts/ci/check-ws21-rollback-drill.ts', () => {
  it('passes for valid WS21 drill evidence fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws21-pass-'));
    const logPath = path.join(tmp, 'ws21.md');
    writeLog(
      logPath,
      [
        'Log ID: WS21-20260228-001',
        'rollback_event: canary_latency_regression',
        'Command Path: cmd1 -> cmd2 -> cmd3',
        'Owner: rollout-owner',
        'Started At (UTC): 2026-02-28T08:00:00Z',
        'Ended At (UTC): 2026-02-28T08:05:00Z',
        'RTO Target Minutes: 15',
        'RTO Actual Minutes: 5',
        'RTO Evidence: artifacts/ws21/rto-proof.log',
        'Recovery Evidence: artifacts/ws21/recovery.log',
        'Blocker Status: none',
      ].join('\n')
    );

    const result = runChecker([logPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('WS21 evidence check passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when required fields are missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws21-missing-'));
    const logPath = path.join(tmp, 'ws21.md');
    writeLog(
      logPath,
      [
        'Log ID: WS21-20260228-002',
        'rollback_event: gate_breach',
        'Command Path: cmd1 -> cmd2',
        'Owner: rollout-owner',
        'Started At (UTC): 2026-02-28T08:00:00Z',
        'Ended At (UTC): 2026-02-28T08:03:00Z',
        'RTO Target Minutes: 15',
        'RTO Actual Minutes: 3',
        'RTO Evidence: artifacts/ws21/rto-proof.log',
        'Blocker Status: none',
      ].join('\n')
    );

    const result = runChecker([logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Missing required field: Recovery Evidence');
    expect(result.stderr).toContain('WS21 evidence check failed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails on invalid timestamp ordering', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws21-time-'));
    const logPath = path.join(tmp, 'ws21.md');
    writeLog(
      logPath,
      [
        'rollback_event: canary_failure',
        'Command Path: cmd1 -> cmd2',
        'Owner: rollout-owner',
        'Started At (UTC): 2026-02-28T08:10:00Z',
        'Ended At (UTC): 2026-02-28T08:05:00Z',
        'RTO Target Minutes: 15',
        'RTO Actual Minutes: 6',
        'RTO Evidence: artifacts/ws21/rto-proof.log',
        'Recovery Evidence: artifacts/ws21/recovery.log',
        'Blocker Status: none',
      ].join('\n')
    );

    const result = runChecker([logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'Ended At (UTC) must be greater than or equal to Started At (UTC).'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when blocker status is unresolved (open)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws21-blocker-open-'));
    const logPath = path.join(tmp, 'ws21.md');
    writeLog(
      logPath,
      [
        'rollback_event: incident_failover',
        'Command Path: cmd1 -> cmd2',
        'Owner: rollout-owner',
        'Started At (UTC): 2026-02-28T08:00:00Z',
        'Ended At (UTC): 2026-02-28T08:05:00Z',
        'RTO Target Minutes: 15',
        'RTO Actual Minutes: 5',
        'RTO Evidence: artifacts/ws21/rto-proof.log',
        'Recovery Evidence: artifacts/ws21/recovery.log',
        'Blocker Status: open',
      ].join('\n')
    );

    const result = runChecker([logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Blocker Status indicates unresolved blocker (open).');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when RTO actual exceeds target', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws21-rto-breach-'));
    const logPath = path.join(tmp, 'ws21.md');
    writeLog(
      logPath,
      [
        'rollback_event: rollback_drill_timeout',
        'Command Path: cmd1 -> cmd2',
        'Owner: rollout-owner',
        'Started At (UTC): 2026-02-28T08:00:00Z',
        'Ended At (UTC): 2026-02-28T08:30:00Z',
        'RTO Target Minutes: 15',
        'RTO Actual Minutes: 30',
        'RTO Evidence: artifacts/ws21/rto-proof.log',
        'Recovery Evidence: artifacts/ws21/recovery.log',
        'Blocker Status: none',
      ].join('\n')
    );

    const result = runChecker([logPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'RTO Actual Minutes must be less than or equal to RTO Target Minutes.'
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
