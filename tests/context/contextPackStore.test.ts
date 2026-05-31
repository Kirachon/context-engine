import { afterEach, describe, expect, it } from '@jest/globals';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assembleContextPackWithTimestamp,
} from '../../src/context/contextPackAssembler.js';
import {
  buildContextPackFilePath,
  ContextPackStore,
  getContextPackStorePath,
  initializeContextPackStore,
  InvalidContextPackIdError,
  resetContextPackStoreForTests,
} from '../../src/context/contextPackStore.js';
import {
  CONTEXT_PACK_RESOURCE_URI_PREFIX,
  readPolicyEnforcedContextPackResource,
} from '../../src/mcp/resources/policyEnforcedReads.js';
import {
  buildResourceList,
  readResourceByUri,
} from '../../src/mcp/resources/resourceRouter.js';
import { initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';
import type { ContextBundle } from '../../src/mcp/serviceClient.js';

function buildFixtureBundle(): ContextBundle {
  return {
    summary: 'Authentication context.',
    query: 'login flow',
    files: [
      {
        path: 'src/auth/login.ts',
        extension: '.ts',
        summary: 'Login handler.',
        relevance: 0.9,
        tokenCount: 40,
        snippets: [
          {
            text: 'export async function login() { return true; }',
            lines: '1-1',
            relevance: 0.9,
            tokenCount: 10,
            codeType: 'function',
          },
        ],
      },
    ],
    hints: [],
    memories: [],
    externalReferences: [],
    metadata: {
      totalFiles: 1,
      totalSnippets: 1,
      totalTokens: 40,
      tokenBudget: 8000,
      truncated: false,
      searchTimeMs: 12,
    },
  };
}

function buildFixturePack(packIdSuffix = '0000000000000001') {
  const { pack } = assembleContextPackWithTimestamp(buildFixtureBundle(), '2026-05-31T00:00:00.000Z');
  return {
    ...pack,
    id: `ctxp_${packIdSuffix}`,
  };
}

function readResourceText(result: ReadResourceResult): string {
  const content = result.contents[0];
  if (!content || !('text' in content)) {
    return '';
  }
  return content.text ?? '';
}

describe('contextPackStore', () => {
  const tempDirs: string[] = [];
  let workspacePath = '';

  afterEach(() => {
    resetContextPackStoreForTests();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): ContextPackStore {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pack-store-'));
    tempDirs.push(workspacePath);
    return new ContextPackStore(workspacePath, 60_000, 2);
  }

  it('persists, lists, reads, and deletes saved context packs', async () => {
    const store = createWorkspace();
    const pack = buildFixturePack();

    await store.save(pack);
    expect(await store.get(pack.id)).toEqual(pack);

    const listed = await store.list();
    expect(listed).toEqual([
      expect.objectContaining({
        id: pack.id,
        query: pack.query,
        item_count: pack.metadata.item_count,
      }),
    ]);

    expect(await store.delete(pack.id)).toBe(true);
    expect(await store.get(pack.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('rejects unsafe pack ids and keeps files inside the store directory', () => {
    const store = createWorkspace();
    const storeDir = getContextPackStorePath(workspacePath);

    expect(() => buildContextPackFilePath(storeDir, '../escape')).toThrow(InvalidContextPackIdError);
    expect(() => buildContextPackFilePath(storeDir, 'ctxp_nothexcharacters!!')).toThrow(InvalidContextPackIdError);

    const safePath = buildContextPackFilePath(storeDir, 'ctxp_0123456789abcdef');
    expect(safePath.startsWith(path.resolve(storeDir))).toBe(true);
  });

  it('removes expired packs during cleanup', async () => {
    const store = createWorkspace();
    const now = new Date('2026-05-31T12:00:00.000Z');
    const stale = buildFixturePack('4444444444444444');

    await store.save(stale, new Date(now.getTime() - 120_000));

    const cleanup = store.cleanupStale(now);

    expect(cleanup.removedPackIds).toContain(stale.id);
    expect(await store.get(stale.id)).toBeNull();
  });

  it('removes overflow packs beyond the configured retention limit', async () => {
    const store = createWorkspace();
    const now = new Date('2026-05-31T12:00:00.000Z');
    const oldest = buildFixturePack('1111111111111111');
    const middle = buildFixturePack('2222222222222222');
    const newest = buildFixturePack('3333333333333333');

    await store.save(oldest, new Date(now.getTime() - 30_000));
    await store.save(middle, new Date(now.getTime() - 20_000));
    await store.save(newest, new Date(now.getTime() - 10_000));

    expect(await store.list()).toHaveLength(2);
    expect(await store.get(oldest.id)).toBeNull();
    expect(await store.get(middle.id)).toEqual(middle);
    expect(await store.get(newest.id)).toEqual(newest);
  });

  it('serves saved context packs through the resource router with policy checks', async () => {
    const store = createWorkspace();
    initializePlanManagementServices(workspacePath);
    initializeContextPackStore(workspacePath);

    const safePack = buildFixturePack('aaaaaaaaaaaaaaaa');
    await store.save(safePack);

    const uri = `${CONTEXT_PACK_RESOURCE_URI_PREFIX}${encodeURIComponent(safePack.id)}`;
    const resources = await buildResourceList();
    expect(resources.some((resource) => resource.uri === uri)).toBe(true);

    const result = await readResourceByUri(uri, { workspaceRoot: workspacePath });
    const text = readResourceText(result);
    expect(text).toContain(`"id": "${safePack.id}"`);
    expect(text).toContain('src/auth/login.ts');
  });

  it('blocks saved context pack reads when a pack item path violates policy', async () => {
    const store = createWorkspace();
    const pack = buildFixturePack('bbbbbbbbbbbbbbbb');
    pack.items.push({
      id: 'ctxi_secret_env',
      kind: 'snippet',
      rank: pack.items.length,
      path: '.env',
      content: 'API_KEY=super-secret-value-that-should-never-leak',
      token_count: 12,
    });

    await store.save(pack);

    const uri = `${CONTEXT_PACK_RESOURCE_URI_PREFIX}${encodeURIComponent(pack.id)}`;
    let error: unknown;
    try {
      await readPolicyEnforcedContextPackResource(
        uri,
        { workspaceRoot: workspacePath, mode: 'strict' },
        (packId) => store.get(packId)
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(McpError);
    const mcpError = error as McpError;
    expect(mcpError.code).toBe(ErrorCode.InvalidRequest);
    expect(mcpError.message).toContain('blocked by context policy');
  });

  it('redacts secret-like pack item content in balanced mode', async () => {
    const store = createWorkspace();
    const pack = buildFixturePack('cccccccccccccccc');
    pack.items.push({
      id: 'ctxi_secret_env',
      kind: 'snippet',
      rank: pack.items.length,
      path: '.env',
      content: 'API_KEY=super-secret-value-that-should-never-leak',
      token_count: 12,
    });

    await store.save(pack);

    const uri = `${CONTEXT_PACK_RESOURCE_URI_PREFIX}${encodeURIComponent(pack.id)}`;
    const result = await readPolicyEnforcedContextPackResource(
      uri,
      { workspaceRoot: workspacePath, mode: 'balanced' },
      (packId) => store.get(packId)
    );

    const text = readResourceText(result);
    expect(text).toContain('[REDACTED BY CONTEXT POLICY]');
    expect(text).not.toContain('super-secret-value-that-should-never-leak');
  });
});
