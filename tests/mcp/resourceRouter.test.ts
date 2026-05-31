import { afterEach, describe, expect, it } from '@jest/globals';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import {
  PLAN_HISTORY_RESOURCE_URI_PREFIX,
  PLAN_RESOURCE_URI_PREFIX,
  TOOL_MANIFEST_RESOURCE_URI,
  buildResourceList,
  readResourceByUri,
} from '../../src/mcp/resources/resourceRouter.js';
import type { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';
import {
  getPlanHistoryService,
  getPlanPersistenceService,
  initializePlanManagementServices,
} from '../../src/mcp/tools/planManagement.js';

type MockServiceClient = {
  getWorkspacePath: () => string;
  clearCache: () => void;
};

const UNKNOWN_RESOURCE_URI = 'context-engine://missing/resource';

function createTestPlan(planId: string): EnhancedPlanOutput {
  return {
    id: planId,
    version: 1,
    created_at: '2026-05-31T00:00:00.000Z',
    updated_at: '2026-05-31T00:00:00.000Z',
    goal: 'Resource router parity plan',
    scope: { included: ['resource router'], excluded: [], assumptions: [], constraints: [] },
    mvp_features: [],
    nice_to_have_features: [],
    architecture: { notes: 'test', patterns_used: [], diagrams: [] },
    risks: [],
    milestones: [],
    steps: [
      {
        step_number: 1,
        id: 'step_1',
        title: 'Step 1',
        description: 'First step',
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [],
        blocks: [],
        can_parallel_with: [],
        priority: 'high',
        estimated_effort: '1h',
        acceptance_criteria: [],
      },
    ],
    dependency_graph: {
      nodes: [],
      edges: [],
      critical_path: [],
      parallel_groups: [],
      execution_order: [],
    },
    testing_strategy: { unit: '', integration: '', coverage_target: '80%' },
    acceptance_criteria: [],
    confidence_score: 0.8,
    questions_for_clarification: [],
    context_files: [],
    codebase_insights: [],
  };
}

function createMockServiceClient(workspacePath: string): MockServiceClient {
  return {
    getWorkspacePath: () => workspacePath,
    clearCache: () => undefined,
  };
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

async function initializeMcpSession(app: Express): Promise<string> {
  const initializeResponse = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 900,
      method: 'initialize',
      params: {
        protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'resource-router-test-client',
          version: '1.0.0',
        },
      },
    });

  expect(initializeResponse.status).toBe(200);
  const sessionId = initializeResponse.headers['mcp-session-id'];
  expect(typeof sessionId).toBe('string');

  const initializedResponse = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId as string)
    .send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

  expect([200, 202, 204]).toContain(initializedResponse.status);
  return sessionId as string;
}

async function listHttpResources(app: Express, sessionId: string) {
  const response = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      id: 11,
      method: 'resources/list',
      params: {},
    });

  expect(response.status).toBe(200);
  const payload = parseSseJsonPayload(response.text);
  return (payload.result as { resources?: Array<Record<string, unknown>> } | undefined)?.resources ?? [];
}

async function readHttpResource(app: Express, sessionId: string, uri: string, requestId = 12) {
  const response = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'resources/read',
      params: { uri },
    });

  return {
    status: response.status,
    payload: parseSseJsonPayload(response.text),
  };
}

function normalizeResourceList(resources: Array<Record<string, unknown>>) {
  return resources
    .map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
    }))
    .sort((left, right) => String(left.uri).localeCompare(String(right.uri)));
}

function normalizeResourceReadResult(result: unknown) {
  const contents = (result as { contents?: Array<{ uri?: string; mimeType?: string; text?: string }> } | undefined)
    ?.contents;
  return {
    uri: contents?.[0]?.uri,
    mimeType: contents?.[0]?.mimeType,
    text: contents?.[0]?.text,
  };
}

function expectResourceNotFoundError(error: unknown, uri: string) {
  expect(error).toBeInstanceOf(McpError);
  const mcpError = error as McpError;
  expect(mcpError.code).toBe(ErrorCode.InvalidParams);
  expect(mcpError.message).toContain(`Resource not found: ${uri}`);
}

