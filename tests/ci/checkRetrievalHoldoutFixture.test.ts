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
          holdout_v1: {
            cases: [
              {
                id: 'holdout-1',
                query: 'gamma query',
                expected_paths: ['src/gamma.ts'],
              },
              {
                id: 'holdout-2',
                query: 'delta query',
                judgments: [{ path: 'src/delta.ts', grade: 3 }],
              },
            ],
          },
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
    const summary = artifact.summary as Record<string, unknown>;
    expect(summary.case_count).toBe(2);
    expect(summary.judged_path_count).toBe(2);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns usage/parsing error when selected dataset mismatches leakage guard holdout dataset', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-mismatch-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'holdout-check.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query', 'beta query'] },
          holdout_v1: {
            cases: [
              { id: 'holdout-1', query: 'gamma query', expected_paths: ['src/gamma.ts'] },
            ],
          },
          holdout_v2: {
            cases: [
              { id: 'holdout-2', query: 'epsilon query', expected_paths: ['src/epsilon.ts'] },
            ],
          },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--dataset-id', 'holdout_v2', '--out', outPath]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/must match leakage_guard\.holdout_dataset_id/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails validation for unsupported normalization mode', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-normalization-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'holdout-check.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query'] },
          holdout_v1: {
            cases: [
              { id: 'holdout-1', query: 'beta query', expected_paths: ['src/beta.ts'] },
            ],
          },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
          normalization: 'custom_mode',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Unsupported normalization mode/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails validation when fixture contains non-string query entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-non-string-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'holdout-check.json');

    writeJson(fixturePath, {
      holdout: {
        default_dataset_id: 'holdout_v1',
        datasets: {
          train_v1: { queries: ['alpha query'] },
          holdout_v1: {
            queries: ['beta query', 123],
            cases: [
              { id: 'holdout-1', query: 'beta query', expected_paths: ['src/beta.ts'] },
            ],
          },
        },
        leakage_guard: {
          training_dataset_id: 'train_v1',
          holdout_dataset_id: 'holdout_v1',
          normalization: 'trim_lower_whitespace_collapse',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/query\[1\] must be a string/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails validation when the selected dataset omits labeled evaluation cases', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-holdout-missing-cases-'));
    const fixturePath = path.join(tmp, 'fixture.json');
    const outPath = path.join(tmp, 'holdout-check.json');

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
          normalization: 'trim_lower_whitespace_collapse',
        },
      },
    });

    const result = runChecker(['--fixture-pack', fixturePath, '--out', outPath]);
    expect(result.status).toBe(1);
    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, any>;
    expect(artifact.gate.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/must define holdout evaluation cases/i)])
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
