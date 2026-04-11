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

  it('uses reciprocal-rank fusion so cross-source agreement beats a single outsized score', () => {
    const fused = fuseCandidates([
      makeCandidate({
        path: 'src/outlier.ts',
        lines: '1-2',
        retrievalSource: 'semantic',
        semanticScore: 100,
        relevanceScore: 100,
      }),
      makeCandidate({
        path: 'src/consensus.ts',
        lines: '1-2',
        retrievalSource: 'semantic',
        semanticScore: 0.1,
        relevanceScore: 0.1,
      }),
      makeCandidate({
        path: 'src/consensus.ts',
        lines: '1-2',
        retrievalSource: 'lexical',
        lexicalScore: 0.01,
        relevanceScore: 0.01,
      }),
    ]);

    expect(fused[0].path).toBe('src/consensus.ts');
    expect(fused[0].retrievalSource).toBe('hybrid');
    expect((fused[0].combinedScore ?? 0)).toBeGreaterThan(fused[1]?.combinedScore ?? 0);
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

  it('defaults missing variant weights to 1 so ranked lists still participate in fusion', () => {
    const fused = fuseCandidates([
      {
        path: 'src/consensus.ts',
        content: 'alpha',
        lines: '1-2',
        queryVariant: 'alpha',
        variantIndex: 0,
        retrievalSource: 'semantic',
        semanticScore: 0.6,
        relevanceScore: 0.6,
      } as InternalSearchResult,
      {
        path: 'src/consensus.ts',
        content: 'alpha',
        lines: '1-2',
        queryVariant: 'alpha',
        variantIndex: 0,
        retrievalSource: 'lexical',
        lexicalScore: 0.7,
        relevanceScore: 0.7,
      } as InternalSearchResult,
      makeCandidate({
        path: 'src/outlier.ts',
        lines: '1-2',
        retrievalSource: 'semantic',
        semanticScore: 0.95,
        relevanceScore: 0.95,
      }),
    ]);

    expect(fused[0].path).toBe('src/consensus.ts');
    expect(fused[0].retrievalSource).toBe('hybrid');
    expect(fused[0].variantWeight).toBe(1);
  });

  it('keeps hybrid candidates in each ranked list they have source evidence for', () => {
    const fused = fuseCandidates([
      {
        path: 'src/consensus.ts',
        content: 'alpha',
        lines: '1-2',
        queryVariant: 'alpha',
        variantIndex: 0,
        variantWeight: 1,
        retrievalSource: 'hybrid',
        semanticScore: 0.7,
        lexicalScore: 0.8,
        relevanceScore: 0.8,
      },
      makeCandidate({
        path: 'src/outlier.ts',
        lines: '1-2',
        retrievalSource: 'semantic',
        semanticScore: 0.95,
        relevanceScore: 0.95,
      }),
    ]);

    expect(fused[0].path).toBe('src/consensus.ts');
    expect(fused[0].retrievalSource).toBe('hybrid');
    expect((fused[0].combinedScore ?? 0)).toBeGreaterThan(fused[1]?.combinedScore ?? 0);
  });

  it('separates missing variant indexes by query variant when building rank lists', () => {
    const fused = fuseCandidates([
      {
        path: 'src/alpha.ts',
        content: 'alpha',
        lines: '1-2',
        queryVariant: 'alpha',
        retrievalSource: 'semantic',
        semanticScore: 0.9,
        relevanceScore: 0.9,
      } as InternalSearchResult,
      {
        path: 'src/beta.ts',
        content: 'beta',
        lines: '1-2',
        queryVariant: 'beta',
        retrievalSource: 'semantic',
        semanticScore: 0.2,
        relevanceScore: 0.2,
      } as InternalSearchResult,
    ]);

    expect(fused[0].combinedScore).toBeCloseTo(fused[1].combinedScore ?? 0, 10);
    expect(fused[0].path).toBe('src/alpha.ts');
    expect(fused[1].path).toBe('src/beta.ts');
  });
});
