import { afterEach, describe, expect, it } from '@jest/globals';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

import { ContextEngineHttpServer } from '../../src/http/httpServer.js';
import {
  buildResourcePolicyErrorData,
  CHUNK_RESOURCE_URI_PREFIX,
  FILE_RESOURCE_URI_PREFIX,
  isResourcePolicyError,
  SYMBOL_RESOURCE_URI_PREFIX,
} from '../../src/mcp/resources/policyEnforcedReads.js';
import {
  readResourceByUri,
  type ResourceReadContext,
} from '../../src/mcp/resources/resourceRouter.js';
import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  evaluateContextResourcePolicy,
  type ContextSafetyMode,
} from '../../src/security/contextPolicy.js';
import { initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

type MockServiceClient = {
  getWorkspacePath: () => string;
  clearCache: () => void;
};

function buildFileResourceUri(relativePath: string): string {
  return `${FILE_RESOURCE_URI_PREFIX}${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function buildChunkResourceUri(chunkId: string): string {
  return `${CHUNK_RESOURCE_URI_PREFIX}${encodeURIComponent(chunkId)}`;
}

function buildSymbolResourceUri(symbolId: string): string {
  return `${SYMBOL_RESOURCE_URI_PREFIX}${encodeURIComponent(symbolId)}`;
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
          name: 'resource-policy-reads-test-client',
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

function normalizeResourceReadResult(result: unknown) {
  const contents = (result as { contents?: Array<{ uri?: string; mimeType?: string; text?: string }> } | undefined)
    ?.contents;
  return {
    uri: contents?.[0]?.uri,
    mimeType: contents?.[0]?.mimeType,
    text: contents?.[0]?.text,
  };
}

function expectPolicyError(error: unknown, uri: string, reason: string, action: 'block' | 'redact' = 'block') {
  expect(isResourcePolicyError(error)).toBe(true);
  const policyError = error as McpError;
  expect(policyError.code).toBe(ErrorCode.InvalidRequest);
  expect(policyError.message).toContain(`Resource access ${action === 'block' ? 'blocked' : 'redacted'} by context policy`);
  expect(policyError.message).toContain(uri);
  expect(policyError.data).toEqual(
    expect.objectContaining({
      uri,
      action,
      policyId: 'context-resource-policy',
      receipts: expect.arrayContaining([
        expect.objectContaining({
          policyId: 'context-resource-policy',
          action,
          reason,
        }),
      ]),
    })
  );
}

function expectHttpPolicyError(payload: Record<string, unknown>, uri: string, reason: string, action: 'block' | 'redact' = 'block') {
  expect(payload.error).toEqual(
    expect.objectContaining({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining(`Resource access ${action === 'block' ? 'blocked' : 'redacted'} by context policy`),
      data: expect.objectContaining({
        uri,
        action,
        policyId: 'context-resource-policy',
        receipts: expect.arrayContaining([
          expect.objectContaining({
            reason,
            action,
          }),
        ]),
      }),
    })
  );
}

describe('resourcePolicyReads', () => {
  const tempDirs: string[] = [];
  let workspacePath = '';
  let readContext: ResourceReadContext;

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-resource-policy-reads-'));
    tempDirs.push(workspace);
    return workspace;
  }

  function writeRelativeFile(workspace: string, relativePath: string, content: string | Buffer): string {
    const fullPath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return relativePath.replace(/\\/g, '/');
  }

  function seedWorkspace() {
    workspacePath = createWorkspace();
    initializePlanManagementServices(workspacePath);
    readContext = {
      workspaceRoot: workspacePath,
      serviceClient: new ContextServiceClient(workspacePath),
    };
  }

  function createHttpApp(contextSafetyMode?: ContextSafetyMode) {
    const server = new ContextEngineHttpServer(readContext.serviceClient as never, {
      port: 0,
      version: '9.9.9',
      contextSafetyMode,
    });
    return server.getApp() as Express;
  }

  async function expectMatchingPolicyDenial(
    uri: string,
    reason: string,
    action: 'block' | 'redact' = 'block',
    context: ResourceReadContext = readContext
  ) {
    let stdioError: unknown;
    try {
      await readResourceByUri(uri, context);
    } catch (error) {
      stdioError = error;
    }
    expectPolicyError(stdioError, uri, reason, action);

    const app = createHttpApp(context.mode);
    const sessionId = await initializeMcpSession(app);
    const httpResponse = await readHttpResource(app, sessionId, uri, 40);
    expect(httpResponse.status).toBe(200);
    expectHttpPolicyError(httpResponse.payload, uri, reason, action);
  }

  it('allows safe workspace file reads with correct MIME type and stdio/HTTP parity', async () => {
    seedWorkspace();
    const relativePath = writeRelativeFile(workspacePath, 'src/safe.ts', 'export const answer = 42;');
    const uri = buildFileResourceUri(relativePath);

    const stdioResult = normalizeResourceReadResult(await readResourceByUri(uri, readContext));
    expect(stdioResult).toEqual({
      uri,
      mimeType: 'text/typescript',
      text: 'export const answer = 42;',
    });

    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);
    const httpResponse = await readHttpResource(app, sessionId, uri, 10);
    expect(httpResponse.status).toBe(200);
    expect(normalizeResourceReadResult(httpResponse.payload.result)).toEqual(stdioResult);
  });

  it('blocks plain path traversal with policy receipts', async () => {
    seedWorkspace();
    const uri = buildFileResourceUri('../outside.txt');
    await expectMatchingPolicyDenial(uri, 'path_traversal', 'block');
  });

  it('blocks encoded traversal attempts with policy receipts', async () => {
    seedWorkspace();
    const uri = buildFileResourceUri('src/%2e%2e/%2fsecret.txt');
    await expectMatchingPolicyDenial(uri, 'encoded_traversal', 'block');
  });

  it('blocks absolute outside-root paths with policy receipts', async () => {
    seedWorkspace();
    const outsidePath = process.platform === 'win32' ? 'C:/outside.txt' : '/etc/passwd';
    const uri = buildFileResourceUri(outsidePath);
    await expectMatchingPolicyDenial(uri, 'outside_root', 'block');
  });

  it('blocks symlink escapes that leave the workspace root', async () => {
    seedWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-resource-policy-outside-'));
    tempDirs.push(outside);
    const outsideFile = path.join(outside, 'secret.txt');
    const linkPath = path.join(workspacePath, 'escape-link.txt');
    fs.writeFileSync(outsideFile, 'outside secret', 'utf-8');

    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      return;
    }

    const uri = buildFileResourceUri('escape-link.txt');
    await expectMatchingPolicyDenial(uri, 'symlink_escape', 'block');
  });

  it('blocks secret-like filenames in strict mode', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, '.env', 'DATABASE_URL=postgres://user:pass@localhost/db');
    const uri = buildFileResourceUri('.env');
    await expectMatchingPolicyDenial(uri, 'secret_like_file', 'block', { ...readContext, mode: 'strict' });
  });

  it('redacts secret-like filenames in balanced mode', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, 'config/.env.local', 'TOKEN=abc');
    const uri = buildFileResourceUri('config/.env.local');
    await expectMatchingPolicyDenial(uri, 'secret_like_file', 'redact');
  });

  it('blocks large files above the safe size limit', async () => {
    seedWorkspace();
    const largeContent = 'x'.repeat(DEFAULT_MAX_FILE_SIZE_BYTES + 1);
    writeRelativeFile(workspacePath, 'large.txt', largeContent);
    const uri = buildFileResourceUri('large.txt');
    await expectMatchingPolicyDenial(uri, 'large_file', 'block');
  });

  it('blocks binary files', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, 'binary.bin', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
    const uri = buildFileResourceUri('binary.bin');
    await expectMatchingPolicyDenial(uri, 'binary_file', 'block');
  });

  it('blocks generated files in strict mode', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, 'dist/app.min.js', 'console.log("bundle");');
    const uri = buildFileResourceUri('dist/app.min.js');
    await expectMatchingPolicyDenial(uri, 'generated_file', 'block', { ...readContext, mode: 'strict' });
  });

  it('redacts generated files in balanced mode', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, 'node_modules/pkg/index.js', 'module.exports = {};');
    const uri = buildFileResourceUri('node_modules/pkg/index.js');
    await expectMatchingPolicyDenial(uri, 'generated_file', 'redact');
  });

  it('redacts files whose content contains secret patterns', async () => {
    seedWorkspace();
    writeRelativeFile(
      workspacePath,
      'src/config.ts',
      'export const token = "sk-proj-' + 'a'.repeat(90) + '";'
    );
    const uri = buildFileResourceUri('src/config.ts');
    await expectMatchingPolicyDenial(uri, 'content_secret', 'redact');
  });

  it('reads chunk resources through the underlying file policy gate', async () => {
    seedWorkspace();
    const relativePath = writeRelativeFile(
      workspacePath,
      'src/chunk.ts',
      ['export const one = 1;', 'export const two = 2;', 'export const three = 3;'].join('\n')
    );
    const chunkId = `${relativePath}#L2-L2`;
    const uri = buildChunkResourceUri(chunkId);

    const stdioResult = normalizeResourceReadResult(await readResourceByUri(uri, readContext));
    expect(stdioResult).toEqual({
      uri,
      mimeType: 'text/typescript',
      text: 'export const two = 2;',
    });

    const app = createHttpApp();
    const sessionId = await initializeMcpSession(app);
    const httpResponse = await readHttpResource(app, sessionId, uri, 11);
    expect(httpResponse.status).toBe(200);
    expect(normalizeResourceReadResult(httpResponse.payload.result)).toEqual(stdioResult);
  });

  it('blocks chunk resources when the underlying file is denied by policy', async () => {
    seedWorkspace();
    writeRelativeFile(workspacePath, '.env', 'TOKEN=abc');
    const chunkId = '.env#L1-L1';
    const uri = buildChunkResourceUri(chunkId);
    await expectMatchingPolicyDenial(uri, 'secret_like_file', 'redact');
  });

  it('returns a symbol stub with policy metadata when service client context is missing', async () => {
    seedWorkspace();
    const uri = buildSymbolResourceUri('missingSymbol');
    const result = normalizeResourceReadResult(
      await readResourceByUri(uri, { workspaceRoot: workspacePath })
    );

    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.text ?? '{}')).toEqual(
      expect.objectContaining({
        symbol: 'missingSymbol',
        found: false,
        stub: true,
        policyId: 'context-resource-policy',
        receipts: [],
      })
    );
  });

  it('uses the same policy evaluation semantics as evaluateContextResourcePolicy', async () => {
    seedWorkspace();
    const relativePath = writeRelativeFile(workspacePath, 'src/routed.ts', 'export const routed = true;');
    const uri = buildFileResourceUri(relativePath);
    const directEvaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspacePath,
      requestedPath: relativePath,
    });

    expect(directEvaluation.allowed).toBe(true);
    const result = normalizeResourceReadResult(await readResourceByUri(uri, readContext));
    expect(result.text).toBe('export const routed = true;');

    writeRelativeFile(workspacePath, 'dist/blocked.js', 'module.exports = {};');
    const blockedUri = buildFileResourceUri('dist/blocked.js');
    const blockedEvaluation = evaluateContextResourcePolicy({
      workspaceRoot: workspacePath,
      requestedPath: 'dist/blocked.js',
      mode: 'strict',
    });
    expect(blockedEvaluation.allowed).toBe(false);

    let stdioError: unknown;
    try {
      await readResourceByUri(blockedUri, { ...readContext, mode: 'strict' });
    } catch (error) {
      stdioError = error;
    }
    expectPolicyError(stdioError, blockedUri, 'generated_file', 'block');
    expect((stdioError as McpError).data).toEqual(
      buildResourcePolicyErrorData(blockedUri, blockedEvaluation)
    );
  });

  it('builds MCP-compatible policy error payloads from evaluations', () => {
    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot: createWorkspace(),
      requestedPath: '../outside.txt',
    });
    const uri = buildFileResourceUri('../outside.txt');
    const payload = buildResourcePolicyErrorData(uri, evaluation);

    expect(payload).toEqual({
      uri,
      action: 'block',
      policyId: 'context-resource-policy',
      receipts: evaluation.receipts,
    });
  });

  it('does not emit secret content in policy error messages', async () => {
    seedWorkspace();
    writeRelativeFile(
      workspacePath,
      'src/config.ts',
      'export const token = "sk-proj-' + 'a'.repeat(90) + '";'
    );
    const uri = buildFileResourceUri('src/config.ts');

    let stdioError: unknown;
    try {
      await readResourceByUri(uri, readContext);
    } catch (error) {
      stdioError = error;
    }

    expect(isResourcePolicyError(stdioError)).toBe(true);
    const serialized = JSON.stringify((stdioError as McpError).data);
    expect(serialized).not.toMatch(/sk-proj-[A-Za-z0-9]{10,}/);
  });
});
