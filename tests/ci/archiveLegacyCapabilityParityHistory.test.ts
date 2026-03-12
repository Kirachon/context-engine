import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runArchive(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'archive-legacy-capability-parity-history.ts');
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
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

describe('scripts/ci/archive-legacy-capability-parity-history.ts', () => {
  it('copies the current gate artifact into history using generated_at timestamp', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-capability-parity-archive-'));
    const artifactPath = path.join(tmp, 'gate.json');
    const historyDir = path.join(tmp, 'history');

    writeJson(artifactPath, {
      generated_at: '2026-03-11T13:30:00.123Z',
      gate: { status: 'pass' },
    });

    const result = runArchive(['--artifact', artifactPath, '--history-dir', historyDir, '--prefix', 'sample'], tmp);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('archived=');

    const files = fs.readdirSync(historyDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('sample-2026-03-11T13-30-00-123Z.json');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});


