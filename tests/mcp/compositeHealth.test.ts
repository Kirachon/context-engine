/**
 * R6 — Composite health composition table + wiring tests.
 */

import { describe, expect, it } from '@jest/globals';
import request from 'supertest';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import {
  assessCorpusComponent,
  assessGraphComponent,
  assessLexicalComponent,
  assessSessionComponent,
  assessVectorComponent,
  buildCompositeHealth,
  composeOverallStatus,
  unknownCompositeHealth,
  type CompositeHealthInputs,
  type HealthComponentReport,
  type HealthComponents,
} from '../../src/mcp/tooling/compositeHealth.js';

function allReadyComponents(overrides: Partial<HealthComponents> = {}): HealthComponents {
  const ready = (critical = true): HealthComponentReport => ({ state: 'ready', critical });
  return {
    corpus: ready(true),
    lexical: ready(false),
    vector: ready(true),
    graph: ready(true),
    cancellation_queue: ready(true),
    session: ready(false),
    ...overrides,
  };
}

function healthyInputs(overrides: Partial<CompositeHealthInputs> = {}): CompositeHealthInputs {
  return {
    corpus: { status: 'idle', isStale: false, lastIndexed: '2026-07-14T00:00:00.000Z' },
    lexical: { featureEnabled: false, engineLoaded: null, loadAttempted: false },
    vector: { runtimeState: 'healthy', hashFallbackActive: false, loadFailures: 0 },
    graph: { status: 'ready' },
    cancellationQueue: {
      interactiveDepth: 0,
      interactiveMax: 8,
      backgroundDepth: 0,
      backgroundMax: 8,
    },
    session: { activeCount: 1, maxSessions: 100 },
    ...overrides,
  };
}

describe('R6 composite health composition table', () => {
  it.each([
    ['ready', allReadyComponents(), 'healthy'],
    [
      'unknown',
      allReadyComponents({ vector: { state: 'unknown', critical: true, detail: 'not_probed' } }),
      'unknown',
    ],
    [
      'unavailable',
      allReadyComponents({ graph: { state: 'unavailable', critical: true } }),
      'unknown',
    ],
    [
      'stale',
      allReadyComponents({ corpus: { state: 'stale', critical: true, detail: 'content_changed' } }),
      'stale',
    ],
    [
      'degraded',
      allReadyComponents({ vector: { state: 'degraded', critical: true, detail: 'hash_fallback_active' } }),
      'degraded',
    ],
    [
      'error',
      allReadyComponents({ corpus: { state: 'error', critical: true } }),
      'unhealthy',
    ],
  ] as const)(
    'state=%s maps overall correctly and never collapses unknown/unavailable critical to healthy',
    (_label, components, expectedOverall) => {
      expect(composeOverallStatus(components)).toBe(expectedOverall);
      if (_label === 'unknown' || _label === 'unavailable') {
        expect(composeOverallStatus(components)).not.toBe('healthy');
      }
    }
  );

  it('unknown/unavailable critical subsystem cannot collapse to unqualified healthy', () => {
    const withUnknown = buildCompositeHealth(
      healthyInputs({ vector: { runtimeState: 'uninitialized' } })
    );
    expect(withUnknown.components.vector.state).toBe('unknown');
    expect(withUnknown.overall).toBe('unknown');
    expect(withUnknown.overall).not.toBe('healthy');

    const withUnavailable = buildCompositeHealth(
      healthyInputs({ graph: { status: 'unavailable', loadAttempted: true } })
    );
    expect(withUnavailable.components.graph.state).toBe('unavailable');
    expect(withUnavailable.overall).toBe('unknown');
  });

  it('assessors cover ready / stale / degraded / error / unavailable / unknown', () => {
    expect(assessCorpusComponent({ status: 'idle', isStale: false, lastIndexed: 't' }).state).toBe(
      'ready'
    );
    expect(assessCorpusComponent({ status: 'idle', isStale: true, lastIndexed: 't' }).state).toBe(
      'stale'
    );
    expect(assessCorpusComponent({ status: 'error', isStale: false, lastIndexed: 't' }).state).toBe(
      'error'
    );
    expect(assessVectorComponent({ runtimeState: 'degraded' }).state).toBe('degraded');
    expect(assessVectorComponent({ runtimeState: null }).state).toBe('unknown');
    expect(assessGraphComponent({ status: 'unavailable' }).state).toBe('unavailable');
    expect(assessLexicalComponent({ featureEnabled: false, engineLoaded: null, loadAttempted: false }).state).toBe(
      'unavailable'
    );
    expect(assessSessionComponent(undefined).state).toBe('unknown');
  });

  it('rollback helper marks new fields unknown without inventing healthy', () => {
    const rollback = unknownCompositeHealth();
    expect(rollback.overall).toBe('unknown');
    for (const report of Object.values(rollback.components)) {
      expect(report.state).toBe('unknown');
    }
  });
});

