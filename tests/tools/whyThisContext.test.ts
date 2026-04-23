import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  handleWhyThisContext,
  whyThisContextTool,
} from '../../src/mcp/tools/whyThisContext.js';
import type { ContextBundle } from '../../src/mcp/serviceClient.js';

function createContextBundle(): ContextBundle {
  return {
    summary: 'Selected auth context.',
    query: 'login flow',
    files: [
      {
        path: 'src/auth/loginService.ts',
        extension: '.ts',
        summary: 'Handles login token exchange.',
        relevance: 0.91,
        tokenCount: 240,
        snippets: [
          {
            text: 'export async function login() {}',
            lines: '10-18',
            relevance: 0.91,
            tokenCount: 42,
            codeType: 'function',
          },
        ],
        relatedFiles: ['src/auth/session.ts'],
        selectionRationale: 'Legacy top-ranked file.',
      } as unknown as ContextBundle['files'][number] & {
        selectionExplainability?: unknown;
        selectionProvenance?: unknown;
      },
      {
        path: 'src/auth/session.ts',
        extension: '.ts',
        summary: 'Persists session state.',
        relevance: 0.71,
        tokenCount: 180,
        snippets: [
          {
            text: 'export function writeSession() {}',
            lines: '5-11',
            relevance: 0.71,
            tokenCount: 35,
            codeType: 'function',
          },
        ],
      } as unknown as ContextBundle['files'][number] & {
        selectionExplainability?: unknown;
        selectionProvenance?: unknown;
      },
    ],
    hints: ['Memories: 1 relevant entries from facts'],
    metadata: {
      totalFiles: 2,
      totalSnippets: 2,
      totalTokens: 420,
      tokenBudget: 8000,
      truncated: false,
      searchTimeMs: 35,
    },
  };
}

