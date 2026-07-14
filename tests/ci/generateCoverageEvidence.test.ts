import { describe, expect, it, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

interface FixtureContractOptions {
  branchesPct?: number;
  omitLcov?: boolean;
  omitSummary?: boolean;
  thresholds?: { global: Record<string, number> };
}

function runScript(scriptName: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', scriptName);
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function writeFixtureContract(tmpDir: string, options: FixtureContractOptions = {}): string {
  const lcovPath = path.join(tmpDir, 'lcov.info');
  const summaryPath = path.join(tmpDir, 'coverage-summary.json');
  const evidencePath = path.join(tmpDir, 'coverage-evidence.json');
  const contractPath = path.join(tmpDir, 'coverage-threshold-contract.json');

  if (!options.omitLcov) {
    fs.writeFileSync(lcovPath, 'TN:\nSF:src/example.ts\nLF:10\nLH:9\nend_of_record\n', 'utf8');
  }
  if (!options.omitSummary) {
    const branchesPct = options.branchesPct ?? 80;
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        total: {
          branches: { pct: branchesPct },
          functions: { pct: 80 },
          lines: { pct: 80 },
        },
      }),
      'utf8'
    );
  }

  const thresholds = options.thresholds ?? { global: { branches: 70, functions: 75, lines: 75 } };
  fs.writeFileSync(
    contractPath,
    JSON.stringify(
      {
        version: 1,
        thresholds,
        lcov_path: lcovPath,
        summary_path: summaryPath,
        evidence_path: evidencePath,
      },
      null,
      2
    ),
    'utf8'
  );

  return contractPath;
}

describe('scripts/ci/generate-coverage-evidence.ts', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a passing evidence envelope when coverage meets every declared threshold', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-evidence-pass-'));
    const contractPath = writeFixtureContract(tmpDir);

    const result = runScript('generate-coverage-evidence.ts', ['--contract', contractPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=pass');

    const evidence = JSON.parse(fs.readFileSync(path.join(tmpDir, 'coverage-evidence.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((evidence.gate as { status: string }).status).toBe('pass');
    expect(evidence.lcov_path).toBe(path.join(tmpDir, 'lcov.info'));
    expect(typeof evidence.commit_sha).toBe('string');
    expect(typeof evidence.config_hash).toBe('string');
  });

  it('fails and never writes an evidence envelope when the LCOV report is missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-evidence-missing-lcov-'));
    const contractPath = writeFixtureContract(tmpDir, { omitLcov: true });

    const result = runScript('generate-coverage-evidence.ts', ['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing LCOV report');
    expect(fs.existsSync(path.join(tmpDir, 'coverage-evidence.json'))).toBe(false);
  });

  it('fails when measured coverage is below a declared threshold, even though jest already ran', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-evidence-below-threshold-'));
    const contractPath = writeFixtureContract(tmpDir, { branchesPct: 40 });

    const result = runScript('generate-coverage-evidence.ts', ['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is 40% which is below the required 70%');
    // Evidence is still written (append-only, non-silent) but marked failing.
    const evidence = JSON.parse(fs.readFileSync(path.join(tmpDir, 'coverage-evidence.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((evidence.gate as { status: string }).status).toBe('fail');
  });

  it('exits with a usage error when the contract file does not exist', () => {
    const result = runScript('generate-coverage-evidence.ts', ['--contract', 'config/ci/does-not-exist.json']);
    expect(result.status).toBe(2);
  });
});
