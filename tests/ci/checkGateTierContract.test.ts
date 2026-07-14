import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { cloneContract, readJson, type Contract } from '../../scripts/ci/lib/gateTierContractValidator';

function writeContract(filePath: string, contract: Contract): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contract, null, 2), 'utf-8');
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-gate-tier-contract.ts');
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

describe('scripts/ci/check-gate-tier-contract.ts', () => {
  const baseContract = readJson<Contract>('config/ci/gate-tier-contract.json');
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for the real, unmodified gate-tier contract', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-pass-'));
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, baseContract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Gate-tier contract validation passed.');
  });

  it('fails when a gate references a missing package script', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-missing-script-'));
    const contract = cloneContract(baseContract);
    const build = contract.gates.find(({ id }) => id === 'build');
    expect(build).toBeDefined();
    build!.package_script = 'does-not-exist-script';
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('build: package script does not exist');
  });

  it('fails when a workflow execution references a missing job', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-missing-job-'));
    const contract = cloneContract(baseContract);
    contract.workflow_executions['review-mcp-smoke'].job = 'missing-job';
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review-mcp-smoke: workflow/job/step mapping does not exist');
    expect(result.stderr).toContain(
      'ci:check:mcp-smoke: workflow mapping inventory disagrees with live workflows'
    );
  });

  it('fails on an invalid lifecycle transition (unknown tier)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-unknown-tier-'));
    const contract = cloneContract(baseContract);
    const gate = contract.gates.find(({ id }) => id === 'bench:ci:nightly');
    expect(gate).toBeDefined();
    // @ts-expect-error deliberately invalid tier for the mutation fixture
    gate!.declared_tier = 'in_review';
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bench:ci:nightly: unknown declared tier');
  });

  it('fails on an invalid lifecycle transition (promoted while unwired)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-promoted-unwired-'));
    const contract = cloneContract(baseContract);
    const gate = contract.gates.find(({ id }) => id === 'ci:check:enhancement-error-taxonomy-report');
    expect(gate).toBeDefined();
    expect(gate!.workflow_status).toBe('unwired');
    gate!.declared_tier = 'calibrated';
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ci:check:enhancement-error-taxonomy-report: invalid lifecycle transition - an unwired gate cannot be promoted past report_only'
    );
  });

  it('fails on a false blocker declaration lacking verified external enforcement', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-tier-false-blocker-'));
    const contract = cloneContract(baseContract);
    const gate = contract.gates.find(({ id }) => id === 'ci:check:mcp-smoke');
    expect(gate).toBeDefined();
    gate!.declared_tier = 'pr_blocker';
    const contractPath = path.join(tmpDir, 'gate-tier-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ci:check:mcp-smoke: pr_blocker requires verified external branch protection'
    );
  });

  it('fails with a usage error when the contract file does not exist', () => {
    const result = runChecker(['--contract', 'config/ci/does-not-exist-contract.json']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Gate-tier contract not found');
  });
});