describe('why_this_context tool', () => {
  let mockServiceClient: {
    getContextForPrompt: ReturnType<typeof jest.fn>;
  };

  beforeEach(() => {
    mockServiceClient = {
      getContextForPrompt: jest.fn(async () => {
        const bundle = createContextBundle();
        const explainableFile = bundle.files[0] as typeof bundle.files[0] & {
          selectionExplainability?: unknown;
          selectionProvenance?: unknown;
        };
        explainableFile.selectionExplainability = {
          selectedBecause: [
            'graph seed symbol matched loginService',
            'graph definition neighbor increased rank',
          ],
          scoreBreakdown: {
            baseScore: 0.81,
            graphScore: 0.1,
            combinedScore: 0.91,
          },
          graphSignals: [
            {
              kind: 'graph_seed_symbol',
              value: 'loginService',
              weight: 0.08,
            },
          ],
        };
        explainableFile.selectionProvenance = {
          graphStatus: 'ready',
          graphDegradedReason: null,
          seedSymbols: ['loginService'],
          neighborPaths: ['src/auth/loginService.ts'],
          selectionBasis: ['semantic_match', 'graph_seed_symbol'],
        };
        return bundle;
      }),
    };
  });

  it('explains selected context files using the shared provenance and explainability contract', async () => {
    const parsed = JSON.parse(await handleWhyThisContext({ query: ' login flow ' }, mockServiceClient as any));

    expect(parsed).toEqual({
      query: 'login flow',
      summary: 'Selected auth context.',
      files: [
        expect.objectContaining({
          path: 'src/auth/loginService.ts',
          explainability: expect.objectContaining({
            selected_because: [
              'graph seed symbol matched loginService',
              'graph definition neighbor increased rank',
            ],
            score_breakdown: {
              base_score: 0.81,
              graph_score: 0.1,
              combined_score: 0.91,
            },
          }),
          provenance: expect.objectContaining({
            graph_status: 'ready',
            graph_degraded_reason: null,
            seed_symbols: ['loginService'],
            neighbor_paths: ['src/auth/loginService.ts'],
            selection_basis: ['semantic_match', 'graph_seed_symbol'],
          }),
        }),
        expect.objectContaining({
          path: 'src/auth/session.ts',
          explainability: null,
          provenance: null,
          degraded: true,
          degraded_reasons: ['selection_receipts_missing'],
        }),
      ],
      metadata: expect.objectContaining({
        explainable_file_count: 1,
        total_files: 2,
        degraded: true,
        degraded_reasons: ['selection_receipts_missing'],
        analysis_scope: 'context_selection_receipts_only',
        deterministic: true,
      }),
    });

    expect(mockServiceClient.getContextForPrompt).toHaveBeenCalledWith('login flow', expect.objectContaining({
      maxFiles: 5,
      tokenBudget: 8000,
      includeRelated: true,
      minRelevance: 0.3,
      bypassCache: false,
    }));
  });

  it('makes degraded graph mode explicit and deterministic when provenance says the graph is stale', async () => {
    mockServiceClient.getContextForPrompt.mockImplementationOnce(async () => {
      const bundle = createContextBundle();
      const explainableFile = bundle.files[0] as typeof bundle.files[0] & {
        selectionExplainability?: unknown;
        selectionProvenance?: unknown;
      };
      explainableFile.selectionExplainability = {
        selectedBecause: ['semantic match retained file after fallback'],
        scoreBreakdown: {
          baseScore: 0.7,
          graphScore: 0,
          combinedScore: 0.7,
        },
      };
      explainableFile.selectionProvenance = {
        graphStatus: 'stale',
        graphDegradedReason: 'graph_stale',
        seedSymbols: [],
        neighborPaths: [],
        selectionBasis: ['semantic_match'],
      };
      return bundle;
    });

    const parsed = JSON.parse(await handleWhyThisContext({ query: 'login flow', max_files: 1 }, mockServiceClient as any));

    expect(parsed.files[0]).toEqual(expect.objectContaining({
      degraded: true,
      degraded_reasons: ['graph_stale'],
      provenance: expect.objectContaining({
        graph_status: 'stale',
        graph_degraded_reason: 'graph_stale',
      }),
    }));
    expect(parsed.metadata).toEqual(expect.objectContaining({
      degraded: true,
      degraded_reasons: expect.arrayContaining(['graph_stale']),
    }));
  });

  it('validates required input and supports scoped retrieval knobs', async () => {
    await expect(handleWhyThisContext({ query: '   ' }, mockServiceClient as any)).rejects.toThrow(/query/i);

    await handleWhyThisContext({
      query: 'auth flow',
      max_files: 3,
      token_budget: 5000,
      min_relevance: 0.4,
      include_related: false,
      bypass_cache: true,
      include_paths: ['src/auth/**'],
      exclude_paths: ['**/*.test.ts'],
    }, mockServiceClient as any);

    expect(mockServiceClient.getContextForPrompt).toHaveBeenLastCalledWith('auth flow', expect.objectContaining({
      maxFiles: 3,
      tokenBudget: 5000,
      includeRelated: false,
      minRelevance: 0.4,
      bypassCache: true,
      includePaths: ['src/auth/**'],
      excludePaths: ['**/*.test.ts'],
    }));
  });

  it('exports a stable additive schema', () => {
    expect(whyThisContextTool).toMatchInlineSnapshot(`
{
  "description": "Explain why files were selected into a context bundle using the shared retrieval provenance and explainability contract.

This tool reuses the same selection vocabulary exposed by graph-aware retrieval and get_context_for_prompt instead of inventing a parallel explanation path.",
  "inputSchema": {
    "properties": {
      "bypass_cache": {
        "description": "When true, bypass caches for this call.",
        "type": "boolean",
      },
      "exclude_paths": {
        "description": "Optional workspace-relative glob filters to exclude matching paths after include filtering.",
        "items": {
          "type": "string",
        },
        "type": "array",
      },
      "include_paths": {
        "description": "Optional workspace-relative glob filters to include matching paths only.",
        "items": {
          "type": "string",
        },
        "type": "array",
      },
      "include_related": {
        "description": "Whether to include related-file expansion before summarizing why files were selected. Defaults to true.",
        "type": "boolean",
      },
      "max_files": {
        "description": "Maximum number of files to inspect from the context bundle (1-20). Defaults to 5.",
        "maximum": 20,
        "minimum": 1,
        "type": "integer",
      },
      "min_relevance": {
        "description": "Minimum relevance score (0-1) to include a file. Defaults to 0.3.",
        "maximum": 1,
        "minimum": 0,
        "type": "number",
      },
      "query": {
        "description": "Natural-language request whose selected context you want explained.",
        "type": "string",
      },
      "token_budget": {
        "description": "Token budget to forward into context retrieval before explaining the selected files. Defaults to 8000.",
        "maximum": 100000,
        "minimum": 500,
        "type": "integer",
      },
    },
    "required": [
      "query",
    ],
    "type": "object",
  },
  "name": "why_this_context",
}
`);
  });
});