describe('R6 additive health wiring', () => {
  function createMockServiceClient() {
    return {
      getIndexStatus: jest.fn(() => ({
        workspace: process.cwd(),
        status: 'idle' as const,
        lastIndexed: '2026-04-10T00:00:00.000Z',
        fileCount: 1,
        isStale: false,
        components: {
          corpus: { state: 'ready' as const, critical: true },
          lexical: { state: 'unavailable' as const, critical: false },
          vector: { state: 'unknown' as const, critical: true },
          graph: { state: 'unknown' as const, critical: true },
          cancellation_queue: { state: 'ready' as const, critical: true },
          session: { state: 'ready' as const, critical: true },
        },
        composite: {
          schema_version: 1 as const,
          overall: 'unknown' as const,
          components: {
            corpus: { state: 'ready' as const, critical: true },
            lexical: { state: 'unavailable' as const, critical: false },
            vector: { state: 'unknown' as const, critical: true },
            graph: { state: 'unknown' as const, critical: true },
            cancellation_queue: { state: 'ready' as const, critical: true },
            session: { state: 'ready' as const, critical: true },
          },
        },
      })),
      getCompositeHealth: jest.fn(() => ({
        schema_version: 1 as const,
        overall: 'unknown' as const,
        components: {
          corpus: { state: 'ready' as const, critical: true },
          lexical: { state: 'unavailable' as const, critical: false },
          vector: { state: 'unknown' as const, critical: true },
          graph: { state: 'unknown' as const, critical: true },
          cancellation_queue: { state: 'ready' as const, critical: true },
          session: { state: 'ready' as const, critical: true },
        },
      })),
      indexWorkspace: jest.fn(async () => ({ filesIndexed: 0, chunksCreated: 0 })),
      semanticSearch: jest.fn(async () => []),
      getContextForPrompt: jest.fn(async () => ({ query: '', files: [], metadata: {} })),
      getFile: jest.fn(async () => ''),
      clearCache: jest.fn(),
      getWorkspacePath: jest.fn(() => process.cwd()),
    };
  }

  it('GET /health retains legacy fields and adds composite/components', async () => {
    const server = new ContextEngineHttpServer(createMockServiceClient() as never, {
      port: 0,
      version: '9.9.9',
    });
    const response = await request(server.getApp()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.version).toBe('9.9.9');
    expect(response.body.timestamp).toEqual(expect.any(String));
    expect(response.body.composite.overall).toBe('unknown');
    expect(response.body.components.vector.state).toBe('unknown');
    expect(response.body.composite.overall).not.toBe('healthy');
  });

  it('GET /api/v1/status preserves legacy index fields and exposes composite', async () => {
    const mock = createMockServiceClient();
    const server = new ContextEngineHttpServer(mock as never, { port: 0, version: '9.9.9' });
    const response = await request(server.getApp()).get('/api/v1/status');
    expect(response.status).toBe(200);
    expect(response.body.workspace).toBe(process.cwd());
    expect(response.body.isStale).toBe(false);
    expect(response.body.composite.overall).toBe('unknown');
    expect(response.body.components.corpus.state).toBe('ready');
  });

  it('GET /api/v1/retrieval/status adds composite without dropping legacy shape', async () => {
    const server = new ContextEngineHttpServer(createMockServiceClient() as never, {
      port: 0,
      version: '9.9.9',
    });
    const response = await request(server.getApp()).get('/api/v1/retrieval/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        state: expect.any(String),
        hashFallbackActive: expect.any(Boolean),
        composite: expect.objectContaining({ schema_version: 1, overall: expect.any(String) }),
        components: expect.objectContaining({ vector: expect.any(Object) }),
      })
    );
  });
});
