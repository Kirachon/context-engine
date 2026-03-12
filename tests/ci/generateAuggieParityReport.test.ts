import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function runGenerator(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'generate-auggie-parity-report.ts');
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

function runChecker(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-auggie-capability-parity.ts');
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

describe('scripts/ci/generate-auggie-parity-report.ts', () => {
  it('generates a full report from fixture-pack evidence and passes the checker', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-auggie-parity-generator-pass-'));
    const matrixPath = path.join(tmp, 'matrix.json');
    const fixturePath = path.join(tmp, 'fixture-pack.json');
    const outPath = path.join(tmp, 'report.json');
    const gateOutPath = path.join(tmp, 'gate.json');

    writeJson(matrixPath, {
      journeys: [
        {
          id: 'critical-search',
          critical: true,
          metric_refs: ['parity.search.relevance_score', 'parity.search.rank_stability'],
        },
        {
          id: 'ops-proof',
          metric_refs: ['parity.ops.shadow_receipt_present'],
        },
      ],
      weights: { 'critical-search': 0.8, 'ops-proof': 0.2 },
      gate_rules: { min_overall_score: 90, critical_required: 100 },
    });

    writeJson(path.join(tmp, 'retrieval-parity.json'), {
      evaluations: [{ id: 'shadow.overlap_ratio', status: 'pass' }],
      gate: { status: 'pass' },
    });
    writeText(path.join(tmp, 'receipt.log'), 'shadow receipt ok\n');
    writeText(path.join(tmp, 'command-pass.js'), 'process.exit(0);\n');

    writeJson(fixturePath, {
      schema_version: 1,
      pack_id: 'tmp-pass',
      defaults: {
        retrieval_parity_path: 'retrieval-parity.json',
      },
      checks: [
        {
          id: 'parity.search.relevance_score',
          kind: 'command_exit_zero',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(tmp, 'command-pass.js'))}`,
        },
        {
          id: 'parity.search.rank_stability',
          kind: 'retrieval_eval_status',
          evaluation_id: 'shadow.overlap_ratio',
        },
        {
          id: 'parity.ops.shadow_receipt_present',
          kind: 'file_exists',
          path: 'receipt.log',
        },
      ],
    });

    const generation = runGenerator(
      ['--fixture-pack', fixturePath, '--matrix', matrixPath, '--out', outPath],
      tmp
    );
    expect(generation.status).toBe(0);
    expect(generation.stdout).toContain('gate_status=pass');

    const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = report.evaluations as Array<Record<string, unknown>>;
    expect(evaluations).toHaveLength(3);
    expect(evaluations.map((item) => item.id)).toEqual([
      'parity.search.relevance_score',
      'parity.search.rank_stability',
      'parity.ops.shadow_receipt_present',
    ]);

    const gate = runChecker(['--report', outPath, '--matrix', matrixPath, '--out', gateOutPath], tmp);
    expect(gate.status).toBe(0);
    expect(gate.stdout).toContain('gate_status=pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails with usage error when fixture pack misses matrix metric ids', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-auggie-parity-generator-missing-'));
    const matrixPath = path.join(tmp, 'matrix.json');
    const fixturePath = path.join(tmp, 'fixture-pack.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(matrixPath, {
      journeys: [
        {
          id: 'critical-search',
          critical: true,
          metric_refs: ['parity.search.relevance_score', 'parity.search.rank_stability'],
        },
      ],
      weights: { 'critical-search': 1 },
      gate_rules: { min_overall_score: 100, critical_required: 100 },
    });
    writeJson(fixturePath, {
      schema_version: 1,
      pack_id: 'tmp-missing',
      checks: [
        {
          id: 'parity.search.relevance_score',
          kind: 'file_exists',
          path: 'missing.txt',
        },
      ],
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--matrix', matrixPath, '--out', outPath], tmp);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Fixture pack missing metric ids');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marks missing retrieval metric as skip when allowed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-auggie-parity-generator-skip-'));
    const matrixPath = path.join(tmp, 'matrix.json');
    const fixturePath = path.join(tmp, 'fixture-pack.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(matrixPath, {
      journeys: [
        {
          id: 'shadow-proof',
          metric_refs: ['parity.reliability.shadow_delta_rate'],
        },
      ],
      weights: { 'shadow-proof': 1 },
      gate_rules: { min_overall_score: 0, critical_required: 100 },
    });
    writeJson(path.join(tmp, 'retrieval-parity.json'), {
      evaluations: [],
      gate: { status: 'pass' },
    });
    writeJson(fixturePath, {
      schema_version: 1,
      pack_id: 'tmp-skip',
      defaults: {
        retrieval_parity_path: 'retrieval-parity.json',
      },
      checks: [
        {
          id: 'parity.reliability.shadow_delta_rate',
          kind: 'retrieval_eval_status',
          evaluation_id: 'shadow.overlap_ratio',
          missing_status: 'skip',
        },
      ],
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--matrix', matrixPath, '--out', outPath], tmp);
    expect(result.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = report.evaluations as Array<Record<string, unknown>>;
    expect(evaluations[0].status).toBe('skip');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes json_path_equals checks when the expected gate status is present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-auggie-parity-generator-json-equals-'));
    const matrixPath = path.join(tmp, 'matrix.json');
    const fixturePath = path.join(tmp, 'fixture-pack.json');
    const outPath = path.join(tmp, 'report.json');

    writeJson(matrixPath, {
      journeys: [
        {
          id: 'shadow-proof',
          metric_refs: ['parity.reliability.shadow_delta_rate'],
        },
      ],
      weights: { 'shadow-proof': 1 },
      gate_rules: { min_overall_score: 100, critical_required: 100 },
    });
    writeJson(path.join(tmp, 'retrieval-parity.json'), {
      gate: { status: 'pass' },
    });
    writeJson(fixturePath, {
      schema_version: 1,
      pack_id: 'tmp-json-equals',
      defaults: {
        retrieval_parity_path: 'retrieval-parity.json',
      },
      checks: [
        {
          id: 'parity.reliability.shadow_delta_rate',
          kind: 'json_path_equals',
          path: '@retrieval_parity',
          json_path: 'gate.status',
          expected: 'pass',
          missing_status: 'fail',
        },
      ],
    });

    const result = runGenerator(['--fixture-pack', fixturePath, '--matrix', matrixPath, '--out', outPath], tmp);
    expect(result.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    const evaluations = report.evaluations as Array<Record<string, unknown>>;
    expect(evaluations[0].status).toBe('pass');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
