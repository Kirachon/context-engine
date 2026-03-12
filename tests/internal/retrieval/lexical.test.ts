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
});
