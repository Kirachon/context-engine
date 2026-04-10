import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';

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
  semanticSearch: ReturnType<typeof jest.fn>;
  getContextForPrompt: ReturnType<typeof jest.fn>;
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
    semanticSearch: jest.fn(async (_query: string, topK: number) => searchResults.slice(0, topK)),
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

describe('HTTP compatibility harness', () => {
  it('registers the current health and /api/v1 route inventory', () => {
    const { app } = createApp();

    expect(collectRegisteredRoutes(app)).toEqual([
      'GET /health',
      'GET /api/v1/status',
      'POST /api/v1/index',
      'POST /api/v1/search',
      'POST /api/v1/codebase-retrieval',
      'POST /api/v1/enhance-prompt',
      'POST /api/v1/plan',
      'POST /api/v1/context',
      'POST /api/v1/file',
      'POST /api/v1/review-changes',
      'POST /api/v1/review-git-diff',
      'POST /api/v1/review-auto',
    ]);
  });

  it('preserves GET /api/v1/status response shape', async () => {
    const { app, serviceClient } = createApp();

    const response = await request(app).get('/api/v1/status');

    expect(response.status).toBe(200);
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
    expect(serviceClient.indexWorkspace).toHaveBeenCalledTimes(2);
  });

  it('preserves 400 validation envelopes for required request bodies', async () => {
    const { app } = createApp();

    const cases = [
      {
        path: '/api/v1/search',
        expected: { error: 'query is required and must be a string', statusCode: 400 },
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

  it('preserves POST /api/v1/codebase-retrieval response shape', async () => {
    const { app } = createApp();

    const response = await request(app).post('/api/v1/codebase-retrieval').send({
      query: 'auth flow',
      top_k: 2,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      results: [
        {
          path: 'src/auth.ts',
          content: 'export function login() {}',
          score: 0.91,
          lines: '1-1',
          reason: 'Semantic match for: "auth flow"',
        },
        {
          path: 'src/session.ts',
          content: 'export function startSession() {}',
          score: 0.73,
          lines: '3-5',
          reason: 'Semantic match for: "auth flow"',
        },
      ],
      metadata: {
        workspace: '/tmp/workspace',
        lastIndexed: '2026-04-10T00:00:00.000Z',
        query: 'auth flow',
        top_k: 2,
        resultCount: 2,
      },
    });
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
});
