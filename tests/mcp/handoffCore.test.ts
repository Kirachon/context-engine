import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readPersistedPlanState } from '../../src/mcp/tools/planManagement.js';
import type {
  ApprovalRequest,
  CompletePlanState,
  EnhancedPlanOutput,
  PersistedPlanMetadata,
  PlanExecutionState,
} from '../../src/mcp/types/planning.js';
import {
  composeSharedHandoffPayload,
  type HandoffMemoryRecord,
  readPersistedApprovedMemories,
  readRecentReviewFindings,
} from '../../src/mcp/handoff/sharedCore.js';

const FIXED_HANDOFF_KEYS = [
  'objective',
  'scope_in',
  'scope_out',
  'constraints',
  'current_step',
  'completed_steps',
  'unresolved_risks',
  'linked_files',
  'approved_memories',
  'recent_review_findings',
  'next_actions',
];

function createPlan(id = 'plan-shared-handoff'): EnhancedPlanOutput {
  return {
    id,
    version: 3,
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T12:00:00.000Z',
    goal: 'Deliver the shared handoff core slice',
    scope: {
      included: ['shared handoff composer', 'durable adapters'],
      excluded: ['HTTP route edits'],
      assumptions: ['plan services are initialized'],
      constraints: ['keep retrieval routing unchanged', 'exclude draft suggestions'],
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
        likelihood: 'medium',
        impact: 'handoff consumers break',
      },
      {
        issue: 'Draft memory suggestions leak into durable handoff',
        mitigation: 'Read only persisted .memories entries',
        likelihood: 'low',
        impact: 'incorrect continuation context',
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
          change_type: 'modify',
          estimated_loc: 25,
          complexity: 'simple',
          reason: 'read-only export',
        }],
        files_to_create: [{
          path: 'src/mcp/handoff/sharedCore.ts',
          change_type: 'create',
          estimated_loc: 160,
          complexity: 'moderate',
          reason: 'shared composer',
        }],
        files_to_delete: [],
        depends_on: [],
        blocks: [2],
        can_parallel_with: [],
        priority: 'high',
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
          change_type: 'modify',
          estimated_loc: 80,
          complexity: 'moderate',
          reason: 'payload assembly',
        }],
        files_to_create: [],
        files_to_delete: [],
        depends_on: [1],
        blocks: [],
        can_parallel_with: [],
        priority: 'high',
        estimated_effort: '1h',
        acceptance_criteria: ['Payload includes all fixed fields'],
      },
    ],
    dependency_graph: {
      nodes: [
        { id: 'step-1', step_number: 1 },
        { id: 'step-2', step_number: 2 },
      ],
      edges: [{ from: 'step-1', to: 'step-2', type: 'blocks' }],
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
    context_files: ['src/mcp/tools/planManagement.ts', 'src/mcp/serviceClient.ts'],
    codebase_insights: ['Plan persistence and memory parsing already exist.'],
  };
}

function createMetadata(plan: EnhancedPlanOutput): PersistedPlanMetadata {
  return {
    id: plan.id,
    name: 'Shared Handoff',
    goal: plan.goal,
    status: 'executing',
    version: plan.version,
    file_path: `/.context-engine-plans/${plan.id}.plan.json`,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    step_count: plan.steps.length,
    tags: ['handoff'],
  };
}

function createExecution(plan: EnhancedPlanOutput): PlanExecutionState {
  return {
    plan_id: plan.id,
    plan_version: plan.version,
    status: 'executing',
    started_at: plan.created_at,
    steps: [
      {
        step_number: 1,
        step_id: 'step-1',
        status: 'completed',
        started_at: '2026-04-19T00:10:00.000Z',
        completed_at: '2026-04-19T00:20:00.000Z',
        retry_count: 0,
      },
      {
        step_number: 2,
        step_id: 'step-2',
        status: 'in_progress',
        started_at: '2026-04-19T00:30:00.000Z',
        retry_count: 0,
      },
    ],
    current_steps: [2],
    ready_steps: [],
    blocked_steps: [],
  };
}

