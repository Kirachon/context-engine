import { describe, expect, it, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

interface FixtureContractOptions {
  branchesPct?: number;
  thresholds?: { global: Record<string, number> };
}

interface FixturePaths {
  contractPath: string;
  lcovPath: string;
  summaryPath: string;
  evidencePath: string;
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

function writeFixtureContract(tmpDir: string, options: FixtureContractOptions = {}): FixturePaths {
  const lcovPath = path.join(tmpDir, 'lcov.info');
  const summaryPath = path.join(tmpDir, 'coverage-summary.json');
  const evidencePath = path.join(tmpDir, 'coverage-evidence.json');
  const contractPath = path.join(tmpDir, 'coverage-threshold-contract.json');

  fs.writeFileSync(lcovPath, 'TN:\nSF:src/example.ts\nLF:10\nLH:9\nend_of_record\n', 'utf8');
  const branchesPct = options.branchesPct ?? 80;
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ total: { branches: { pct: branchesPct }, functions: { pct: 80 }, lines: { pct: 80 } } }),
    'utf8'
  );

  const thresholds = options.thresholds ?? { global: { branches: 70, functions: 75, lines: 75 } };
  fs.writeFileSync(
    contractPath,
    JSON.stringify({ version: 1, thresholds, lcov_path: lcovPath, summary_path: summaryPath, evidence_path: evidencePath }, null, 2),
    'utf8'
  );

  return { contractPath, lcovPath, summaryPath, evidencePath };
}

describe('scripts/ci/check-coverage-evidence.ts', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when the evidence envelope truthfully reflects live coverage state', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-check-pass-'));
    const fixture = writeFixtureContract(tmpDir);

    const generated = runScript('generate-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(generated.status).toBe(0);

    const result = runScript('check-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('coverage_evidence_verified');
  });

  it('fails when no evidence envelope has been generated in this job/run', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-check-missing-evidence-'));
    const fixture = writeFixtureContract(tmpDir);

    const result = runScript('check-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Coverage evidence not found');
  });

  it('fails when the LCOV report disappears after evidence was generated', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-check-missing-lcov-'));
    const fixture = writeFixtureContract(tmpDir);

    const generated = runScript('generate-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(generated.status).toBe(0);

    fs.rmSync(fixture.lcovPath);

    const result = runScript('check-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing LCOV report');
  });

  it('fails when the LCOV report is regenerated with different content after evidence was built', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-check-stale-lcov-'));
    const fixture = writeFixtureContract(tmpDir);

    const generated = runScript('generate-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(generated.status).toBe(0);

    fs.writeFileSync(fixture.lcovPath, 'TN:\nSF:src/other.ts\nLF:5\nLH:5\nend_of_record\n', 'utf8');

    const result = runScript('check-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LCOV report content changed after evidence generation');
  });

  it('fails when the checked-in threshold contract changes after evidence was generated', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-coverage-check-mismatched-config-'));
    const fixture = writeFixtureContract(tmpDir);

    const generated = runScript('generate-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(generated.status).toBe(0);

    const contract = JSON.parse(fs.readFileSync(fixture.contractPath, 'utf8')) as {
      thresholds: { global: Record<string, number> };
    };
    contract.thresholds.global.branches = 90;
    fs.writeFileSync(fixture.contractPath, JSON.stringify(contract, null, 2), 'utf8');

    const result = runScript('check-coverage-evidence.ts', ['--contract', fixture.contractPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config_hash does not match the checked-in coverage-threshold-contract.json');
  });

  it('exits with a usage error when the contract file does not exist', () => {
    const result = runScript('check-coverage-evidence.ts', ['--contract', 'config/ci/does-not-exist.json']);
    expect(result.status).toBe(2);
  });
});
