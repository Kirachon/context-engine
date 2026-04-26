import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, jest } from '@jest/globals';

import { buildActivePlanHandoff } from '../../src/mcp/handoff/activePlan.js';
import { getPlanPersistenceService, initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

describe('active plan handoff helper', () => {
  it('caps oversized handoff payloads and emits truncation diagnostics', async () => {
    const tempDir = await createHandoffWorkspace('plan-truncated', {
      contextFileCount: 14,
      approvedMemoryCount: 8,
      reviewFindingCount: 7,
      memoryContentLength: 900,
    });
    const serviceClient = {
      getWorkspacePath: () => tempDir,
    };

    try {
      const handoff = await buildActivePlanHandoff(serviceClient as any, 'plan-truncated');

      expect(handoff.status).toBe('degraded');
      expect(handoff.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'truncated',
          }),
        ])
      );
      expect(handoff.payload?.approved_memories.length).toBeLessThanOrEqual(5);
      expect(handoff.payload?.recent_review_findings.length).toBeLessThanOrEqual(5);
      expect(handoff.payload?.linked_files.length).toBeLessThanOrEqual(10);
      expect(
        handoff.payload?.approved_memories.every((memory) => memory.content.length <= 320)
      ).toBe(true);
      expect(JSON.stringify(handoff.payload).length).toBeLessThanOrEqual(12_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps payload under budget when fixed plan fields are oversized', async () => {
    const tempDir = await createHandoffWorkspace('plan-fixed-field-truncated', {
      contextFileCount: 2,
      fixedFieldLength: 15_000,
    });
    const serviceClient = {
      getWorkspacePath: () => tempDir,
    };

    try {
      const handoff = await buildActivePlanHandoff(serviceClient as any, 'plan-fixed-field-truncated');

      expect(handoff.status).toBe('degraded');
      expect(JSON.stringify(handoff.payload).length).toBeLessThanOrEqual(12_000);
      expect(handoff.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'truncated',
          }),
        ])
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('degrades instead of crashing when approved memories cannot be read', async () => {
    const tempDir = await createHandoffWorkspace('plan-memory-read-error');
    const memoryFile = path.join(tempDir, '.memories', 'decisions.md');
    fs.rmSync(memoryFile, { force: true });
    fs.mkdirSync(memoryFile, { recursive: true });
    const serviceClient = {
      getWorkspacePath: () => tempDir,
    };

    try {
      const handoff = await buildActivePlanHandoff(serviceClient as any, 'plan-memory-read-error');

      expect(handoff.status).toBe('degraded');
      expect(handoff.payload?.approved_memories).toEqual([]);
      expect(handoff.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'findings_unavailable',
          }),
        ])
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters unrelated approved memories out of active plan handoffs', async () => {
    const tempDir = await createHandoffWorkspace('plan-related-only');
    fs.appendFileSync(
      path.join(tempDir, '.memories', 'decisions.md'),
      [
        '### [2026-04-30] Unrelated memory',
        '- This unrelated context should not appear.',
        '- [meta] linked_plans: other-plan',
        '- [meta] created_at: 2026-04-30T00:00:00.000Z',
        '- [meta] updated_at: 2026-04-30T00:00:00.000Z',
        '',
      ].join('\n'),
      'utf-8'
    );
    const serviceClient = {
      getWorkspacePath: () => tempDir,
    };

    try {
      const handoff = await buildActivePlanHandoff(serviceClient as any, 'plan-related-only');

      expect(handoff.payload?.approved_memories.some((memory) => memory.title === 'Unrelated memory')).toBe(false);
      expect(handoff.payload?.approved_memories.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps payload under budget when memory metadata is oversized', async () => {
    const tempDir = await createHandoffWorkspace('plan-huge-memory-metadata', {
      hugeMemoryMetadataLength: 15_000,
    });
    const serviceClient = {
      getWorkspacePath: () => tempDir,
    };

    try {
      const handoff = await buildActivePlanHandoff(serviceClient as any, 'plan-huge-memory-metadata');

      expect(handoff.status).toBe('degraded');
      expect(JSON.stringify(handoff.payload).length).toBeLessThanOrEqual(12_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

async function createHandoffWorkspace(
  planId: string,
  options: {
    contextFileCount?: number;
    approvedMemoryCount?: number;
    reviewFindingCount?: number;
    memoryContentLength?: number;
    fixedFieldLength?: number;
    hugeMemoryMetadataLength?: number;
  } = {}
): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-active-handoff-'));
  initializePlanManagementServices(tempDir);
  const saveResult = await getPlanPersistenceService().savePlan(
    createPersistedPlan(planId, options.contextFileCount ?? 2, options.fixedFieldLength),
    { overwrite: true }
  );
  if (!saveResult.success) {
    throw new Error(saveResult.error ?? `Failed to save plan ${planId}`);
  }

  const approvedMemoryCount = options.approvedMemoryCount ?? 2;
  const reviewFindingCount = options.reviewFindingCount ?? 1;
  const memoryContent = 'x'.repeat(options.memoryContentLength ?? 80);
  const hugeMemoryMetadata = options.hugeMemoryMetadataLength
    ? 'm'.repeat(options.hugeMemoryMetadataLength)
    : undefined;

  fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
  const lines = [
    '# Decisions',
    '',
    'This file stores architecture decisions.',
    '',
  ];

  for (let index = 0; index < approvedMemoryCount; index += 1) {
    lines.push(`### [2026-04-1${index}] Approved memory ${index + 1}`);
    lines.push(`- ${memoryContent}`);
    lines.push(`- [meta] linked_plans: ${planId}`);
    lines.push(`- [meta] created_at: 2026-04-1${index}T00:00:00.000Z`);
    lines.push(`- [meta] updated_at: 2026-04-1${index}T00:00:00.000Z`);
    if (hugeMemoryMetadata && index === 0) {
      lines.push(`- [meta] evidence: ${hugeMemoryMetadata}`);
      lines.push(`- [meta] source: ${hugeMemoryMetadata}`);
      lines.push(`- [meta] tags: ${hugeMemoryMetadata}`);
    }
    lines.push('');
  }

  for (let index = 0; index < reviewFindingCount; index += 1) {
    lines.push(`### [2026-04-2${index}] Review finding ${index + 1}`);
    lines.push(`- ${memoryContent}`);
    lines.push('- [meta] subtype: review_finding');
    lines.push(`- [meta] linked_plans: ${planId}`);
    lines.push(`- [meta] linked_files: src/generated/file${index}.ts`);
    lines.push(`- [meta] created_at: 2026-04-2${index}T00:00:00.000Z`);
    lines.push(`- [meta] updated_at: 2026-04-2${index}T00:00:00.000Z`);
    lines.push('');
  }

  fs.writeFileSync(path.join(tempDir, '.memories', 'decisions.md'), lines.join('\n'), 'utf-8');
  return tempDir;
}

function createPersistedPlan(id: string, contextFileCount: number, fixedFieldLength?: number) {
  const oversizedText = fixedFieldLength ? 'x'.repeat(fixedFieldLength) : undefined;
  return {
    id,
    version: 3,
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T12:00:00.000Z',
    goal: oversizedText ?? 'Deliver the shared handoff core slice',
    scope: {
      included: ['shared handoff composer', 'durable adapters'],
      excluded: ['HTTP route edits'],
      assumptions: ['plan services are initialized'],
      constraints: [oversizedText ?? 'keep retrieval routing unchanged', 'exclude draft suggestions'],
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
    context_files: Array.from({ length: contextFileCount }, (_, index) => `src/generated/file${index}.ts`),
    codebase_insights: ['Plan persistence and memory parsing already exist.'],
  };
}
