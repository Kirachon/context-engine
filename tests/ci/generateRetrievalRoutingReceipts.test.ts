import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runRoutingReceiptGenerator(
  args: string[],
  envOverrides?: Record<string, string>
): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'generate-retrieval-routing-receipts.ts');
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('scripts/ci/generate-retrieval-routing-receipts.ts', () => {
  it('rolls up live routing diagnostics from fixture queries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-routing-receipts-'));
    const workspace = path.join(tmp, 'workspace');
    const fixturePath = path.join(tmp, 'fixture.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'routing-receipts.json');

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'src', 'provider.ts'),
      [
        'export function resolveAIProviderId() {',
        '  return "openai_session";',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        holdout: {
          default_dataset_id: 'holdout_v1',
          datasets: {
            holdout_v1: {
              cases: [
                {
                  id: 'provider-definition',
                  query: 'definition of resolveAIProviderId',
                  judgments: [{ path: 'src/provider.ts', grade: 3 }],
                },
              ],
            },
          },
          leakage_guard: {
            training_dataset_id: 'train_v1',
            holdout_dataset_id: 'holdout_v1',
            normalization: 'trim_lower_whitespace_collapse',
          },
        },
        checks: [],
        gate_rules: { min_pass_rate: 0, required_ids: [] },
      }),
      'utf8'
    );
    const datasetHash = createHash('sha256')
      .update(JSON.stringify(['definition of resolveaiproviderid']))
      .digest('hex');

    fs.writeFileSync(
      holdoutPath,
      JSON.stringify({
        summary: {
          dataset_id: 'holdout_v1',
          dataset_hash: datasetHash,
        },
      }),
      'utf8'
    );

    const result = runRoutingReceiptGenerator([
      '--fixture-pack', fixturePath,
      '--workspace', workspace,
      '--holdout-artifact', holdoutPath,
      '--declaration-routing-enabled',
      '--shadow-compare-enabled',
      '--shadow-sample-rate', '1',
      '--out', outPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('retrieval_routing_receipts generated');

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(artifact.routing_diagnostics).toEqual({
      total_bundle_count: 1,
      routing_diagnostics_count: 1,
      symbol_route_count: 1,
      shadow_compare_receipt_count: 1,
      shadow_compare_executed_count: 1,
      receipt_coverage_pct: 100,
    });

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when the holdout artifact does not match the selected dataset summary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-routing-receipts-mismatch-'));
    const workspace = path.join(tmp, 'workspace');
    const fixturePath = path.join(tmp, 'fixture.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'routing-receipts.json');

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'src', 'provider.ts'),
      'export function resolveAIProviderId() {\n  return "openai_session";\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        holdout: {
          default_dataset_id: 'holdout_v1',
          datasets: {
            holdout_v1: {
              cases: [
                {
                  id: 'provider-definition',
                  query: 'definition of resolveAIProviderId',
                  judgments: [{ path: 'src/provider.ts', grade: 3 }],
                },
              ],
            },
          },
          leakage_guard: {
            training_dataset_id: 'train_v1',
            holdout_dataset_id: 'holdout_v1',
            normalization: 'trim_lower_whitespace_collapse',
          },
        },
        checks: [],
        gate_rules: { min_pass_rate: 0, required_ids: [] },
      }),
      'utf8'
    );
    fs.writeFileSync(
      holdoutPath,
      JSON.stringify({
        summary: {
          dataset_id: 'holdout_v1',
          dataset_hash: 'x'.repeat(64),
        },
      }),
      'utf8'
    );

    const result = runRoutingReceiptGenerator([
      '--fixture-pack', fixturePath,
      '--workspace', workspace,
      '--holdout-artifact', holdoutPath,
      '--declaration-routing-enabled',
      '--out', outPath,
    ]);

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/holdout artifact dataset does not match/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when CE_QA_DATASET_* overrides disagree with the selected fixture dataset', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-routing-receipts-env-mismatch-'));
    const workspace = path.join(tmp, 'workspace');
    const fixturePath = path.join(tmp, 'fixture.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'routing-receipts.json');

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'provider.ts'), 'export const provider = "openai_session";\n', 'utf8');
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        holdout: {
          default_dataset_id: 'holdout_v1',
          datasets: {
            holdout_v1: {
              cases: [
                {
                  id: 'provider-definition',
                  query: 'definition of provider',
                  judgments: [{ path: 'src/provider.ts', grade: 3 }],
                },
              ],
            },
          },
          leakage_guard: {
            training_dataset_id: 'train_v1',
            holdout_dataset_id: 'holdout_v1',
            normalization: 'trim_lower_whitespace_collapse',
          },
        },
        checks: [],
        gate_rules: { min_pass_rate: 0, required_ids: [] },
      }),
      'utf8'
    );
    const datasetHash = createHash('sha256')
      .update(JSON.stringify(['definition of provider']))
      .digest('hex');
    fs.writeFileSync(
      holdoutPath,
      JSON.stringify({
        summary: {
          dataset_id: 'holdout_v1',
          dataset_hash: datasetHash,
        },
      }),
      'utf8'
    );

    const result = runRoutingReceiptGenerator([
      '--fixture-pack', fixturePath,
      '--workspace', workspace,
      '--holdout-artifact', holdoutPath,
      '--declaration-routing-enabled',
      '--shadow-compare-enabled',
      '--shadow-sample-rate', '1',
      '--out', outPath,
    ], {
      CE_QA_DATASET_ID: 'other_dataset',
      CE_QA_DATASET_HASH: 'deadbeef',
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/do not match the selected fixture dataset/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not count semantic fallbacks as symbol-route receipt coverage debt', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-routing-receipts-fallback-'));
    const workspace = path.join(tmp, 'workspace');
    const fixturePath = path.join(tmp, 'fixture.json');
    const holdoutPath = path.join(tmp, 'holdout.json');
    const outPath = path.join(tmp, 'routing-receipts.json');

    const datasetHash = createHash('sha256')
      .update(JSON.stringify(['definition of missingsymbol']))
      .digest('hex');

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'noise.ts'), 'export const noise = true;\n', 'utf8');
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        holdout: {
          default_dataset_id: 'holdout_v1',
          datasets: {
            holdout_v1: {
              cases: [
                {
                  id: 'missing-definition',
                  query: 'definition of missingSymbol',
                  judgments: [{ path: 'src/noise.ts', grade: 1 }],
                },
              ],
            },
          },
          leakage_guard: {
            training_dataset_id: 'train_v1',
            holdout_dataset_id: 'holdout_v1',
            normalization: 'trim_lower_whitespace_collapse',
          },
        },
        checks: [],
        gate_rules: { min_pass_rate: 0, required_ids: [] },
      }),
      'utf8'
    );
    fs.writeFileSync(
      holdoutPath,
      JSON.stringify({
        summary: {
          dataset_id: 'holdout_v1',
          dataset_hash: datasetHash,
        },
      }),
      'utf8'
    );

    const result = runRoutingReceiptGenerator([
      '--fixture-pack', fixturePath,
      '--workspace', workspace,
      '--holdout-artifact', holdoutPath,
      '--declaration-routing-enabled',
      '--shadow-compare-enabled',
      '--shadow-sample-rate', '1',
      '--out', outPath,
    ]);
    expect(result.status).toBe(0);

    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    expect(artifact.routing_diagnostics).toEqual({
      total_bundle_count: 1,
      routing_diagnostics_count: 1,
      symbol_route_count: 0,
      shadow_compare_receipt_count: 0,
      shadow_compare_executed_count: 0,
      receipt_coverage_pct: 100,
    });

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