describe('shared handoff core', () => {
  it('maps plan adapter failures to deterministic reason codes', async () => {
    const plan = createPlan();

    await expect(
      readPersistedPlanState(plan.id, {
        getPersistenceService: () => {
          throw new Error('Plan management services not initialized');
        },
      } as any)
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'plan_services_uninitialized',
      })
    );

    await expect(
      readPersistedPlanState(plan.id, {
        getPersistenceService: () => ({
          getPlanMetadata: async () => null,
          loadPlan: async () => null,
        }),
        getExecutionService: () => ({ getExecutionState: () => undefined }),
        getApprovalService: () => ({ getPendingApprovalsForPlan: () => [] as ApprovalRequest[] }),
        getHistoryService: () => ({ getHistory: () => null }),
      } as any)
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'plan_not_found',
      })
    );

    await expect(
      readPersistedPlanState(plan.id, {
        getPersistenceService: () => ({
          getPlanMetadata: async () => createMetadata(plan),
          loadPlan: async () => null,
        }),
        getExecutionService: () => ({ getExecutionState: () => undefined }),
        getApprovalService: () => ({ getPendingApprovalsForPlan: () => [] as ApprovalRequest[] }),
        getHistoryService: () => ({ getHistory: () => null }),
      } as any)
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'plan_unavailable',
      })
    );
  });

  it('reads persisted memories, excludes drafts, and prefers linked recent review findings', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-memories-'));

    try {
      fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.context-engine-memory-suggestions', 'session-1'), { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, '.memories', 'decisions.md'),
        [
          '# Decisions',
          '',
          'This file stores architecture decisions.',
          '',
          '### [2026-04-17] Shared handoff contract',
          '- Keep the handoff payload fixed.',
          '- [meta] linked_plans: plan-shared-handoff',
          '- [meta] created_at: 2026-04-17T00:00:00.000Z',
          '- [meta] updated_at: 2026-04-17T00:00:00.000Z',
          '',
          '### [2026-04-18] Linked review finding',
          '- Retrieval routing must not change.',
          '- [meta] subtype: review_finding',
          '- [meta] linked_plans: plan-shared-handoff',
          '- [meta] linked_files: src/mcp/serviceClient.ts',
          '- [meta] updated_at: 2026-04-18T12:00:00.000Z',
          '- [meta] created_at: 2026-04-18T12:00:00.000Z',
          '',
          '### [2026-04-19] Unlinked review finding',
          '- Review findings should degrade gracefully.',
          '- [meta] subtype: review_finding',
          '- [meta] updated_at: 2026-04-19T12:00:00.000Z',
          '- [meta] created_at: 2026-04-19T12:00:00.000Z',
          '',
        ].join('\n'),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(tempDir, '.context-engine-memory-suggestions', 'session-1', 'draft-1.json'),
        JSON.stringify({
          draft_id: 'draft-1',
          session_id: 'session-1',
          category: 'decisions',
          content: 'Draft memory suggestions must stay out of durable handoff.',
          state: 'drafted',
        }),
        'utf-8'
      );

      const approved = readPersistedApprovedMemories(tempDir);
      expect(approved.ok).toBe(true);
      expect(approved.memories).toHaveLength(3);
      expect(approved.memories.some((memory: any) => memory.content.includes('Draft memory suggestions'))).toBe(false);

      const findings = readRecentReviewFindings(tempDir, {
        planId: 'plan-shared-handoff',
        linkedFiles: ['src/mcp/serviceClient.ts'],
        limit: 2,
      });

      expect(findings.ok).toBe(true);
      expect(findings.findings[0]?.title).toBe('Linked review finding');
      expect(findings.findings).toHaveLength(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not fall back to unrelated review findings when filters are provided', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-unrelated-findings-'));

    try {
      fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.memories', 'decisions.md'),
        [
          '# Decisions',
          '',
          '### [2026-04-19] Unrelated review finding',
          '- This finding belongs somewhere else.',
          '- [meta] subtype: review_finding',
          '- [meta] linked_plans: other-plan',
          '- [meta] linked_files: src/other.ts',
          '- [meta] updated_at: 2026-04-19T12:00:00.000Z',
          '- [meta] created_at: 2026-04-19T12:00:00.000Z',
          '',
        ].join('\n'),
        'utf-8'
      );

      const findings = readRecentReviewFindings(tempDir, {
        planId: 'plan-shared-handoff',
        linkedFiles: ['src/mcp/serviceClient.ts'],
      });

      expect(findings.ok).toBe(true);
      expect(findings.findings).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns findings_unavailable instead of throwing raw file errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-findings-error-'));

    try {
      fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.memories', 'decisions.md'));

      const result = readRecentReviewFindings(tempDir, { planId: 'plan-shared-handoff' });
      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          reason: 'findings_unavailable',
          findings: [],
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('composes the fixed handoff payload from durable plan and memory records', () => {
    const plan = createPlan();
    const completePlanState: CompletePlanState = {
      plan,
      execution: createExecution(plan),
      pending_approvals: [],
      version_count: 2,
      metadata: createMetadata(plan),
    };

    const approvedMemories: HandoffMemoryRecord[] = [
      {
        category: 'decisions',
        title: 'Shared handoff contract',
        content: 'Keep the handoff payload fixed.',
        linked_plans: ['plan-shared-handoff'],
        rank_score: 0.91,
        relative_path: '.memories/decisions.md',
        entry_index: 0,
      },
    ];

    const recentReviewFindings: HandoffMemoryRecord[] = [
      {
        category: 'decisions',
        title: 'Linked review finding',
        content: 'Retrieval routing must not change.',
        subtype: 'review_finding',
        linked_files: ['src/mcp/serviceClient.ts'],
        linked_plans: ['plan-shared-handoff'],
        rank_score: 0.97,
        relative_path: '.memories/decisions.md',
        entry_index: 1,
      },
    ];

    const payload = composeSharedHandoffPayload({
      planState: completePlanState,
      approvedMemories,
      recentReviewFindings,
    });

    expect(Object.keys(payload)).toEqual(FIXED_HANDOFF_KEYS);
    expect(payload.objective).toBe(plan.goal);
    expect(payload.scope_in).toEqual(plan.scope.included);
    expect(payload.scope_out).toEqual(plan.scope.excluded);
    expect(payload.constraints).toContain('keep retrieval routing unchanged');
    expect(payload.current_step).toEqual(
      expect.objectContaining({
        step_number: 2,
        title: 'Compose fixed payload',
      })
    );
    expect(payload.completed_steps).toEqual([
      expect.objectContaining({
        step_number: 1,
        title: 'Add shared adapters',
      }),
    ]);
    expect(payload.unresolved_risks).toEqual([
      'Shared payload drifts from fixed contract',
      'Draft memory suggestions leak into durable handoff',
    ]);
    expect(payload.linked_files).toEqual(
      expect.arrayContaining([
        'src/mcp/tools/planManagement.ts',
        'src/mcp/handoff/sharedCore.ts',
        'src/mcp/serviceClient.ts',
      ])
    );
    expect(payload.approved_memories).toBe(approvedMemories);
    expect(payload.recent_review_findings).toBe(recentReviewFindings);
    expect(payload.next_actions[0]).toContain('Continue step 2');
  });

  it('does not duplicate a ready step as both current and queued next action', () => {
    const plan = createPlan();
    const execution: PlanExecutionState = {
      plan_id: plan.id,
      plan_version: plan.version,
      status: 'ready',
      started_at: plan.created_at,
      steps: [],
      current_steps: [],
      ready_steps: [1, 2],
      blocked_steps: [],
    };
    const completePlanState: CompletePlanState = {
      plan,
      execution,
      pending_approvals: [],
      version_count: 1,
      metadata: createMetadata(plan),
    };

    const payload = composeSharedHandoffPayload({
      planState: completePlanState,
      approvedMemories: [],
      recentReviewFindings: [],
    });

    expect(payload.current_step?.step_number).toBe(1);
    expect(payload.next_actions).toEqual([
      'Continue step 1: Add shared adapters',
      'Queue step 2: Compose fixed payload',
    ]);
  });
});
