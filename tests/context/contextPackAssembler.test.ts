import { describe, expect, it } from '@jest/globals';
import type { ContextBundle } from '../../src/mcp/serviceClient.js';
import {
  assembleContextPack,
  assembleContextPackWithTimestamp,
  computeContextPackId,
  computeContextPackItemId,
  estimateContextPackTokens,
} from '../../src/context/contextPackAssembler.js';
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PACK_LIMITS,
} from '../../src/context/types/contextPack.js';

function buildFixtureBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    summary: 'Authentication and session handling context.',
    query: 'user authentication login flow',
    files: [
      {
        path: 'src/auth/login.ts',
        extension: '.ts',
        summary: 'Login handler and JWT validation.',
        relevance: 0.92,
        tokenCount: 120,
        selectionRationale: 'Contains login handler',
        snippets: [
          {
            text: 'export async function login(email: string, password: string) {\n  return validateCredentials(email, password);\n}',
            lines: '10-14',
            relevance: 0.95,
            tokenCount: 40,
            codeType: 'function',
          },
          {
            text: 'function validateCredentials(email: string, password: string) {\n  // verify hash\n}',
            lines: '20-24',
            relevance: 0.88,
            tokenCount: 35,
            codeType: 'function',
          },
        ],
      },
      {
        path: 'src/auth/session.ts',
        extension: '.ts',
        summary: 'Session token storage.',
        relevance: 0.75,
        tokenCount: 60,
        snippets: [
          {
            text: 'export class SessionStore {\n  save(token: string) {}\n}',
            lines: '1-5',
            relevance: 0.75,
            tokenCount: 30,
            codeType: 'class',
          },
        ],
      },
    ],
    hints: ['Focus on JWT validation edge cases.', 'Check session expiry handling.'],
    memories: [
      {
        category: 'decisions',
        content: 'Use JWT for authentication because of stateless scaling.',
        relevanceScore: 0.8,
        title: 'Auth strategy',
        source: '.memories/decisions/auth.md',
      },
    ],
    externalReferences: [
      {
        type: 'docs_url',
        url: 'https://example.com/jwt',
        host: 'example.com',
        label: 'JWT docs',
        excerpt: 'JSON Web Tokens are an open standard for securely transmitting information.',
        status: 'used',
      },
    ],
    metadata: {
      totalFiles: 2,
      totalSnippets: 3,
      totalTokens: 180,
      tokenBudget: 8000,
      truncated: false,
      searchTimeMs: 42,
    },
    ...overrides,
  };
}

