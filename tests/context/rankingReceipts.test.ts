import { describe, expect, it } from '@jest/globals';
import {
  buildRankingReceipt,
  buildRankingReceiptsForFiles,
  type BuildRankingReceiptInput,
} from '../../src/context/rankingReceipts.js';
import {
  buildRankingReceipt as buildRankingReceiptReexport,
} from '../../src/context/ranking.js';

function buildFullFixtureInput(): BuildRankingReceiptInput {
  return {
    itemId: 'ctxi_login_handler',
    path: 'src/auth/login.ts',
    query: 'loginUser route',
    relevance: 0.94,
    selectionExplainability: {
      selectedBecause: [
        'Contains exact symbol loginUser',
        'Called by /login route',
        'Covered by auth login tests',
        'Recently edited in git working tree',
      ],
      scoreBreakdown: {
        baseScore: 0.54,
        semanticScore: 0.4,
        graphScore: 0.3,
        combinedScore: 0.94,
        lexicalScore: 0.12,
      },
      graphSignals: [
        { kind: 'graph_seed_symbol', value: 'loginUser', weight: 0.1 },
        { kind: 'graph_call_edge', value: 'loginUser->validateCredentials', weight: 0.06 },
        { kind: 'graph_import_path', value: 'loginUser:./session', weight: 0.04 },
      ],
    },
    selectionProvenance: {
      seedSymbols: ['loginUser'],
      neighborPaths: ['src/routes/loginRoute.ts'],
      selectionBasis: ['semantic_match', 'graph_seed_symbol'],
      graphStatus: 'ready',
    },
  };
}

describe('rankingReceipts', () => {
  it('projects explainability data into deterministic ranking receipts', () => {
    const receipt = buildRankingReceipt(buildFullFixtureInput());

    expect(receipt).toEqual({
      itemId: 'ctxi_login_handler',
      path: 'src/auth/login.ts',
      finalScore: 0.94,
      signals: [
        {
          name: 'exact_symbol_match',
          score: 0.54,
          explanation: 'Contains exact symbol loginUser; Seed symbol: loginUser',
        },
        {
          name: 'file_name_match',
          score: 0.12,
          explanation: 'File name aligns with query tokens (login); Lexical score with file-name alignment',
        },
        {
          name: 'semantic_similarity',
          score: 0.4,
          explanation: 'Semantic retrieval score component',
        },
        {
          name: 'graph_relationship',
          score: 0.3,
          explanation:
            'Graph call edge: loginUser->validateCredentials; Graph import path: loginUser:./session; Graph neighbor path: src/routes/loginRoute.ts; Graph seed symbol: loginUser; Graph-aware score component',
        },
        {
          name: 'git_recency',
          score: 0.54,
          explanation: 'Recently edited in git working tree',
        },
        {
          name: 'test_relationship',
          score: 0.54,
          explanation: 'Covered by auth login tests',
        },
        {
          name: 'entrypoint_relationship',
          score: 0.54,
          explanation: 'Called by /login route',
        },
      ],
    });
  });

  it('extracts graph-aware retrieval receipts from selectionExplainability only', () => {
    const receipt = buildRankingReceipt({
      path: 'src/auth/loginService.ts',
      selectionExplainability: {
        selectedBecause: ['graph seed symbol: loginService', 'graph call edge: loginService->validate'],
        scoreBreakdown: {
          baseScore: 0.71,
          graphScore: 0.1,
          combinedScore: 0.81,
          semanticScore: 0.71,
        },
        graphSignals: [
          { kind: 'graph_seed_symbol', value: 'loginService', weight: 0.1 },
          { kind: 'graph_call_edge', value: 'loginService->validate', weight: 0.06 },
        ],
      },
      selectionProvenance: {
        seedSymbols: ['loginService'],
        neighborPaths: ['src/auth/loginService.ts'],
        selectionBasis: ['graph seed symbol: loginService'],
      },
    });

    expect(receipt.finalScore).toBe(0.81);
    expect(receipt.signals.map((signal) => signal.name)).toEqual([
      'exact_symbol_match',
      'semantic_similarity',
      'graph_relationship',
    ]);
    expect(receipt.signals[0]?.explanation).toContain('graph seed symbol');
    expect(receipt.signals[2]?.explanation).toContain('Graph call edge');
  });

  it('adds test and entrypoint path heuristics without changing score ordering inputs', () => {
    const files: BuildRankingReceiptInput[] = [
      {
        path: 'tests/auth/login.test.ts',
        query: 'login',
        relevance: 0.62,
        selectionExplainability: {
          scoreBreakdown: {
            baseScore: 0.62,
            combinedScore: 0.62,
            semanticScore: 0.62,
          },
        },
      },
      {
        path: 'src/index.ts',
        query: 'bootstrap',
        relevance: 0.58,
        selectionExplainability: {
          scoreBreakdown: {
            baseScore: 0.58,
            combinedScore: 0.58,
          },
        },
      },
    ];

    const receipts = buildRankingReceiptsForFiles(files);

    expect(receipts[0]?.signals.some((signal) => signal.name === 'test_relationship')).toBe(true);
    expect(receipts[1]?.signals.some((signal) => signal.name === 'entrypoint_relationship')).toBe(true);
    expect(receipts.map((receipt) => receipt.finalScore)).toEqual([0.62, 0.58]);
  });

  it('returns stable receipts for identical inputs', () => {
    const input = buildFullFixtureInput();
    const first = buildRankingReceipt(input);
    const second = buildRankingReceipt({ ...input });

    expect(first).toEqual(second);
  });

  it('re-exports ranking helpers from ranking.ts', () => {
    const receipt = buildRankingReceiptReexport({
      path: 'src/auth/session.ts',
      relevance: 0.5,
      selectionExplainability: {
        selectedBecause: ['semantic match retained file after fallback'],
        scoreBreakdown: {
          baseScore: 0.5,
          combinedScore: 0.5,
          semanticScore: 0.5,
        },
      },
    });

    expect(receipt.path).toBe('src/auth/session.ts');
    expect(receipt.signals.some((signal) => signal.name === 'semantic_similarity')).toBe(true);
  });

  it('derives item ids from path when not provided', () => {
    const receipt = buildRankingReceipt({
      path: 'src/auth/login.ts',
      relevance: 0.4,
    });

    expect(receipt.itemId).toBe('rank_src_auth_login_ts');
  });
});
