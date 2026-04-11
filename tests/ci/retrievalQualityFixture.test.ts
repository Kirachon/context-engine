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

describe('scripts/ci/retrieval-quality-fixture.ts', () => {
  const moduleHref = pathToFileURL(path.join(process.cwd(), 'scripts', 'ci', 'retrieval-quality-fixture.ts')).href;

  it('derives queries from cases and normalizes judged paths', () => {
    const result = runTsxEval(`
      const {
        getDatasetCases,
        getDatasetQueries,
        parseDataset,
        resolveSelectedDatasetId,
      } = await import(${JSON.stringify(moduleHref)});
      const dataset = parseDataset(
        {
          cases: [
            {
              id: 'alpha',
              query: '  Alpha Query  ',
              judgments: [
                { path: 'src\\\\alpha.ts', grade: 2 },
                { path: 'src/alpha.ts', grade: 3 },
              ],
            },
            {
              id: 'beta',
              query: 'Beta Query',
              expected_paths: ['src/beta.ts'],
            },
          ],
        },
        'holdout_v1'
      );
      console.log(JSON.stringify({
        selectedDatasetId: resolveSelectedDatasetId({ default_dataset_id: 'holdout_v1' }),
        queries: getDatasetQueries(dataset, 'holdout_v1'),
        cases: getDatasetCases(dataset, 'holdout_v1'),
      }));
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout.trim()) as {
      selectedDatasetId: string;
      queries: string[];
      cases: Array<{ id: string; query: string; judgments: Array<{ path: string; grade: number }> }>;
    };

    expect(parsed.selectedDatasetId).toBe('holdout_v1');
    expect(parsed.queries).toEqual(['Alpha Query', 'Beta Query']);
    expect(parsed.cases).toEqual([
      {
        id: 'alpha',
        query: 'Alpha Query',
        judgments: [{ path: 'src/alpha.ts', grade: 3 }],
      },
      {
        id: 'beta',
        query: 'Beta Query',
        judgments: [{ path: 'src/beta.ts', grade: 1 }],
      },
    ]);
  });

  it('hashes datasets using normalized queries', () => {
    const result = runTsxEval(`
      const { SUPPORTED_NORMALIZATION, computeDatasetHash } = await import(${JSON.stringify(moduleHref)});
      console.log(JSON.stringify({
        left: computeDatasetHash([' Alpha  Query ', 'Beta Query'], SUPPORTED_NORMALIZATION),
        right: computeDatasetHash(['alpha query', ' beta    query '], SUPPORTED_NORMALIZATION),
      }));
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout.trim()) as { left: string; right: string };
    expect(parsed.left).toBe(parsed.right);
  });

  it('rejects absolute judgment paths', () => {
    const result = runTsxEval(`
      const { parseDataset } = await import(${JSON.stringify(moduleHref)});
      try {
        parseDataset(
          {
            cases: [
              {
                id: 'alpha',
                query: 'alpha query',
                judgments: [{ path: 'C:\\\\absolute.ts', grade: 1 }],
              },
            ],
          },
          'holdout_v1'
        );
        console.log('NO_ERROR');
      } catch (error) {
        console.log((error instanceof Error ? error.message : String(error)).trim());
      }
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/must be repo-relative/i);
  });
});