describe('resourceRouter', () => {
  const tempDirs: string[] = [];
  let workspacePath = '';
  let planId = '';
  let planResourceUri = '';
  let planHistoryResourceUri = '';

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function seedWorkspace() {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-resource-router-'));
    tempDirs.push(workspacePath);
    planId = 'plan_resource_router_test';
    planResourceUri = `${PLAN_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;
    planHistoryResourceUri = `${PLAN_HISTORY_RESOURCE_URI_PREFIX}${encodeURIComponent(planId)}`;

    initializePlanManagementServices(workspacePath);
    const plan = createTestPlan(planId);
    const saveResult = await getPlanPersistenceService().savePlan(plan, { overwrite: true });
    if (!saveResult.success) {
      throw new Error(saveResult.error ?? `Failed to save plan ${planId}`);
    }
    getPlanHistoryService().recordVersion(plan, 'created', 'Plan saved');
  }

  function createHttpApp() {
    const server = new ContextEngineHttpServer(createMockServiceClient(workspacePath) as never, {
      port: 0,
      version: '9.9.9',
    });

    return server.getApp() as Express;
  }

  it('returns matching resources/list payloads on stdio-like and HTTP /mcp paths', async () => {
    await seedWorkspace();

    const stdioResources = normalizeResourceList(await buildResourceList() as Array<Record<string, unknown>>);
    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);
    const httpResources = normalizeResourceList(await listHttpResources(app, sessionId));

    expect(stdioResources).toEqual(httpResources);
    expect(stdioResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: TOOL_MANIFEST_RESOURCE_URI,
          name: 'tool-manifest',
          mimeType: 'application/json',
        }),
        expect.objectContaining({
          uri: planResourceUri,
          name: `plan:${planId}`,
          mimeType: 'application/json',
        }),
        expect.objectContaining({
          uri: planHistoryResourceUri,
          name: `plan-history:${planId}`,
          mimeType: 'application/json',
        }),
      ])
    );
  });

  it('returns matching resources/read payloads for known URIs on stdio-like and HTTP /mcp paths', async () => {
    await seedWorkspace();
    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);

    for (const [index, uri] of [TOOL_MANIFEST_RESOURCE_URI, planResourceUri, planHistoryResourceUri].entries()) {
      const stdioResult = normalizeResourceReadResult(await readResourceByUri(uri));
      const httpResponse = await readHttpResource(app, sessionId, uri, 20 + index);

      expect(httpResponse.status).toBe(200);
      const httpResult = normalizeResourceReadResult(httpResponse.payload.result);
      expect(httpResult).toEqual(stdioResult);
      expect(httpResult.mimeType).toBe('application/json');
      expect(httpResult.text).toBeTruthy();
    }

    const manifestText = normalizeResourceReadResult(await readResourceByUri(TOOL_MANIFEST_RESOURCE_URI)).text;
    expect(manifestText).toContain('"resources"');
    expect(manifestText).toContain('"prompts"');

    const planText = normalizeResourceReadResult(await readResourceByUri(planResourceUri)).text;
    expect(planText).toContain(`"id": "${planId}"`);

    const historyText = normalizeResourceReadResult(await readResourceByUri(planHistoryResourceUri)).text;
    expect(historyText).toContain(`"plan_id": "${planId}"`);
  });

  it('returns matching not-found errors on stdio-like and HTTP /mcp paths', async () => {
    await seedWorkspace();
    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);

    let stdioError: unknown;
    try {
      await readResourceByUri(UNKNOWN_RESOURCE_URI);
    } catch (error) {
      stdioError = error;
    }
    expectResourceNotFoundError(stdioError, UNKNOWN_RESOURCE_URI);

    const httpResponse = await readHttpResource(app, sessionId, UNKNOWN_RESOURCE_URI, 30);
    expect(httpResponse.status).toBe(200);
    expect(httpResponse.payload.error).toEqual(
      expect.objectContaining({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining(`Resource not found: ${UNKNOWN_RESOURCE_URI}`),
      })
    );
  });
});
