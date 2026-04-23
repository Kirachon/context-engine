import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

type Contract = {
  version: number;
  plan_path: string;
  readiness_pack_path: string;
  gate_artifact_path: string;
  required_completed_tasks: string[];
  required_docs: string[];
  live_test_groups: Record<string, { label: string; tests: string[]; fixtures?: string[] }>;
  artifact_checks: {
    retrieval_provenance: Record<string, unknown>;
    malformed_output_accounting: Record<string, unknown>;
  };
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as T;
}

describe('config/ci/openai-mcp-gap-closure-readiness-contract.json', () => {
  it('pins the final T13 gate inputs to real tests, artifacts, docs, and the active plan', () => {
    const contract = readJson<Contract>('config/ci/openai-mcp-gap-closure-readiness-contract.json');

    expect(contract.version).toBe(1);
    expect(contract.plan_path).toBe('openai-mcp-gap-closure-swarm-plan.md');
    expect(contract.readiness_pack_path).toBe(
      'docs/plan-execution/openai-mcp-gap-closure-final-readiness-pack.md'
    );
    expect(contract.gate_artifact_path).toBe(
      'artifacts/bench/openai-mcp-gap-closure-readiness-gate.json'
    );
    expect(contract.required_completed_tasks).toEqual(['T6', 'T10a', 'T10b', 'T11a', 'T11b', 'T12']);

    expect(fs.existsSync(path.join(process.cwd(), contract.plan_path))).toBe(true);
    for (const docPath of contract.required_docs) {
      expect(fs.existsSync(path.join(process.cwd(), docPath))).toBe(true);
    }

    expect(Object.keys(contract.live_test_groups)).toEqual([
      'graph_accuracy',
      'review_precision_grounding',
      'tracing_telemetry',
    ]);

    for (const group of Object.values(contract.live_test_groups)) {
      expect(group.label).toEqual(expect.any(String));
      expect(group.tests.length).toBeGreaterThan(0);
      for (const testPath of group.tests) {
        expect(fs.existsSync(path.join(process.cwd(), testPath))).toBe(true);
      }
      for (const fixturePath of group.fixtures ?? []) {
        expect(fs.existsSync(path.join(process.cwd(), fixturePath))).toBe(true);
      }
    }

    expect(contract.artifact_checks.retrieval_provenance).toEqual(
      expect.objectContaining({
        quality_report: 'artifacts/bench/retrieval-quality-report.json',
        quality_gate: 'artifacts/bench/retrieval-quality-gate.json',
        telemetry: 'artifacts/bench/retrieval-quality-telemetry.json',
        routing_receipts: 'artifacts/bench/retrieval-routing-receipts.json',
        shadow_canary_gate: 'artifacts/bench/retrieval-shadow-canary-gate.json',
        min_routing_receipt_coverage_pct: 100,
      })
    );
    expect(contract.artifact_checks.malformed_output_accounting).toEqual(
      expect.objectContaining({
        taxonomy_report: 'artifacts/bench/enhancement-error-taxonomy-report.json',
        max_malformed_event_count: 0,
      })
    );
  });
});
