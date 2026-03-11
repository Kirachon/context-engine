import { scoreDenseCandidates } from '../../../src/internal/retrieval/dense.js';

describe('scoreDenseCandidates', () => {
  it('maps dense provider output into internal candidates', () => {
    const results = scoreDenseCandidates(
      [
        { path: 'src/search/index.ts', content: 'dense retrieval', relevanceScore: 0.81, lines: '11-19' },
      ],
      {
        queryVariant: 'dense retrieval',
        variantIndex: 0,
        variantWeight: 1,
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].retrievalSource).toBe('dense');
    expect(results[0].denseScore).toBeCloseTo(0.81);
    expect(results[0].tieBreakLine).toBe(11);
  });
});

