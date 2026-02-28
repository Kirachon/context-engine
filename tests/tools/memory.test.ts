import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleAddMemory } from '../../src/mcp/tools/memory.js';

function createMockServiceClient(workspacePath: string) {
  return {
    getWorkspacePath: () => workspacePath,
    indexFiles: jest.fn(async () => undefined),
  } as any;
}

describe('memory tool validation', () => {
  it('rejects invalid category', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-invalid-category-'));
    const client = createMockServiceClient(tmp);

    await expect(
      handleAddMemory(
        { category: 'invalid' as any, content: 'note' },
        client
      )
    ).rejects.toThrow('Invalid category. Must be one of: preferences, decisions, facts');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects empty content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-empty-content-'));
    const client = createMockServiceClient(tmp);

    await expect(
      handleAddMemory(
        { category: 'facts', content: '' },
        client
      )
    ).rejects.toThrow('Content is required and must be a non-empty string');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects content over max length', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-max-length-'));
    const client = createMockServiceClient(tmp);

    await expect(
      handleAddMemory(
        { category: 'facts', content: 'x'.repeat(5001) },
        client
      )
    ).rejects.toThrow('Content too long: maximum 5000 characters per memory');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
