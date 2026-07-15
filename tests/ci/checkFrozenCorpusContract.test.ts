import { describe, expect, it, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  cloneContract,
  computeLanesFingerprint,
  type FrozenCorpusContract,
  readJson,
} from '../../scripts/ci/lib/frozenCorpusContract';

const CONTRACT_PATH = 'config/ci/q3a-frozen-corpus-contract.json';
const DEFAULT_TEST_OUT = path.join(os.tmpdir(), `context-engine-frozen-corpus-check-${process.pid}.json`);

function writeContract(filePath: string, contract: FrozenCorpusContract): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contract, null, 2), 'utf-8');
}

function copyFrozenCorpora(destDir: string): void {
  const srcDir = path.join(process.cwd(), 'config', 'ci', 'frozen-corpora');
  const destCorporaDir = path.join(destDir, 'config', 'ci', 'frozen-corpora');
  fs.mkdirSync(destCorporaDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, name), path.join(destCorporaDir, name));
  }
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-frozen-corpus-contract.ts');
  const effectiveArgs = args.includes('--out') ? args : [...args, '--out', DEFAULT_TEST_OUT];
  const res = spawnSync(process.execPath, [tsxCli, script, ...effectiveArgs], {
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

describe('scripts/ci/check-frozen-corpus-contract.ts', () => {
  const baseContract = readJson<FrozenCorpusContract>(CONTRACT_PATH);
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for the real, unmodified contract and pinned corpora', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-real-contract-'));
    const outPath = path.join(tmpDir, 'q3a-frozen-corpus-contract-check.json');
    const result = runChecker(['--contract', CONTRACT_PATH, '--out', outPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Frozen corpus contract validation passed.');
    expect(result.stdout).toContain('lanes=7 version=1');
  });

  it('fails when a pinned corpus file on disk drifts from its pinned content hash', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-drift-'));
    copyFrozenCorpora(tmpDir);
    const contract = cloneContract(baseContract);
    const contractPath = path.join(tmpDir, 'q3a-frozen-corpus-contract.json');
    writeContract(contractPath, contract);

    const corpusPath = path.join(tmpDir, 'config', 'ci', 'frozen-corpora', 'pr-corpus.json');
    const original = fs.readFileSync(corpusPath, 'utf8');
    const drifted = JSON.parse(original);
    drifted.cases.push({
      id: 'pr-injected-case',
      query: 'unauthorized case injected after freeze',
      language: 'typescript',
      labels: ['fast-path'],
      intended_lane: 'pr',
    });
    fs.writeFileSync(corpusPath, JSON.stringify(drifted, null, 2), 'utf8');

    const result = runChecker(['--contract', contractPath, '--base-dir', tmpDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lane "pr": corpus content hash mismatch');
  });

  it('fails when thresholds are mutated in the contract without a version bump', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-threshold-mutation-'));
    copyFrozenCorpora(tmpDir);
    const contract = cloneContract(baseContract);
    contract.lanes.ambiguity.thresholds.min_precision_pct = 10;
    // version and version_ledger deliberately left as-is to simulate an unauthorized edit.
    const contractPath = path.join(tmpDir, 'q3a-frozen-corpus-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath, '--base-dir', tmpDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its frozen version_ledger fingerprint');
  });

  it('passes when thresholds are mutated together with a correctly frozen version bump', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-threshold-bump-'));
    copyFrozenCorpora(tmpDir);
    const contract = cloneContract(baseContract);
    contract.lanes.ambiguity.thresholds.min_precision_pct = 97;
    contract.version = 2;
    contract.version_ledger.push({
      version: 2,
      fingerprint_sha256: computeLanesFingerprint(contract),
      frozen_at_utc: '2026-08-01T00:00:00.000Z',
      note: 'Test-only: raised ambiguity min_precision_pct with a proper version bump.',
    });
    const contractPath = path.join(tmpDir, 'q3a-frozen-corpus-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath, '--base-dir', tmpDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Frozen corpus contract validation passed.');
  });

  it('fails when the contract omits a canonical lane', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-missing-lane-'));
    copyFrozenCorpora(tmpDir);
    const contract = cloneContract(baseContract);
    delete (contract.lanes as Record<string, unknown>).duplicate;
    const contractPath = path.join(tmpDir, 'q3a-frozen-corpus-contract.json');
    writeContract(contractPath, contract);

    const result = runChecker(['--contract', contractPath, '--base-dir', tmpDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must declare exactly the canonical lanes');
  });

  it('fails with a usage error when the contract file does not exist', () => {
    const result = runChecker(['--contract', 'config/ci/does-not-exist-q3a-contract.json']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('File not found');
  });

  it('writes a gate artifact recording lane detail and reasons', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-frozen-corpus-artifact-'));
    const outPath = path.join(tmpDir, 'out', 'q3a-frozen-corpus-contract-check.json');

    const result = runChecker(['--contract', CONTRACT_PATH, '--out', outPath]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(artifact.gate.status).toBe('pass');
    expect(artifact.contract_version).toBe(1);
    expect(artifact.lanes).toHaveLength(7);
  });
});
