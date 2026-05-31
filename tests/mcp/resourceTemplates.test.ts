import { afterEach, describe, expect, it } from '@jest/globals';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import { buildResourceList } from '../../src/mcp/resources/resourceRouter.js';
import {
  CHUNK_RESOURCE_TEMPLATE_URI,
  CONTEXT_PACK_RESOURCE_TEMPLATE_URI,
  FILE_RESOURCE_TEMPLATE_URI,
  INDEX_SNAPSHOT_RESOURCE_TEMPLATE_URI,
  RESOURCE_TEMPLATE_TRANSPORT,
  REVIEW_RESOURCE_TEMPLATE_URI,
  SYMBOL_RESOURCE_TEMPLATE_URI,
  buildResourceTemplateList,
} from '../../src/mcp/resources/resourceTemplates.js';
import { initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

type MockServiceClient = {
  getWorkspacePath: () => string;
  clearCache: () => void;
};

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
          name: 'resource-templates-test-client',
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

async function listHttpResourceTemplates(app: Express, sessionId: string) {
  const response = await request(app)
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/templates/list',
      params: {},
    });

  expect(response.status).toBe(200);
  const payload = parseSseJsonPayload(response.text);
  return (
    (payload.result as { resourceTemplates?: Array<Record<string, unknown>> } | undefined)
      ?.resourceTemplates ?? []
  );
}

function normalizeResourceTemplateList(templates: Array<Record<string, unknown>>) {
  return templates
    .map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      title: template.title,
      description: template.description,
      mimeType: template.mimeType,
    }))
    .sort((left, right) => String(left.uriTemplate).localeCompare(String(right.uriTemplate)));
}

function normalizeConcreteResourceList(resources: Array<Record<string, unknown>>) {
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

describe('resourceTemplates', () => {
  const tempDirs: string[] = [];
  let workspacePath = '';

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedWorkspace() {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-resource-templates-'));
    tempDirs.push(workspacePath);
    initializePlanManagementServices(workspacePath);
  }

  function createHttpApp() {
    const server = new ContextEngineHttpServer(createMockServiceClient(workspacePath) as never, {
      port: 0,
      version: '9.9.9',
    });

    return server.getApp() as Express;
  }

  it('documents that ListResourcesRequest does not carry resource templates in SDK 1.29.0', () => {
    expect(RESOURCE_TEMPLATE_TRANSPORT).toEqual({
      sdkVersion: '1.29.0',
      listResourcesIncludesTemplates: false,
      templateListMethod: 'resources/templates/list',
      templateListSchema: 'ListResourceTemplatesRequestSchema',
      templateResultField: 'resourceTemplates',
    });
  });

  it('returns matching resources/templates/list payloads on stdio-like and HTTP /mcp paths', async () => {
    seedWorkspace();

    const stdioTemplates = normalizeResourceTemplateList(
      buildResourceTemplateList() as Array<Record<string, unknown>>
    );
    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);
    const httpTemplates = normalizeResourceTemplateList(await listHttpResourceTemplates(app, sessionId));

    expect(stdioTemplates).toEqual(httpTemplates);
    expect(stdioTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate: FILE_RESOURCE_TEMPLATE_URI,
          name: 'workspace-file',
          mimeType: 'text/plain',
          description: expect.stringContaining('workspace-relative file'),
        }),
        expect.objectContaining({
          uriTemplate: CHUNK_RESOURCE_TEMPLATE_URI,
          name: 'indexed-chunk',
          mimeType: 'text/plain',
        }),
        expect.objectContaining({
          uriTemplate: SYMBOL_RESOURCE_TEMPLATE_URI,
          name: 'indexed-symbol',
          mimeType: 'application/json',
        }),
        expect.objectContaining({
          uriTemplate: CONTEXT_PACK_RESOURCE_TEMPLATE_URI,
          name: 'context-pack',
          mimeType: 'application/json',
        }),
        expect.objectContaining({
          uriTemplate: REVIEW_RESOURCE_TEMPLATE_URI,
          name: 'review-session',
          mimeType: 'application/json',
        }),
        expect.objectContaining({
          uriTemplate: INDEX_SNAPSHOT_RESOURCE_TEMPLATE_URI,
          name: 'index-snapshot',
          mimeType: 'application/json',
        }),
      ])
    );
    expect(stdioTemplates).toHaveLength(6);
  });

  it('keeps concrete resources/list coverage separate from template advertisement', async () => {
    seedWorkspace();

    const concreteResources = normalizeConcreteResourceList(
      (await buildResourceList()) as Array<Record<string, unknown>>
    );
    const templates = normalizeResourceTemplateList(
      buildResourceTemplateList() as Array<Record<string, unknown>>
    );

    expect(concreteResources.length).toBeGreaterThan(0);
    expect(templates).toHaveLength(6);

    for (const resource of concreteResources) {
      expect(String(resource.uri)).not.toMatch(/\{[^}]+\}/);
    }

    for (const template of templates) {
      expect(String(template.uriTemplate)).toMatch(/\{[^}]+\}|snapshot$/);
    }

    const concreteUris = new Set(concreteResources.map((resource) => resource.uri));
    for (const template of templates) {
      expect(concreteUris.has(template.uriTemplate)).toBe(false);
    }
  });
});
