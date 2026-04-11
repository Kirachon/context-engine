import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleAddMemory, handleListMemories } from '../../src/mcp/tools/memory.js';

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

  it('stores optional metadata fields without changing category contract', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-metadata-'));
    const client = createMockServiceClient(tmp);

    try {
      const result = await handleAddMemory(
        {
          category: 'decisions',
          title: 'Memory schema extension',
          content: 'We added metadata to improve retrieval ranking.',
          priority: 'critical',
          subtype: 'plan_note',
          tags: ['memory', 'ranking'],
          linked_files: ['src/mcp/tools/memory.ts'],
          linked_plans: ['context-engine-next-tranche-swarm-plan'],
          source: 'parallel-task execution',
          evidence: 'tests/tools/memory.test.ts',
          owner: 'platform-team',
        },
        client
      );

      expect(result).toContain('Metadata');

      const listed = await handleListMemories({ category: 'decisions' }, client);
      expect(listed).toContain('[meta] priority: critical');
      expect(listed).toContain('[meta] subtype: plan_note');
      expect(listed).toContain('[meta] tags: memory, ranking');
      expect(listed).toContain('[meta] linked_files: src/mcp/tools/memory.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
