import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-retrieval-holdout-fixture.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/ci/check-retrieval-holdout-fixture.ts', () => {
  it('passes for valid fixture with zero leakage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-pass-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'holdout-check.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query', 'beta query'] },
          holdout_v1: { queries: ['gamma query', 'delta query'] },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=pass');
    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const gate = artifact.gate as Record<string, unknown>;
    expect(gate.status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns usage/parsing error when selected dataset mismatches leakage guard holdout dataset', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-mismatch-'));
    const fixturePath = path.join(tmp, 'fixture.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query', 'beta query'] },
          holdout_v1: { queries: ['gamma query', 'delta query'] },
          holdout_v2: { queries: ['epsilon query', 'zeta query'] },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--dataset-id', 'holdout_v2']);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/must match leakage_guard\.holdout_dataset_id/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails validation for unsupported normalization mode', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-normalization-'));
    const fixturePath = path.join(tmp, 'fixture.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query'] },
          holdout_v1: { queries: ['beta query'] },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
          normalization: 'custom_mode',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unsupported normalization mode/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails validation when fixture contains non-string query entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-non-string-'));
    const fixturePath = path.join(tmp, 'fixture.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query'] },
          holdout_v1: { queries: ['beta query', 123] },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
          normalization: 'trim_lower_whitespace_collapse',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/contains non-string query entries/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
