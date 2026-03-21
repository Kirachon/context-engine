import { fuseCandidates } from '../../../src/internal/retrieval/fusion.js';
import type { InternalSearchResult } from '../../../src/internal/retrieval/types.js';

function makeCandidate(partial: Partial<InternalSearchResult>): InternalSearchResult {
  return {
    path: partial.path ?? 'src/a.ts',
    content: partial.content ?? 'alpha',
    queryVariant: partial.queryVariant ?? 'alpha',
    variantIndex: partial.variantIndex ?? 0,
    variantWeight: partial.variantWeight ?? 1,
    ...partial,
  };
}

describe('fuseCandidates', () => {
  it('merges semantic and lexical entries into a hybrid candidate', () => {
    const fused = fuseCandidates([
      makeCandidate({
        path: 'src/auth/login.ts',
        lines: '10-20',
        retrievalSource: 'semantic',
        semanticScore: 0.8,
        relevanceScore: 0.8,
      }),
      makeCandidate({
        path: 'src/auth/login.ts',
        lines: '10-20',
        retrievalSource: 'lexical',
        lexicalScore: 0.9,
        relevanceScore: 0.9,
      }),
    ]);

    expect(fused).toHaveLength(1);
    expect(fused[0].retrievalSource).toBe('hybrid');
    expect(fused[0].combinedScore).toBeGreaterThan(0);
    expect(fused[0].tieBreakPath).toBe('src/auth/login.ts');
  });

  it('keeps deterministic order when scores tie', () => {
    const fused = fuseCandidates([
      makeCandidate({
        path: 'src/b.ts',
        lines: '20-30',
        retrievalSource: 'semantic',
        semanticScore: 0.5,
        relevanceScore: 0.5,
      }),
      makeCandidate({
        path: 'src/a.ts',
        lines: '10-20',
        retrievalSource: 'semantic',
        semanticScore: 0.5,
        relevanceScore: 0.5,
      }),
    ]);

    expect(fused).toHaveLength(2);
    expect(fused[0].path).toBe('src/a.ts');
    expect(fused[1].path).toBe('src/b.ts');
  });

  it('includes dense score when dense candidates are provided', () => {
    const fused = fuseCandidates([
      makeCandidate({
        path: 'src/ranker.ts',
        lines: '3-8',
        retrievalSource: 'semantic',
        semanticScore: 0.6,
        relevanceScore: 0.6,
      }),
      makeCandidate({
        path: 'src/ranker.ts',
        lines: '3-8',
        retrievalSource: 'dense',
        denseScore: 0.9,
        relevanceScore: 0.9,
      }),
    ], {
      semanticWeight: 0.5,
      lexicalWeight: 0,
      denseWeight: 0.5,
    });

    expect(fused).toHaveLength(1);
    expect(fused[0].retrievalSource).toBe('hybrid');
    expect(fused[0].denseScore).toBeCloseTo(0.9);
    expect((fused[0].combinedScore ?? 0)).toBeGreaterThan(0);
  });

  it('prefers compact chunk candidates when scores tie', () => {
    const fused = fuseCandidates([
      makeCandidate({
        path: 'src/auth/login.ts',
        lines: '1-120',
        retrievalSource: 'semantic',
        semanticScore: 0.6,
        relevanceScore: 0.6,
      }),
      makeCandidate({
        path: 'src/auth/login.ts',
        lines: '10-14',
        chunkId: 'src/auth/login.ts#chunk-1',
        retrievalSource: 'semantic',
        semanticScore: 0.6,
        relevanceScore: 0.6,
      }),
    ]);

    expect(fused).toHaveLength(2);
    expect(fused[0].lines).toBe('10-14');
    expect(fused[0].chunkId).toBe('src/auth/login.ts#chunk-1');
  });
});
