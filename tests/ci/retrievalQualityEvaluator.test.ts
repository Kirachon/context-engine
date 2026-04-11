import { describe, expect, it } from '@jest/globals';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

function runTsxEval(code: string): { status: number; stdout: string; stderr: string } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, '--input-type=module', '-e', code], {
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

describe('scripts/ci/retrieval-quality-evaluator.ts', () => {
  const moduleHref = pathToFileURL(path.join(process.cwd(), 'scripts', 'ci', 'retrieval-quality-evaluator.ts')).href;

  it('dedupes retrieved paths and computes ranking metrics', () => {
    const result = runTsxEval(`
      const { evaluateRetrievalCase } = await import(${JSON.stringify(moduleHref)});
      const caseDef = {
        id: 'graded-case',
        query: 'quality report query',
        judgments: [
          { path: 'scripts/ci/generate-retrieval-quality-report.ts', grade: 3 },
          { path: 'scripts/ci/check-retrieval-quality-gate.ts', grade: 1 },
        ],
      };
      const evaluated = evaluateRetrievalCase(
        caseDef,
        [
          'scripts/ci/unrelated.ts',
          'scripts\\\\ci\\\\generate-retrieval-quality-report.ts',
          'scripts/ci/check-retrieval-quality-gate.ts',
          'scripts/ci/check-retrieval-quality-gate.ts',
        ],
        10
      );
      console.log(JSON.stringify(evaluated));
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout.trim()) as {
      actual_paths: string[];
      metrics: {
        p_at_1: number;
        first_relevant_rank: number;
        reciprocal_rank_at_10: number;
        recall_at_10: number;
        relevant_hit_count_at_10: number;
        ndcg_at_10: number;
      };
    };

    expect(parsed.actual_paths).toEqual([
      'scripts/ci/unrelated.ts',
      'scripts/ci/generate-retrieval-quality-report.ts',
      'scripts/ci/check-retrieval-quality-gate.ts',
    ]);
    expect(parsed.metrics.p_at_1).toBe(0);
    expect(parsed.metrics.first_relevant_rank).toBe(2);
    expect(parsed.metrics.reciprocal_rank_at_10).toBeCloseTo(0.5);
    expect(parsed.metrics.recall_at_10).toBe(1);
    expect(parsed.metrics.relevant_hit_count_at_10).toBe(2);
    expect(parsed.metrics.ndcg_at_10).toBeCloseTo(0.6443, 4);
  });

  it('aggregates per-case metrics into the report metric map', () => {
    const result = runTsxEval(`
      const {
        aggregateRetrievalEval,
        buildQualityMetricMap,
        evaluateRetrievalCase,
      } = await import(${JSON.stringify(moduleHref)});
      const first = evaluateRetrievalCase(
        {
          id: 'graded-case',
          query: 'quality report query',
          judgments: [
            { path: 'scripts/ci/generate-retrieval-quality-report.ts', grade: 3 },
            { path: 'scripts/ci/check-retrieval-quality-gate.ts', grade: 1 },
          ],
        },
        [
          'scripts/ci/unrelated.ts',
          'scripts/ci/generate-retrieval-quality-report.ts',
          'scripts/ci/check-retrieval-quality-gate.ts',
        ]
      );
      const second = evaluateRetrievalCase(
        {
          id: 'perfect-case',
          query: 'holdout validator',
          judgments: [{ path: 'scripts/ci/check-retrieval-holdout-fixture.ts', grade: 2 }],
        },
        ['scripts/ci/check-retrieval-holdout-fixture.ts']
      );
      const aggregate = aggregateRetrievalEval([first, second]);
      const metrics = buildQualityMetricMap(aggregate);
      console.log(JSON.stringify({ aggregate, metrics }));
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout.trim()) as {
      aggregate: {
        mrr_at_10: number;
        ndcg_at_10: number;
        recall_at_10: number;
        p_at_1: number;
        case_count: number;
        judged_path_count: number;
      };
      metrics: Record<string, number>;
    };

    expect(parsed.aggregate.mrr_at_10).toBe(0.75);
    expect(parsed.aggregate.ndcg_at_10).toBeCloseTo(0.8221, 4);
    expect(parsed.aggregate.recall_at_10).toBe(1);
    expect(parsed.aggregate.p_at_1).toBe(0.5);
    expect(parsed.aggregate.case_count).toBe(2);
    expect(parsed.aggregate.judged_path_count).toBe(3);
    expect(parsed.metrics).toEqual({
      'quality.mrr_at_10': 0.75,
      'quality.ndcg_at_10': parsed.aggregate.ndcg_at_10,
      'quality.recall_at_10': 1,
      'quality.p_at_1': 0.5,
    });
  });
});
