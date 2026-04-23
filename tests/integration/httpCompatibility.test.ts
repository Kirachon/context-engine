import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import { REQUEST_ID_HEADER } from '../../src/http/middleware/logging.js';
import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { getPlanPersistenceService, initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

type MockSearchResult = {
  path: string;
  content: string;
  relevanceScore?: number;
  score?: number;
  lines?: string;
};

type MockServiceClient = {
  getIndexStatus: ReturnType<typeof jest.fn>;
  indexWorkspace: ReturnType<typeof jest.fn>;
  indexWorkspaceInBackground: ReturnType<typeof jest.fn>;
  semanticSearch: ReturnType<typeof jest.fn>;
  symbolSearch: ReturnType<typeof jest.fn>;
  symbolReferencesSearch: ReturnType<typeof jest.fn>;
  symbolDefinition: ReturnType<typeof jest.fn>;
  callRelationships: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
  getWorkspacePath: ReturnType<typeof jest.fn>;
  getFile: ReturnType<typeof jest.fn>;
  searchAndAsk: ReturnType<typeof jest.fn>;
};

function createMockServiceClient(): MockServiceClient {
  const searchResults: MockSearchResult[] = [
    {
      path: 'src/auth.ts',
      content: 'export function login() {}',
      relevanceScore: 0.91,
      lines: '1-1',
    },
    {
      path: 'src/session.ts',
      content: 'export function startSession() {}',
      score: 0.73,
      lines: '3-5',
    },
  ];

  return {
    getIndexStatus: jest.fn(() => ({
      workspace: '/tmp/workspace',
      lastIndexed: '2026-04-10T00:00:00.000Z',
      fileCount: 12,
      isStale: false,
    })),
    indexWorkspace: jest.fn(async () => ({
      filesIndexed: 12,
      chunksCreated: 34,
    })),
    indexWorkspaceInBackground: jest.fn(async () => undefined),
    semanticSearch: jest.fn(async (_query: string, topK: number) => searchResults.slice(0, topK)),
    symbolSearch: jest.fn(async (_symbol: string, topK: number) => searchResults.slice(0, topK)),
    symbolReferencesSearch: jest.fn(async (_symbol: string, topK: number) => searchResults.slice(0, topK)),
    symbolDefinition: jest.fn(async (symbol: string) => ({
      found: true,
      symbol,
      file: 'src/auth.ts',
      line: 1,
      column: 1,
      kind: 'function' as const,
      snippet: 'export function login() {}',
      score: 123.45,
    })),
    callRelationships: jest.fn(async (symbol: string, options?: { direction?: string }) => ({
      symbol,
      callers: [
        {
          file: 'src/handler.ts',
          line: 7,
          column: 3,
          score: 80,
          callerSymbol: 'handle',
          snippet: '  login();',
        },
      ],
      callees: [
        {
          calleeSymbol: 'logEvent',
          file: 'src/auth.ts',
          line: 2,
          column: 3,
          score: 10,
          snippet: '  logEvent();',
        },
      ],
      metadata: {
        symbol,
        direction: (options?.direction ?? 'both') as 'callers' | 'callees' | 'both',
        totalCallers: 1,
        totalCallees: 1,
        consideredFiles: 5,
        cacheBypassed: false,
      },
    })),
    getContextForPrompt: jest.fn(async (query: string, options: Record<string, unknown>) => ({
      query,
      files: [{ path: 'README.md', relevanceScore: 0.88 }],
      externalReferences: Array.isArray(options.externalSources)
        ? [{ url: (options.externalSources[0] as { url: string }).url, excerpt: 'external snippet' }]
        : undefined,
      metadata: {
        tokenBudget: options.tokenBudget ?? 8000,
        externalSourcesRequested: Array.isArray(options.externalSources) ? options.externalSources.length : 0,
      },
    })),
    getWorkspacePath: jest.fn(() => process.cwd()),
    getFile: jest.fn(async (filePath: string) => `contents:${filePath}`),
    searchAndAsk: jest.fn(async (query: string) => `ENHANCED:${query}`),
  };
}

function createApp(serviceClient = createMockServiceClient()) {
  const server = new ContextEngineHttpServer(serviceClient as never, {
    port: 0,
    version: '9.9.9',
  });

  return {
    app: server.getApp(),
    serviceClient,
  };
}

function collectRegisteredRoutes(app: ReturnType<typeof createApp>['app']): string[] {
  const routes: string[] = [];

  for (const layer of app.router.stack as Array<{ handle?: { stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> } }>) {
    const nested = layer.handle?.stack ?? [];
    for (const child of nested) {
      const routePath = child.route?.path;
      const methods = child.route?.methods ?? {};
      if (!routePath) {
        continue;
      }

      const prefix = routePath === '/health' ? '' : '/api/v1';
      for (const method of Object.keys(methods)) {
        routes.push(`${method.toUpperCase()} ${prefix}${routePath}`);
      }
    }
  }

  return routes;
}

function parseSseJsonPayload(text: string): Record<string, unknown> {
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '));

  if (!dataLine) {
    throw new Error(`Missing SSE data payload: ${text}`);
  }

  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

describe('HTTP compatibility harness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers the current health and /api/v1 route inventory', () => {
    const { app } = createApp();

    expect(collectRegisteredRoutes(app)).toEqual([
      'GET /health',
      'GET /api/v1/status',
      'GET /api/v1/retrieval/status',
      'POST /api/v1/index',
      'POST /api/v1/search',
      'POST /api/v1/symbol-search',
      'POST /api/v1/symbol-references',
      'POST /api/v1/find-callers',
      'POST /api/v1/find-callees',
      'POST /api/v1/symbol-definition',
      'POST /api/v1/call-relationships',
      'POST /api/v1/trace-symbol',
      'POST /api/v1/impact-analysis',
      'POST /api/v1/codebase-retrieval',
      'POST /api/v1/enhance-prompt',
      'POST /api/v1/plan',
      'POST /api/v1/context',
      'POST /api/v1/why-this-context',
      'POST /api/v1/file',
      'POST /api/v1/tool-manifest',
      'POST /api/v1/review-changes',
      'POST /api/v1/review-git-diff',
      'POST /api/v1/review-auto',
    ]);
  });

  it('preserves GET /api/v1/status response shape', async () => {
    const { app, serviceClient } = createApp();

    const response = await request(app).get('/api/v1/status');

    expect(response.status).toBe(200);
    expect(typeof response.headers[REQUEST_ID_HEADER]).toBe('string');
    expect((response.headers[REQUEST_ID_HEADER] as string).length).toBeGreaterThan(0);
    expect(response.body).toEqual(serviceClient.getIndexStatus.mock.results[0]?.value);
  });

  it('preserves POST /api/v1/index response shapes for foreground and background runs', async () => {
    const { app, serviceClient } = createApp();

    const foreground = await request(app).post('/api/v1/index').send({});
    expect(foreground.status).toBe(200);
    expect(foreground.body).toEqual({
      success: true,
      filesIndexed: 12,
      chunksCreated: 34,
    });

    const background = await request(app).post('/api/v1/index').send({ background: true });
    expect(background.status).toBe(200);
    expect(background.body).toEqual({
      success: true,
      message: 'Indexing started in background',
    });
    expect(serviceClient.indexWorkspace).toHaveBeenCalledTimes(1);
    expect(serviceClient.indexWorkspaceInBackground).toHaveBeenCalledTimes(1);
  });

  it('preserves 400 validation envelopes for required request bodies', async () => {
    const { app } = createApp();

    const cases = [
      {
        path: '/api/v1/search',
        expected: { error: 'query is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/symbol-search',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/symbol-references',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/find-callers',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/find-callees',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/symbol-definition',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/call-relationships',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/trace-symbol',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/impact-analysis',
        expected: { error: 'symbol is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/codebase-retrieval',
        expected: { error: 'query is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/enhance-prompt',
        expected: { error: 'prompt is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/plan',
        expected: { error: 'task is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/context',
        expected: { error: 'query is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/why-this-context',
        expected: { error: 'query is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/file',
        expected: { error: 'path is required and must be a string', statusCode: 400 },
      },
      {
        path: '/api/v1/review-changes',
        expected: { error: 'diff is required and must be a string', statusCode: 400 },
      },
    ];

    for (const testCase of cases) {
      const response = await request(app).post(testCase.path).send({});
      expect(response.status).toBe(400);
      expect(response.body).toEqual(testCase.expected);
    }
  });

  it('preserves POST /api/v1/search response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/search').send({
      query: 'auth flow',
      top_k: 1,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [
        {
          path: 'src/auth.ts',
          content: 'export function login() {}',
          relevanceScore: 0.91,
          lines: '1-1',
        },
      ],
      metadata: {
        query: 'auth flow',
        top_k: 1,
        resultCount: 1,
      },
    });
  });

  it('preserves POST /api/v1/symbol-search response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/symbol-search').send({
      symbol: 'resolveAIProviderId',
      top_k: 1,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [
        {
          path: 'src/auth.ts',
          content: 'export function login() {}',
          relevanceScore: 0.91,
          lines: '1-1',
        },
      ],
      metadata: {
        symbol: 'resolveAIProviderId',
        top_k: 1,
        resultCount: 1,
      },
    });
  });

  it('preserves POST /api/v1/symbol-references response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/symbol-references').send({
      symbol: 'resolveAIProviderId',
      top_k: 1,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [
        {
          path: 'src/auth.ts',
          content: 'export function login() {}',
          relevanceScore: 0.91,
          lines: '1-1',
        },
      ],
      metadata: {
        symbol: 'resolveAIProviderId',
        top_k: 1,
        resultCount: 1,
      },
    });
  });

  it('preserves POST /api/v1/find-callers and /api/v1/find-callees response shapes', async () => {
    const { app } = createApp();

    const callersResponse = await request(app).post('/api/v1/find-callers').send({
      symbol: 'login',
      top_k: 5,
    });
    expect(callersResponse.status).toBe(200);
    expect(callersResponse.body).toEqual(
      expect.objectContaining({
        symbol: 'login',
        callers: [
          expect.objectContaining({
            file: 'src/handler.ts',
            line: 7,
            callerSymbol: 'handle',
          }),
        ],
        metadata: expect.objectContaining({
          requested_top_k: 5,
          analysis_scope: 'direct_callers_only',
          deterministic: true,
        }),
      })
    );

    const calleesResponse = await request(app).post('/api/v1/find-callees').send({
      symbol: 'login',
      top_k: 5,
    });
    expect(calleesResponse.status).toBe(200);
    expect(calleesResponse.body).toEqual(
      expect.objectContaining({
        symbol: 'login',
        callees: [
          expect.objectContaining({
            file: 'src/auth.ts',
            line: 2,
            calleeSymbol: 'logEvent',
          }),
        ],
        metadata: expect.objectContaining({
          requested_top_k: 5,
          analysis_scope: 'direct_callees_only',
          deterministic: true,
        }),
      })
    );
  });

  it('preserves POST /api/v1/symbol-definition response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/symbol-definition').send({
      symbol: 'resolveAIProviderId',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      result: {
        found: true,
        symbol: 'resolveAIProviderId',
        file: 'src/auth.ts',
        line: 1,
        column: 1,
        kind: 'function',
        snippet: 'export function login() {}',
        score: 123.45,
      },
      metadata: {
        symbol: 'resolveAIProviderId',
        found: true,
      },
    });
  });

  it('preserves POST /api/v1/call-relationships response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/call-relationships').send({
      symbol: 'login',
      direction: 'both',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      result: {
        symbol: 'login',
        callers: [
          {
            file: 'src/handler.ts',
            line: 7,
            column: 3,
            score: 80,
            callerSymbol: 'handle',
            snippet: '  login();',
          },
        ],
        callees: [
          {
            calleeSymbol: 'logEvent',
            file: 'src/auth.ts',
            line: 2,
            column: 3,
            score: 10,
            snippet: '  logEvent();',
          },
        ],
        metadata: {
          symbol: 'login',
          direction: 'both',
          totalCallers: 1,
          totalCallees: 1,
          consideredFiles: 5,
          cacheBypassed: false,
        },
      },
      metadata: {
        symbol: 'login',
        direction: 'both',
        totalCallers: 1,
        totalCallees: 1,
      },
    });
  });

  it('preserves POST /api/v1/trace-symbol and /api/v1/impact-analysis response shapes', async () => {
    const { app } = createApp();

    const traceResponse = await request(app).post('/api/v1/trace-symbol').send({
      symbol: 'login',
      top_k: 5,
    });
    expect(traceResponse.status).toBe(200);
    expect(traceResponse.body).toEqual(
      expect.objectContaining({
        symbol: 'login',
        definition: expect.objectContaining({
          found: true,
          file: 'src/auth.ts',
        }),
        trace_summary: expect.objectContaining({
          definition_found: true,
          reference_count: 2,
          caller_count: 1,
          callee_count: 1,
        }),
        metadata: expect.objectContaining({
          requested_top_k: 5,
          analysis_scope: 'direct_definition_references_and_call_edges_only',
          deterministic: true,
        }),
      })
    );

    const impactResponse = await request(app).post('/api/v1/impact-analysis').send({
      symbol: 'login',
      top_k: 5,
    });
    expect(impactResponse.status).toBe(200);
    expect(impactResponse.body).toEqual(
      expect.objectContaining({
        symbol: 'login',
        impact_summary: expect.objectContaining({
          direct_reference_count: 2,
          direct_caller_count: 1,
          direct_callee_count: 1,
          impacted_file_count: 3,
        }),
        metadata: expect.objectContaining({
          requested_top_k: 5,
          analysis_scope: 'direct_definition_references_and_call_edges_only',
          deterministic: true,
        }),
      })
    );
  });

  it('preserves POST /api/v1/codebase-retrieval response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/codebase-retrieval').send({
      query: 'auth flow',
      top_k: 2,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        results: [
          expect.objectContaining({
            path: 'src/auth.ts',
            file: 'src/auth.ts',
            content: 'export function login() {}',
            score: expect.any(Number),
            lines: '1-1',
            reason: 'Semantic match for: "auth flow"',
            provenance: expect.objectContaining({
              graph_status: expect.any(String),
            }),
            explainability: expect.objectContaining({
              score_breakdown: expect.any(Object),
            }),
          }),
          expect.objectContaining({
            path: 'src/session.ts',
            file: 'src/session.ts',
            content: 'export function startSession() {}',
            score: expect.any(Number),
            lines: '3-5',
            reason: 'Semantic match for: "auth flow"',
            provenance: expect.objectContaining({
              graph_status: expect.any(String),
            }),
            explainability: expect.objectContaining({
              score_breakdown: expect.any(Object),
            }),
          }),
        ],
        metadata: expect.objectContaining({
          query: 'auth flow',
          top_k: 2,
          resultCount: 2,
          workspace: '/tmp/workspace',
          lastIndexed: '2026-04-10T00:00:00.000Z',
          totalResults: 2,
          query_mode: 'semantic',
          fallback_state: expect.any(String),
        }),
      })
    );
  });

  it('preserves POST /api/v1/context and /api/v1/file response shapes', async () => {
    const { app } = createApp();

    const contextResponse = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
      options: { tokenBudget: 1200 },
    });
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.body).toEqual({
      query: 'auth flow',
      files: [{ path: 'README.md', relevanceScore: 0.88 }],
      metadata: {
        tokenBudget: 1200,
        externalSourcesRequested: 0,
      },
    });

    const fileResponse = await request(app).post('/api/v1/file').send({
      path: 'README.md',
    });
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.body).toEqual({
      path: 'README.md',
      content: 'contents:README.md',
    });
  });

  it('preserves POST /api/v1/why-this-context response shape with additive explainability receipts', async () => {
    const { app, serviceClient } = createApp();
    serviceClient.getContextForPrompt.mockResolvedValueOnce({
      summary: 'Selected files for auth flow.',
      files: [
        {
          path: 'README.md',
          summary: 'Auth overview',
          relevance: 0.88,
          snippets: [{ preview: 'auth flow' }],
          relatedFiles: ['src/auth.ts'],
          selectionExplainability: {
            selectedBecause: ['semantic_match', 'graph_neighbor'],
            scoreBreakdown: {
              baseScore: 0.5,
              graphScore: 0.2,
              combinedScore: 0.7,
              semanticScore: 0.5,
            },
            graphSignals: [{ kind: 'neighbor_path', value: 'src/auth.ts', weight: 0.2 }],
          },
          selectionProvenance: {
            graphStatus: 'ready',
            graphDegradedReason: null,
            seedSymbols: ['login'],
            neighborPaths: ['src/auth.ts'],
            selectionBasis: ['semantic', 'graph'],
          },
        },
      ],
      metadata: {
        searchTimeMs: 12,
      },
    });

    const response = await request(app).post('/api/v1/why-this-context').send({
      query: 'auth flow',
      max_files: 3,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        query: 'auth flow',
        files: [
          expect.objectContaining({
            path: 'README.md',
            explainability: expect.objectContaining({
              selected_because: ['semantic_match', 'graph_neighbor'],
            }),
            provenance: expect.objectContaining({
              graph_status: 'ready',
              seed_symbols: ['login'],
            }),
            degraded: false,
          }),
        ],
        metadata: expect.objectContaining({
          total_files: 1,
          explainable_file_count: 1,
          deterministic: true,
        }),
      })
    );
  });

  it('preserves POST /api/v1/tool-manifest response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/tool-manifest').send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual(getToolManifest());
  });

  it('preserves POST /api/v1/context when options is omitted and rejects invalid options shapes', async () => {
    const { app, serviceClient } = createApp();

    const withoutOptions = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
    });

    expect(withoutOptions.status).toBe(200);
    expect(withoutOptions.body).toEqual({
      query: 'auth flow',
      files: [{ path: 'README.md', relevanceScore: 0.88 }],
      metadata: {
        tokenBudget: 8000,
        externalSourcesRequested: 0,
      },
    });
    expect(serviceClient.getContextForPrompt).toHaveBeenCalledWith('auth flow', expect.objectContaining({}));

    const invalidOptions = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
      options: [],
    });

    expect(invalidOptions.status).toBe(400);
    expect(invalidOptions.body).toEqual({
      error: 'options must be an object when provided',
      statusCode: 400,
    });
  });

  it('accepts external_sources on /api/v1/context and forwards normalized entries', async () => {
    const { app, serviceClient } = createApp();

    const response = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
      options: {
        external_sources: [{ type: 'docs_url', url: 'https://example.com/docs#intro' }],
      },
    });

    expect(response.status).toBe(200);
    expect(serviceClient.getContextForPrompt).toHaveBeenCalledWith(
      'auth flow',
      expect.objectContaining({
        externalSources: [
          expect.objectContaining({
            type: 'docs_url',
            url: 'https://example.com/docs',
          }),
        ],
      })
    );
    expect(response.body.externalReferences).toEqual([
      { url: 'https://example.com/docs', excerpt: 'external snippet' },
    ]);
  });

  it('adds a raw handoff field on /api/v1/context active-plan requests without pushing handoff into retrieval', async () => {
    const { app, serviceClient } = createApp();
    const tempDir = await createHandoffWorkspace('plan-123');
    serviceClient.getWorkspacePath.mockReturnValue(tempDir);

    try {
      const response = await request(app).post('/api/v1/context').send({
        query: 'auth flow',
        options: {
          handoff_mode: 'active_plan',
          plan_id: 'plan-123',
        },
      });

      expect(response.status).toBe(200);
      expect(serviceClient.getContextForPrompt).toHaveBeenCalledWith(
        'auth flow',
        expect.objectContaining({
          includeMemories: false,
          includeDraftMemories: false,
        })
      );
      expect(serviceClient.getContextForPrompt).toHaveBeenCalledWith(
        'auth flow',
        expect.not.objectContaining({
          handoffMode: expect.anything(),
          planId: expect.anything(),
        })
      );
      expect(response.body.handoff).toEqual(
        expect.objectContaining({
          mode: 'active_plan',
          plan_id: 'plan-123',
          status: 'ready',
          payload: expect.objectContaining({
            objective: 'Deliver the shared handoff core slice',
          }),
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid additive handoff options on /api/v1/context', async () => {
    const { app } = createApp();

    const invalidMode = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
      options: {
        handoff_mode: 'later',
      },
    });

    expect(invalidMode.status).toBe(400);
    expect(invalidMode.body).toEqual({
      error: 'options.handoff_mode must be one of none, active_plan',
      statusCode: 400,
    });

    const missingPlanId = await request(app).post('/api/v1/context').send({
      query: 'auth flow',
      options: {
        handoff_mode: 'active_plan',
      },
    });

    expect(missingPlanId.status).toBe(400);
    expect(missingPlanId.body).toEqual({
      error: 'options.plan_id is required when options.handoff_mode is active_plan',
      statusCode: 400,
    });
  });

  it('returns structured handoff diagnostics on /api/v1/context when the plan is missing', async () => {
    const { app } = createApp();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-http-missing-plan-'));
    initializePlanManagementServices(tempDir);

    try {
      const response = await request(app).post('/api/v1/context').send({
        query: 'auth flow',
        options: {
          handoff_mode: 'active_plan',
          plan_id: 'plan-missing',
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.handoff).toEqual({
        mode: 'active_plan',
        plan_id: 'plan-missing',
        status: 'unavailable',
        diagnostics: [
          {
            reason: 'plan_not_found',
            message: 'No persisted plan metadata found for plan-missing.',
          },
        ],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps REST tool routes aligned with manifest discoverability parity metadata', () => {
    const { app } = createApp();
    const registeredPostRoutes = collectRegisteredRoutes(app)
      .filter((route) => route.startsWith('POST /api/v1/'))
      .map((route) => route.slice('POST '.length))
      .sort((left, right) => left.localeCompare(right));

    const parityPaths = listRestApiToolMappings()
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right));

    expect(parityPaths).toEqual(
      expect.arrayContaining([
        '/api/v1/codebase-retrieval',
        '/api/v1/find-callers',
        '/api/v1/find-callees',
        '/api/v1/trace-symbol',
        '/api/v1/impact-analysis',
        '/api/v1/why-this-context',
        '/api/v1/tool-manifest',
      ])
    );
    expect(registeredPostRoutes).toEqual(expect.arrayContaining(parityPaths));
  });

  it('keeps stdio MCP, streamable HTTP MCP, and manifest tool inventories aligned', async () => {
    const { app } = createApp();

    const initializeResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-compatibility-test', version: '1.0.0' },
        },
      });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers['mcp-session-id'] as string;
    expect(typeof sessionId).toBe('string');

    const initializedResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
    expect([200, 202, 204]).toContain(initializedResponse.status);

    const toolsListResponse = await request(app)
      .post('/mcp')
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

    expect(toolsListResponse.status).toBe(200);
    const toolsListPayload = parseSseJsonPayload(toolsListResponse.text);
    const httpMcpToolNames = (((toolsListPayload.result as { tools?: Array<{ name: string }> })?.tools) ?? [])
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right));
    const stdioToolNames = buildToolRegistryEntries({} as never)
      .map((entry) => entry.tool.name)
      .sort((left, right) => left.localeCompare(right));
    const manifestToolNames = [...getToolManifest().tools].sort((left, right) => left.localeCompare(right));

    expect(httpMcpToolNames).toEqual(stdioToolNames);
    expect(httpMcpToolNames).toEqual(manifestToolNames);
  });
});

