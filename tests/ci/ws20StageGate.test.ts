import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf-8');
}

function runWs20Gate(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'ws20-stage-gate.ts');
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

describe('scripts/ci/ws20-stage-gate.ts', () => {
  it('passes a valid controlled ramp artifact', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws20-pass-'));
    const artifactPath = path.join(tmp, 'ws20-stage.yaml');

    writeText(
      artifactPath,
      [
        'schema_version: 1',
        'rollout_id: CE-WS20-PASS-01',
        'stage: 2',
        'stage_name: controlled_ramp',
        'controlled_ramp:',
        '  checkpoints:',
        '    - percent: 10',
        '      soak_hours: 24',
        '      status: pass',
        '      signed_by: ops.owner',
        '      evidence_ref: logs/ramp-10',
        '    - percent: 25',
        '      soak_hours: 48',
        '      status: pass',
        '      signed_by: ops.owner',
        '      evidence_ref: logs/ramp-25',
        '    - percent: 50',
        '      soak_hours: 72',
        '      status: pass',
        '      signed_by: ops.owner',
        '      evidence_ref: logs/ramp-50',
      ].join('\n')
    );

    const result = runWs20Gate(['--artifact', artifactPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS checkpoint_10_exists');
    expect(result.stdout).toContain('PASS checkpoint_25_soak');
    expect(result.stdout).toContain('WS20 stage gate passed.');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a required controlled ramp checkpoint is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws20-missing-checkpoint-'));
    const artifactPath = path.join(tmp, 'ws20-stage.yaml');

    writeText(
      artifactPath,
      [
        'rollout_id: CE-WS20-FAIL-01',
        'stage: 2',
        'stage_name: controlled_ramp',
        'controlled_ramp:',
        '  checkpoints:',
        '    - percent: 10',
        '      soak_hours: 24',
        '      status: pass',
        '      signed_by: ops.owner',
        '      evidence_ref: logs/ramp-10',
        '    - percent: 50',
        '      soak_hours: 72',
        '      status: pass',
        '      signed_by: ops.owner',
        '      evidence_ref: logs/ramp-50',
      ].join('\n')
    );

    const result = runWs20Gate(['--artifact', artifactPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL checkpoint_25_exists');
    expect(result.stderr).toContain('WS20 stage gate failed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails canary stage when soak is below minimum', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws20-canary-soak-'));
    const artifactPath = path.join(tmp, 'ws20-stage.yaml');

    writeText(
      artifactPath,
      [
        'rollout_id: CE-WS20-FAIL-02',
        'stage: 1',
        'stage_name: canary',
        'canary:',
        '  percent: 3',
        '  soak_hours: 12',
        '  exit_criteria_met: true',
        '  signed_by: ops.owner',
        '  evidence_ref: logs/canary',
      ].join('\n')
    );

    const result = runWs20Gate(['--artifact', artifactPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL canary_min_soak_24h');
    expect(result.stderr).toContain('WS20 stage gate failed');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns usage/parse error on malformed artifact input', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ws20-parse-error-'));
    const artifactPath = path.join(tmp, 'bad.yaml');

    writeText(artifactPath, 'rollout_id: [broken');

    const result = runWs20Gate(['--artifact', artifactPath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Failed to parse artifact');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
