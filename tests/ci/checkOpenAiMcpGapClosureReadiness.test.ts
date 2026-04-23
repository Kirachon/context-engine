import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function runChecker(args: string[]): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'ci', 'check-openai-mcp-gap-closure-readiness.ts');
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

function createMinimalPlan(taskIds: string[]): string {
  return taskIds
    .map(
      (taskId) =>
        [`### ${taskId}: Synthetic`, '- **status**: Completed', '- **log**:', '- synthetic'].join('\n')
    )
    .join('\n\n');
}

describe('scripts/ci/check-openai-mcp-gap-closure-readiness.ts', () => {
  it('passes in skip-live-tests mode when all required receipts are present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gap-readiness-pass-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const contractPath = path.join(workspace, 'config', 'ci', 'contract.json');
    const planPath = path.join(workspace, 'openai-mcp-gap-closure-swarm-plan.md');
    const readinessPackPath = path.join(workspace, 'docs', 'plan-execution', 'final-pack.md');
    const gateArtifactPath = path.join(workspace, 'artifacts', 'bench', 'readiness-gate.json');
    const requiredDocs = [
      'docs/plan-execution/openai-mcp-gap-closure-t0-baseline.md',
      'docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md',
      'docs/plan-execution/openai-mcp-gap-closure-gap-ledger.md',
    ];
    const tests = [
      'tests/internal/graph/persistentGraphStore.test.ts',
      'tests/tools/graphNativeTools.test.ts',
      'tests/mcp/graphNativeRegistration.test.ts',
      'tests/tools/reviewDiff.test.ts',
      'tests/ci/reviewDiffArtifacts.test.ts',
      'tests/observability/otel.test.ts',
      'tests/mcp/serverObservability.test.ts',
      'tests/internal/retrieval/retrieveObservability.test.ts',
      'config/ci/review-quality-corpus.json',
    ];

    for (const relativePath of [...requiredDocs, ...tests]) {
      writeText(path.join(workspace, relativePath), 'fixture');
    }

    writeText(planPath, createMinimalPlan(['T6', 'T10a', 'T10b', 'T11a', 'T11b', 'T12']));
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-report.json'), {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-gate.json'), {
      summary: { pass_rate: 1 },
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-telemetry.json'), {
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-routing-receipts.json'), {
      routing_diagnostics: { receipt_coverage_pct: 100 },
      reproducibility_lock: {
        commit_sha: 'abc',
        dataset_hash: 'hash',
        feature_flags_snapshot: '{"x":true}',
      },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-shadow-canary-gate.json'), {
      gate: { status: 'pass' },
      observed: { routing_receipts: { receipt_coverage_pct: 100 } },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'enhancement-error-taxonomy-report.json'), {
      status: 'PASS',
      summary: { malformed_event_count: 0, total_events: 0 },
    });

    writeJson(contractPath, {
      version: 1,
      plan_path: 'openai-mcp-gap-closure-swarm-plan.md',
      readiness_pack_path: 'docs/plan-execution/final-pack.md',
      gate_artifact_path: 'artifacts/bench/readiness-gate.json',
      required_completed_tasks: ['T6', 'T10a', 'T10b', 'T11a', 'T11b', 'T12'],
      required_docs: requiredDocs,
      live_test_groups: {
        graph_accuracy: {
          label: 'graph accuracy fixtures',
          tests: [
            'tests/internal/graph/persistentGraphStore.test.ts',
            'tests/tools/graphNativeTools.test.ts',
            'tests/mcp/graphNativeRegistration.test.ts',
          ],
        },
        review_precision_grounding: {
          label: 'review precision and grounding',
          tests: ['tests/tools/reviewDiff.test.ts', 'tests/ci/reviewDiffArtifacts.test.ts'],
          fixtures: ['config/ci/review-quality-corpus.json'],
        },
        tracing_telemetry: {
          label: 'tracing and telemetry smoke',
          tests: [
            'tests/observability/otel.test.ts',
            'tests/mcp/serverObservability.test.ts',
            'tests/internal/retrieval/retrieveObservability.test.ts',
          ],
        },
      },
      artifact_checks: {
        retrieval_provenance: {
          quality_report: 'artifacts/bench/retrieval-quality-report.json',
          quality_gate: 'artifacts/bench/retrieval-quality-gate.json',
          telemetry: 'artifacts/bench/retrieval-quality-telemetry.json',
          routing_receipts: 'artifacts/bench/retrieval-routing-receipts.json',
          shadow_canary_gate: 'artifacts/bench/retrieval-shadow-canary-gate.json',
          min_routing_receipt_coverage_pct: 100,
        },
        malformed_output_accounting: {
          taxonomy_report: 'artifacts/bench/enhancement-error-taxonomy-report.json',
          max_malformed_event_count: 0,
        },
      },
    });

    const result = runChecker([
      '--workspace',
      workspace,
      '--contract',
      contractPath,
      '--skip-live-tests',
      '--out',
      gateArtifactPath,
      '--readiness-pack',
      readinessPackPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('openai_mcp_gap_closure_readiness status=pass');
    expect(fs.existsSync(gateArtifactPath)).toBe(true);
    expect(fs.existsSync(readinessPackPath)).toBe(true);

    const gate = JSON.parse(fs.readFileSync(gateArtifactPath, 'utf8')) as any;
    expect(gate.overall.status).toBe('pass');
    expect(gate.live_test_groups.graph_accuracy.status).toBe('skip');

    const pack = fs.readFileSync(readinessPackPath, 'utf8');
    expect(pack).toContain('OpenAI MCP Gap Closure Final Readiness Pack');
    expect(pack).toContain('Overall status: `PASS`');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails when a dependency task is not completed or malformed receipts exceed threshold', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gap-readiness-fail-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const contractPath = path.join(workspace, 'config', 'ci', 'contract.json');
    const planPath = path.join(workspace, 'openai-mcp-gap-closure-swarm-plan.md');

    writeText(
      planPath,
      [
        '### T6: Synthetic',
        '- **status**: Completed',
        '### T10a: Synthetic',
        '- **status**: Completed',
        '### T10b: Synthetic',
        '- **status**: Completed',
        '### T11a: Synthetic',
        '- **status**: Completed',
        '### T11b: Synthetic',
        '- **status**: Completed',
        '### T12: Synthetic',
        '- **status**: Not Completed',
      ].join('\n')
    );

    for (const relativePath of [
      'docs/plan-execution/openai-mcp-gap-closure-t0-baseline.md',
      'docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md',
      'docs/plan-execution/openai-mcp-gap-closure-gap-ledger.md',
      'tests/internal/graph/persistentGraphStore.test.ts',
      'tests/tools/graphNativeTools.test.ts',
      'tests/mcp/graphNativeRegistration.test.ts',
      'tests/tools/reviewDiff.test.ts',
      'tests/ci/reviewDiffArtifacts.test.ts',
      'tests/observability/otel.test.ts',
      'tests/mcp/serverObservability.test.ts',
      'tests/internal/retrieval/retrieveObservability.test.ts',
      'config/ci/review-quality-corpus.json',
    ]) {
      writeText(path.join(workspace, relativePath), 'fixture');
    }

    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-report.json'), {
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-gate.json'), {
      summary: { pass_rate: 1 },
      gate: { status: 'pass' },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-quality-telemetry.json'), {
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-routing-receipts.json'), {
      routing_diagnostics: { receipt_coverage_pct: 90 },
      reproducibility_lock: {
        commit_sha: 'abc',
        dataset_hash: 'hash',
        feature_flags_snapshot: '{"x":true}',
      },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'retrieval-shadow-canary-gate.json'), {
      gate: { status: 'pass' },
      observed: { routing_receipts: { receipt_coverage_pct: 90 } },
      reproducibility_lock: { commit_sha: 'abc', dataset_hash: 'hash' },
    });
    writeJson(path.join(workspace, 'artifacts', 'bench', 'enhancement-error-taxonomy-report.json'), {
      status: 'PASS',
      summary: { malformed_event_count: 2, total_events: 2 },
    });

    writeJson(contractPath, {
      version: 1,
      plan_path: 'openai-mcp-gap-closure-swarm-plan.md',
      readiness_pack_path: 'docs/plan-execution/final-pack.md',
      gate_artifact_path: 'artifacts/bench/readiness-gate.json',
      required_completed_tasks: ['T6', 'T10a', 'T10b', 'T11a', 'T11b', 'T12'],
      required_docs: [
        'docs/plan-execution/openai-mcp-gap-closure-t0-baseline.md',
        'docs/plan-execution/openai-mcp-gap-closure-ownership-gate-pack.md',
        'docs/plan-execution/openai-mcp-gap-closure-gap-ledger.md',
      ],
      live_test_groups: {
        graph_accuracy: {
          label: 'graph accuracy fixtures',
          tests: [
            'tests/internal/graph/persistentGraphStore.test.ts',
            'tests/tools/graphNativeTools.test.ts',
            'tests/mcp/graphNativeRegistration.test.ts',
          ],
        },
        review_precision_grounding: {
          label: 'review precision and grounding',
          tests: ['tests/tools/reviewDiff.test.ts', 'tests/ci/reviewDiffArtifacts.test.ts'],
          fixtures: ['config/ci/review-quality-corpus.json'],
        },
        tracing_telemetry: {
          label: 'tracing and telemetry smoke',
          tests: [
            'tests/observability/otel.test.ts',
            'tests/mcp/serverObservability.test.ts',
            'tests/internal/retrieval/retrieveObservability.test.ts',
          ],
        },
      },
      artifact_checks: {
        retrieval_provenance: {
          quality_report: 'artifacts/bench/retrieval-quality-report.json',
          quality_gate: 'artifacts/bench/retrieval-quality-gate.json',
          telemetry: 'artifacts/bench/retrieval-quality-telemetry.json',
          routing_receipts: 'artifacts/bench/retrieval-routing-receipts.json',
          shadow_canary_gate: 'artifacts/bench/retrieval-shadow-canary-gate.json',
          min_routing_receipt_coverage_pct: 100,
        },
        malformed_output_accounting: {
          taxonomy_report: 'artifacts/bench/enhancement-error-taxonomy-report.json',
          max_malformed_event_count: 0,
        },
      },
    });

    const result = runChecker([
      '--workspace',
      workspace,
      '--contract',
      contractPath,
      '--skip-live-tests',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status=fail');

    const gate = JSON.parse(
      fs.readFileSync(path.join(workspace, 'artifacts', 'bench', 'readiness-gate.json'), 'utf8')
    ) as any;
    expect(gate.overall.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Required dependency task not completed: T12'),
        expect.stringContaining('Routing receipt coverage 90 below 100'),
        expect.stringContaining('Malformed event count 2 exceeds max 0'),
      ])
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