async function createHandoffWorkspace(planId: string): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-http-handoff-'));
  initializePlanManagementServices(tempDir);
  const saveResult = await getPlanPersistenceService().savePlan(createPersistedPlan(planId), { overwrite: true });
  if (!saveResult.success) {
    throw new Error(saveResult.error ?? `Failed to save plan ${planId}`);
  }

  fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.memories', 'decisions.md'),
    [
      '# Decisions',
      '',
      'This file stores architecture decisions.',
      '',
      '### [2026-04-17] Shared handoff contract',
      '- Keep the handoff payload fixed.',
      `- [meta] linked_plans: ${planId}`,
      '- [meta] created_at: 2026-04-17T00:00:00.000Z',
      '- [meta] updated_at: 2026-04-17T00:00:00.000Z',
      '',
      '### [2026-04-18] Linked review finding',
      '- Retrieval routing must not change.',
      '- [meta] subtype: review_finding',
      `- [meta] linked_plans: ${planId}`,
      '- [meta] linked_files: src/mcp/serviceClient.ts',
      '- [meta] updated_at: 2026-04-18T12:00:00.000Z',
      '- [meta] created_at: 2026-04-18T12:00:00.000Z',
      '',
    ].join('\n'),
    'utf-8'
  );

  return tempDir;
}