describe('contextPackAssembler', () => {
  it('assembles a Context Pack V3 from a ContextBundle', () => {
    const { pack } = assembleContextPackWithTimestamp(buildFixtureBundle(), '2026-05-31T00:00:00.000Z');

    expect(pack.schema_version).toBe(CONTEXT_PACK_SCHEMA_VERSION);
    expect(pack.query).toBe('user authentication login flow');
    expect(pack.id).toMatch(/^ctxp_[a-f0-9]{16}$/);
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.metadata.summary).toContain('Authentication');
    expect(pack.metadata.assembled_at).toBe('2026-05-31T00:00:00.000Z');
    expect(pack.metadata.search_time_ms).toBe(42);
  });

  it('flattens files, snippets, memories, hints, and external references into ordered items', () => {
    const { pack } = assembleContextPack(buildFixtureBundle());

    const kinds = pack.items.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === 'snippet')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'hint')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'memory')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'external')).toHaveLength(1);

    expect(pack.metadata.item_count).toBe(pack.items.length);
    expect(pack.metadata.file_count).toBe(2);
    expect(pack.items.every((item) => item.id.startsWith('ctxi_'))).toBe(true);
  });

  it('produces stable pack IDs for equivalent inputs', () => {
    const bundle = buildFixtureBundle();
    const first = assembleContextPack(bundle).pack;
    const second = assembleContextPack({ ...bundle, metadata: { ...bundle.metadata, searchTimeMs: 999 } }).pack;

    expect(first.id).toBe(second.id);
    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
  });

  it('changes pack ID when query or token budget changes', () => {
    const base = assembleContextPack(buildFixtureBundle()).pack;
    const queryChanged = assembleContextPack(
      buildFixtureBundle({ query: 'different query' })
    ).pack;
    const budgetChanged = assembleContextPack(buildFixtureBundle(), { tokenBudget: 4000 }).pack;

    expect(queryChanged.id).not.toBe(base.id);
    expect(budgetChanged.id).not.toBe(base.id);
  });

  it('accounts for token budget usage and marks truncation', () => {
    const largeSnippet = 'token '.repeat(400);
    const bundle = buildFixtureBundle({
      files: [
        {
          path: 'src/auth/login.ts',
          extension: '.ts',
          summary: 'Login handler.',
          relevance: 0.92,
          tokenCount: 500,
          snippets: [
            {
              text: largeSnippet,
              lines: '1-1',
              relevance: 0.95,
              tokenCount: 500,
            },
          ],
        },
        {
          path: 'src/auth/session.ts',
          extension: '.ts',
          summary: 'Session token storage.',
          relevance: 0.75,
          tokenCount: 500,
          snippets: [
            {
              text: largeSnippet,
              lines: '1-1',
              relevance: 0.75,
              tokenCount: 500,
            },
          ],
        },
      ],
      hints: [],
      memories: [],
      externalReferences: [],
    });
    const { pack } = assembleContextPack(bundle, { tokenBudget: 500 });

    expect(pack.token_budget.requested).toBe(500);
    expect(pack.token_budget.used).toBeLessThanOrEqual(500);
    expect(pack.token_budget.truncated).toBe(true);
    expect(pack.metadata.truncated).toBe(true);
    expect(pack.metadata.truncation_reasons).toContain('token_budget');
  });

  it('respects max item count limit', () => {
    const bundle = buildFixtureBundle();
    const { pack } = assembleContextPack(bundle, { maxItems: 2 });

    expect(pack.items).toHaveLength(2);
    expect(pack.metadata.truncated).toBe(true);
    expect(pack.metadata.truncation_reasons).toContain('max_items');
  });

  it('respects per-item and total content size limits', () => {
    const huge = 'x'.repeat(DEFAULT_CONTEXT_PACK_LIMITS.maxItemContentChars + 500);
    const bundle = buildFixtureBundle({
      files: [
        {
          path: 'src/huge.ts',
          extension: '.ts',
          summary: 'Huge file',
          relevance: 1,
          tokenCount: estimateContextPackTokens(huge),
          snippets: [{ text: huge, lines: '1-1', relevance: 1, tokenCount: estimateContextPackTokens(huge) }],
        },
      ],
      hints: [],
      memories: [],
      externalReferences: [],
    });

    const { pack: perItemLimited } = assembleContextPack(bundle, {
      maxItemContentChars: 1_000,
      tokenBudget: DEFAULT_CONTEXT_PACK_LIMITS.maxTokenBudget,
    });
    expect(perItemLimited.items[0].content.length).toBeLessThanOrEqual(1_000);
    expect(perItemLimited.metadata.truncation_reasons).toContain('max_item_content_chars');

    const manyFiles = Array.from({ length: 20 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      extension: '.ts',
      summary: `summary ${index}`,
      relevance: 0.5,
      tokenCount: 100,
      snippets: [
        {
          text: 'a'.repeat(5_000),
          lines: '1-10',
          relevance: 0.5,
          tokenCount: 1_250,
        },
      ],
    }));

    const { pack: totalLimited } = assembleContextPack(
      buildFixtureBundle({ files: manyFiles, hints: [], memories: [], externalReferences: [] }),
      {
        maxTotalContentChars: 12_000,
        tokenBudget: DEFAULT_CONTEXT_PACK_LIMITS.maxTokenBudget,
      }
    );

    const totalChars = totalLimited.items.reduce((sum, item) => sum + item.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(12_000);
    expect(totalLimited.metadata.truncation_reasons).toContain('max_total_content_chars');
  });

  it('uses file-level fallback when a file has no snippets', () => {
    const bundle = buildFixtureBundle({
      files: [
        {
          path: 'src/empty-snippets.ts',
          extension: '.ts',
          summary: 'Metadata-only file context.',
          relevance: 0.6,
          tokenCount: 10,
          snippets: [],
          selectionRationale: 'filename match',
        },
      ],
      hints: [],
      memories: [],
      externalReferences: [],
    });

    const { pack } = assembleContextPack(bundle);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].kind).toBe('file');
    expect(pack.items[0].content).toBe('Metadata-only file context.');
  });
});

describe('context pack id helpers', () => {
  it('computes deterministic item ids', () => {
    const first = computeContextPackItemId('snippet', 'src/a.ts', 0, 'content');
    const second = computeContextPackItemId('snippet', 'src/a.ts', 0, 'content');
    const different = computeContextPackItemId('snippet', 'src/a.ts', 1, 'content');

    expect(first).toBe(second);
    expect(first).toMatch(/^ctxi_[a-f0-9]{16}$/);
    expect(different).not.toBe(first);
  });

  it('computes deterministic pack ids from sorted fingerprints', () => {
    const id = computeContextPackId({
      query: 'auth flow',
      tokenBudget: 8000,
      itemFingerprints: ['b', 'a', 'c'],
    });
    const reordered = computeContextPackId({
      query: 'auth flow',
      tokenBudget: 8000,
      itemFingerprints: ['c', 'b', 'a'],
    });

    expect(id).toBe(reordered);
    expect(id).toMatch(/^ctxp_[a-f0-9]{16}$/);
  });

  it('estimates tokens conservatively', () => {
    expect(estimateContextPackTokens('')).toBe(0);
    expect(estimateContextPackTokens('abcd')).toBe(1);
    expect(estimateContextPackTokens('a'.repeat(8))).toBe(2);
  });
});
