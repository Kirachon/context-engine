import { scoreLexicalCandidates } from '../../../src/internal/retrieval/lexical.js';

describe('scoreLexicalCandidates', () => {
  it('scores and ranks lexical matches using query tokens', () => {
    const results = scoreLexicalCandidates(
      [
        { path: 'src/auth/login.ts', content: 'login auth service login', lines: '1-8' },
        { path: 'src/db/schema.ts', content: 'database schema', lines: '1-8' },
      ],
      {
        query: 'login auth',
        queryVariant: 'login auth',
        variantIndex: 0,
        variantWeight: 1,
      }
    );

    expect(results).toHaveLength(2);
    expect(results[0].path).toBe('src/auth/login.ts');
    expect(results[0].retrievalSource).toBe('lexical');
    expect(results[0].lexicalScore).toBeGreaterThan(results[1].lexicalScore ?? 0);
    expect(results[0].combinedScore).toBeDefined();
  });

  it('returns deterministic metadata for tie-break fields', () => {
    const [result] = scoreLexicalCandidates(
      [{ path: 'src/api/user.ts', content: 'user endpoint', lines: '22-30' }],
      {
        query: 'user endpoint',
        queryVariant: 'user endpoint',
        variantIndex: 1,
        variantWeight: 0.7,
      }
    );

    expect(result.tieBreakPath).toBe('src/api/user.ts');
    expect(result.tieBreakLine).toBe(22);
    expect(result.variantIndex).toBe(1);
    expect(result.variantWeight).toBe(0.7);
  });

  it('prefers source scripts over nearby test files for identifier-like filename queries', () => {
    const results = scoreLexicalCandidates(
      [
        {
          path: 'tests/ci/lunarRankingOrchestrator.test.ts',
          content: 'assert checksum_guard drift_token',
          lines: '1-40',
        },
        {
          path: 'scripts/ci/lunar-ranking-orchestrator.ts',
          content: 'export function runOrchestrator() { return "checksum_guard drift_token"; }',
          lines: '1-40',
        },
      ],
      {
        query: 'lunar-ranking-orchestrator checksum_guard drift_token',
        queryVariant: 'lunar-ranking-orchestrator',
        variantIndex: 0,
        variantWeight: 1,
      }
    );

    expect(results[0].path).toBe('scripts/ci/lunar-ranking-orchestrator.ts');
    expect(results[0].lexicalScore).toBeGreaterThan(results[1].lexicalScore ?? 0);
  });

  it('penalizes artifact and config JSON echoes when an identifier query targets a source script', () => {
    const results = scoreLexicalCandidates(
      [
        {
          path: 'artifacts/bench/retrieval-quality-report.json',
          content: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
          lines: '1-40',
        },
        {
          path: 'config/ci/retrieval-quality-fixture-pack.json',
          content: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
          lines: '1-40',
        },
        {
          path: 'scripts/ci/generate-retrieval-quality-report.ts',
          content: 'export function generateReport() { return "synthetic_guard stable_fixture_token"; }',
          lines: '1-40',
        },
      ],
      {
        query: 'generate-retrieval-quality-report synthetic_guard stable_fixture_token',
        queryVariant: 'generate-retrieval-quality-report',
        variantIndex: 0,
        variantWeight: 1,
      }
    );

    expect(results[0].path).toBe('scripts/ci/generate-retrieval-quality-report.ts');
    expect(results[results.length - 1]?.path).toBe('artifacts/bench/retrieval-quality-report.json');
  });
});