function createPersistedPlan(id: string) {
  return {
    id,
    version: 3,
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T12:00:00.000Z',
    goal: 'Deliver the shared handoff core slice',
    scope: {
      included: ['shared handoff composer', 'durable adapters'],
      excluded: ['HTTP route edits'],
      assumptions: ['plan services are initialized'],
      constraints: ['keep retrieval routing unchanged', 'exclude draft suggestions'],
    },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: {
      notes: 'Keep composition above ContextServiceClient.',
      patterns_used: ['adapter', 'composer'],
      diagrams: [],
    },
    risks: [
      {
        issue: 'Shared payload drifts from fixed contract',
        mitigation: 'Snapshot the top-level keys',
        likelihood: 'medium' as const,
        impact: 'handoff consumers break',
      },
    ],
    milestones: [],
    steps: [
      {
        step_number: 1,
        id: 'step-1',
        title: 'Add shared adapters',
        description: 'Create read-only plan and memory adapters.',
        files_to_modify: [{
          path: 'src/mcp/tools/planManagement.ts',
          change_type: 'modify' as const,
          estimated_loc: 25,
          complexity: 'simple' as const,
          reason: 'read-only export',
        }],
        files_to_create: [{
          path: 'src/mcp/handoff/sharedCore.ts',
          change_type: 'create' as const,
          estimated_loc: 160,
          complexity: 'moderate' as const,
          reason: 'shared composer',
        }],
        files_to_delete: [],
        depends_on: [],
        blocks: [2],
        can_parallel_with: [],
        priority: 'high' as const,
        estimated_effort: '1h',
        acceptance_criteria: ['Adapters normalize failures'],
      },
      {
        step_number: 2,
        id: 'step-2',
        title: 'Compose fixed payload',
        description: 'Assemble the active handoff payload from durable records.',
        files_to_modify: [{
          path: 'src/mcp/handoff/sharedCore.ts',
          change_type: 'modify' as const,
          estimated_loc: 80,
          complexity: 'moderate' as const,
          reason: 'payload assembly',
        }],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [1],
        blocks: [],
        can_parallel_with: [],
        priority: 'high' as const,
        estimated_effort: '1h',
        acceptance_criteria: ['Payload includes all fixed fields'],
      },
    ],
    dependency_graph: {
      nodes: [
        { id: 'step-1', step_number: 1 },
        { id: 'step-2', step_number: 2 },
      ],
      edges: [{ from: 'step-1', to: 'step-2', type: 'blocks' as const }],
      critical_path: [1, 2],
      parallel_groups: [[1], [2]],
      execution_order: [1, 2],
    },
    testing_strategy: {
      unit: 'Add focused adapter and composer tests.',
      integration: 'Wire shared core in later tasks.',
      coverage_target: '80%',
    },
    acceptance_criteria: [],
    confidence_score: 0.83,
    questions_for_clarification: [],
    context_files: ['src/mcp/tools/planManagement.ts', 'src/mcp/serviceClient.ts'],
    codebase_insights: ['Plan persistence and memory parsing already exist.'],
  };
}
