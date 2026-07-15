/**
 * Memory-governance tests for non-destructive stale-memory quarantine (remediation G0b).
 *
 * Covers:
 * - The shared `isArchivedMemory` / `filterDefaultMemories` helper contract.
 * - Hard exclusion of `priority: archive` memories from the default
 *   `ContextServiceClient.getRelevantMemories` selection (wired via `getContextForPrompt`).
 * - Hard exclusion of `priority: archive` memories from the default handoff ranking path
 *   (`readPersistedApprovedMemories` / `readRecentReviewFindings` in sharedCore.ts), with
 *   an explicit `includeArchive: true` opt-in.
 * - That the real `.memories/**` quarantine entries added for the Auggie-era cleanup are
 *   excluded by default but remain reachable via explicit archive access.
 */

import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ContextServiceClient } from '../../src/mcp/serviceClient.js';
import { filterDefaultMemories, isArchivedMemory } from '../../src/mcp/memoryQuarantine.js';
import {
  readPersistedApprovedMemories,
  readRecentReviewFindings,
} from '../../src/mcp/handoff/sharedCore.js';
import { handleListMemories } from '../../src/mcp/tools/memory.js';

const REPO_ROOT = process.cwd();

describe('memoryQuarantine helper', () => {
  it('treats only priority: archive as archived', () => {
    expect(isArchivedMemory({ priority: 'archive' })).toBe(true);
    expect(isArchivedMemory({ priority: 'critical' })).toBe(false);
    expect(isArchivedMemory({ priority: 'helpful' })).toBe(false);
    expect(isArchivedMemory({})).toBe(false);
    expect(isArchivedMemory(null)).toBe(false);
    expect(isArchivedMemory(undefined)).toBe(false);
  });

  it('excludes archive memories by default without mutating input', () => {
    const memories = [
      { id: 'a', priority: 'critical' as const },
      { id: 'b', priority: 'archive' as const },
      { id: 'c', priority: 'helpful' as const },
      { id: 'd' },
    ];
    const frozenCopy = JSON.parse(JSON.stringify(memories));

    const result = filterDefaultMemories(memories);

    expect(result.map((memory) => memory.id)).toEqual(['a', 'c', 'd']);
    expect(memories).toEqual(frozenCopy);
  });

  it('returns archive memories when includeArchive is true', () => {
    const memories = [
      { id: 'a', priority: 'critical' as const },
      { id: 'b', priority: 'archive' as const },
    ];

    const result = filterDefaultMemories(memories, { includeArchive: true });

    expect(result.map((memory) => memory.id)).toEqual(['a', 'b']);
  });
});

