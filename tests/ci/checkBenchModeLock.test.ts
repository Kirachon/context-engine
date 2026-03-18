import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const scriptPath = path.resolve('scripts/ci/check-bench-mode-lock.ts');

function runChecker(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    encoding: 'utf8',
  });
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

describe('check-bench-mode-lock', () => {
  it('passes for retrieve/search mode artifacts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mode-lock-pass-'));
    const baseline = path.join(tempDir, 'baseline.json');
    const candidate = path.join(tempDir, 'candidate.json');
    const out = path.join(tempDir, 'out.json');
    writeJson(baseline, { provenance: { bench_mode: 'retrieve' } });
    writeJson(candidate, { provenance: { bench_mode: 'retrieve' } });

    const result = runChecker([
      '--baseline',
      baseline,
      '--candidate',
      candidate,
      '--out',
      out,
      '--allow-modes',
      'retrieve,search',
    ]);

    expect(result.status).toBe(0);
    const artifact = JSON.parse(fs.readFileSync(out, 'utf8')) as { gate: { status: string } };
    expect(artifact.gate.status).toBe('pass');
  });

  it('fails when scan mode is used under retrieve/search lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mode-lock-fail-'));
    const baseline = path.join(tempDir, 'baseline.json');
    const candidate = path.join(tempDir, 'candidate.json');
    const out = path.join(tempDir, 'out.json');
    writeJson(baseline, { provenance: { bench_mode: 'scan' } });
    writeJson(candidate, { provenance: { bench_mode: 'scan' } });

    const result = runChecker([
      '--baseline',
      baseline,
      '--candidate',
      candidate,
      '--out',
      out,
      '--allow-modes',
      'retrieve,search',
    ]);

    expect(result.status).toBe(1);
    const artifact = JSON.parse(fs.readFileSync(out, 'utf8')) as { gate: { status: string; reasons: string[] } };
    expect(artifact.gate.status).toBe('fail');
    expect(artifact.gate.reasons.some((reason) => reason.includes('disallowed'))).toBe(true);
  });
});