describe('serviceClient default memory retrieval quarantine', () => {
  it('excludes priority: archive memories from getContextForPrompt by default', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-memory-quarantine-context-'));
    try {
      const isolatedClient = new ContextServiceClient(tempDir);
      fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.memories', 'facts.md'),
        [
          '### [2026-01-01] Current fact',
          '- The retrieval runtime is local-native.',
          '- [meta] priority: critical',
          '',
          '### [2026-01-01] Archived fact',
          '- Old Auggie-era claim that should not leak into default retrieval.',
          '- [meta] priority: archive',
          '- [meta] subtype: quarantine',
        ].join('\n'),
        'utf-8'
      );

      const archivedContent = [
        '### [2026-01-01] Archived fact',
        '- Old Auggie-era claim that should not leak into default retrieval.',
        '- [meta] priority: archive',
        '- [meta] subtype: quarantine',
      ].join('\n');
      const currentContent = [
        '### [2026-01-01] Current fact',
        '- The retrieval runtime is local-native.',
        '- [meta] priority: critical',
      ].join('\n');

      jest.spyOn(isolatedClient as any, 'semanticSearch').mockResolvedValue([
        { path: '.memories/facts.md', content: currentContent, relevanceScore: 0.8 },
        { path: '.memories/facts.md', content: archivedContent, relevanceScore: 0.95 },
      ]);

      const bundle = await isolatedClient.getContextForPrompt('quarantine default retrieval test', {
        maxFiles: 1,
        includeRelated: false,
        includeMemories: true,
        bypassCache: true,
      });

      expect(bundle.memories?.some((memory) => memory.content.includes('Old Auggie-era claim'))).toBe(false);
      expect(bundle.memories?.some((memory) => memory.content.includes('local-native'))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('handoff sharedCore default memory ranking quarantine', () => {
  function writeArchiveFixture(tempDir: string): void {
    fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.memories', 'decisions.md'),
      [
        '# Decisions',
        '',
        'This file stores architecture decisions.',
        '',
        '### [2026-01-01] Current decision',
        '- Retrieval now runs on the local-native engine.',
        '- [meta] priority: critical',
        '- [meta] created_at: 2026-01-01T00:00:00.000Z',
        '- [meta] updated_at: 2026-01-01T00:00:00.000Z',
        '',
        '### [2026-01-02] Archived decision',
        '- Superseded Auggie-era indexing claim.',
        '- [meta] priority: archive',
        '- [meta] subtype: quarantine',
        '- [meta] tags: auggie-era, stale',
        '- [meta] created_at: 2026-01-02T00:00:00.000Z',
        '- [meta] updated_at: 2026-01-02T00:00:00.000Z',
        '',
        '### [2026-01-03] Archived review finding',
        '- Stale review finding that must not leak into default handoff ranking.',
        '- [meta] priority: archive',
        '- [meta] subtype: review_finding',
        '- [meta] created_at: 2026-01-03T00:00:00.000Z',
        '- [meta] updated_at: 2026-01-03T00:00:00.000Z',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  it('hard-excludes archive memories from readPersistedApprovedMemories by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-quarantine-'));
    try {
      writeArchiveFixture(tempDir);

      const defaultResult = readPersistedApprovedMemories(tempDir);
      expect(defaultResult.ok).toBe(true);
      expect(defaultResult.memories.some((memory) => memory.priority === 'archive')).toBe(false);
      expect(defaultResult.memories.some((memory) => memory.title === 'Current decision')).toBe(true);
      expect(defaultResult.memories.some((memory) => memory.title === 'Archived decision')).toBe(false);
      expect(defaultResult.memories.some((memory) => memory.title === 'Archived review finding')).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('includes archive memories when includeArchive: true is explicitly requested', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-quarantine-explicit-'));
    try {
      writeArchiveFixture(tempDir);

      const explicitResult = readPersistedApprovedMemories(tempDir, { includeArchive: true });
      expect(explicitResult.ok).toBe(true);
      expect(explicitResult.memories.some((memory) => memory.title === 'Archived decision')).toBe(true);
      expect(explicitResult.memories.some((memory) => memory.title === 'Archived review finding')).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('hard-excludes archived review findings from readRecentReviewFindings by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-quarantine-findings-'));
    try {
      writeArchiveFixture(tempDir);

      const defaultFindings = readRecentReviewFindings(tempDir);
      expect(defaultFindings.ok).toBe(true);
      expect(defaultFindings.findings).toEqual([]);

      const explicitFindings = readRecentReviewFindings(tempDir, { includeArchive: true });
      expect(explicitFindings.ok).toBe(true);
      expect(explicitFindings.findings.some((memory) => memory.title === 'Archived review finding')).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('repository .memories/** Auggie-era quarantine (real files)', () => {
  it('excludes real Auggie-era quarantined entries from default handoff memory ranking', () => {
    const result = readPersistedApprovedMemories(REPO_ROOT);
    expect(result.ok).toBe(true);

    const defaultContent = result.memories.map((memory) => memory.content).join('\n');
    expect(defaultContent).not.toContain('Auggie SDK');
    expect(defaultContent).not.toContain('.augment-context-state.json');
    expect(result.memories.some((memory) => memory.priority === 'archive')).toBe(false);
  });

  it('still exposes the real Auggie-era entries via explicit archive access', () => {
    const result = readPersistedApprovedMemories(REPO_ROOT, { includeArchive: true });
    expect(result.ok).toBe(true);

    const archived = result.memories.filter((memory) => memory.priority === 'archive');
    expect(archived.length).toBeGreaterThan(0);
    const archivedContent = archived.map((memory) => memory.content).join('\n');
    expect(archivedContent).toContain('Auggie SDK');
    expect(archived.every((memory) => (memory.tags ?? []).includes('auggie-era'))).toBe(true);
  });

  it('keeps list_memories (explicit archive access) showing raw archived content', async () => {
    const mockClient = {
      getWorkspacePath: () => REPO_ROOT,
    } as any;

    const factsListing = await handleListMemories({ category: 'facts' }, mockClient);
    expect(factsListing).toContain('facts.md');

    // list_memories previews raw file bytes directly (not the priority-filtered ranking
    // path), so explicit archive access remains available even though default retrieval
    // hard-excludes these entries.
    const rawFacts = fs.readFileSync(path.join(REPO_ROOT, '.memories', 'facts.md'), 'utf-8');
    expect(rawFacts).toContain('[meta] priority: archive');
    expect(rawFacts).toContain('Auggie SDK');
  });
});
