/**
 * Unit tests for get_context_for_prompt tool
 *
 * Tests the Layer 3 - MCP Interface functionality for context enhancement
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { handleGetContext, GetContextArgs, getContextTool } from '../../src/mcp/tools/context.js';
import { ContextServiceClient, ContextBundle, FileContext } from '../../src/mcp/serviceClient.js';
import { FEATURE_FLAGS } from '../../src/config/features.js';
import { getPlanPersistenceService, initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

describe('get_context_for_prompt Tool', () => {
  let mockServiceClient: any;
  const originalContextPacksV2 = FEATURE_FLAGS.context_packs_v2;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    FEATURE_FLAGS.context_packs_v2 = originalContextPacksV2;
    mockServiceClient = {
      getFile: jest.fn(),
      semanticSearch: jest.fn(),
      getContextForPrompt: jest.fn(),
      getWorkspacePath: jest.fn(() => process.cwd()),
      indexWorkspace: jest.fn(),
      clearCache: jest.fn(),
      getIndexStatus: jest.fn(() => ({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: false,
      })),
    };
  });

  describe('Input Validation', () => {
    it('should reject empty query', async () => {
      await expect(handleGetContext({ query: '' }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject whitespace-only query', async () => {
      await expect(handleGetContext({ query: '   ' }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject null query', async () => {
      await expect(handleGetContext({ query: null as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid query/i);
    });

    it('should reject query over 1000 characters', async () => {
      const longQuery = 'a'.repeat(1001);
      await expect(handleGetContext({ query: longQuery }, mockServiceClient as any))
        .rejects.toThrow(/query too long/i);
    });

    it('should reject max_files less than 1', async () => {
      await expect(handleGetContext({ query: 'test', max_files: 0 }, mockServiceClient as any))
        .rejects.toThrow(/invalid max_files/i);
    });

    it('should reject max_files greater than 20', async () => {
      await expect(handleGetContext({ query: 'test', max_files: 21 }, mockServiceClient as any))
        .rejects.toThrow(/invalid max_files/i);
    });

    it('should reject invalid token_budget', async () => {
      await expect(handleGetContext({ query: 'test', token_budget: 100 }, mockServiceClient as any))
        .rejects.toThrow(/invalid token_budget/i);
    });

    it('should reject non-boolean include_related', async () => {
      await expect(handleGetContext({ query: 'test', include_related: 'yes' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid include_related/i);
    });

    it('should reject min_relevance below 0', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: -0.01 }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should reject min_relevance above 1', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: 1.01 }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should reject non-numeric min_relevance', async () => {
      await expect(handleGetContext({ query: 'test', min_relevance: '0.3' as any }, mockServiceClient as any))
        .rejects.toThrow(/invalid min_relevance/i);
    });

    it('should reject invalid include_paths', async () => {
      await expect(
        handleGetContext({ query: 'test', include_paths: ['C:/tmp/**'] as any }, mockServiceClient as any)
      ).rejects.toThrow(/invalid include_paths/i);
    });

    it('should reject invalid handoff_mode', async () => {
      await expect(
        handleGetContext({ query: 'test', handoff_mode: 'plan' as any }, mockServiceClient as any)
      ).rejects.toThrow(/invalid handoff_mode/i);
    });

    it('should require plan_id when handoff_mode is active_plan', async () => {
      await expect(
        handleGetContext({ query: 'test', handoff_mode: 'active_plan' }, mockServiceClient as any)
      ).rejects.toThrow(/plan_id is required when handoff_mode is active_plan/i);
    });

    it('should accept active_plan handoff inputs without changing default context retrieval', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      await expect(handleGetContext({
        query: 'test query',
        handoff_mode: 'active_plan',
        plan_id: 'plan_123',
      }, mockServiceClient as any)).resolves.toBeDefined();

      expect(mockServiceClient.getContextForPrompt).toHaveBeenCalledWith(
        'test query',
        expect.not.objectContaining({
          handoff_mode: expect.anything(),
          plan_id: expect.anything(),
        })
      );
    });

    it('should accept valid parameters', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      await expect(handleGetContext({
        query: 'test query',
        max_files: 5,
        token_budget: 8000,
        include_related: true,
        min_relevance: 0.3,
      }, mockServiceClient as any)).resolves.toBeDefined();
    });

    it('should normalize whitespace-only around query', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: '   test query   ' }, mockServiceClient as any);
      expect(result).toContain('**Query:** "test query"');
    });

    it('should pass normalized scoped path filters to getContextForPrompt', async () => {
      const mockBundle: ContextBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      await handleGetContext(
        {
          query: 'test query',
          include_paths: ['./src/', 'src\\**'],
          exclude_paths: ['dist/', './dist/**'],
        },
        mockServiceClient as any
      );

      expect(mockServiceClient.getContextForPrompt).toHaveBeenCalledWith(
        'test query',
        expect.objectContaining({
          includePaths: ['src/**'],
          excludePaths: ['dist/**'],
        })
      );
    });
  });

  describe('Output Formatting', () => {
    it('should include summary header', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('# 📚 Codebase Context');
      expect(result).toContain('**Query:**');
    });

    it('should include freshness warning when index is stale', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);
      mockServiceClient.getIndexStatus.mockReturnValue({
        workspace: '/tmp/workspace',
        lastIndexed: '2024-01-01T00:00:00.000Z',
        status: 'idle',
        fileCount: 10,
        isStale: true,
      });

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('Index freshness warning');
      expect(result).toContain('index is stale');
    });

    it('should include freshness warning when index is unhealthy', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);
      mockServiceClient.getIndexStatus.mockReturnValue({
        workspace: '/tmp/workspace',
        lastIndexed: null,
        status: 'error',
        fileCount: 0,
        isStale: true,
        lastError: 'index unavailable',
      });

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('index status is error');
      expect(result).toContain('reindexing succeeds');
    });

    it('should include file overview table', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## 📁 Files Overview');
      expect(result).toContain('| # | File | Relevance | Summary |');
    });

    it('should include hints section', async () => {
      const mockBundle = createMockContextBundle();
      mockBundle.hints = ['Test hint 1', 'Test hint 2'];
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## 💡 Key Insights');
      expect(result).toContain('Test hint 1');
    });

    it('should include code snippets with syntax highlighting', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('```typescript');
      expect(result).toContain('```');
    });

    it('renders a dedicated external references section when external references are present', async () => {
      const mockBundle = createMockContextBundle();
      mockBundle.externalReferences = [
        {
          type: 'docs_url',
          url: 'https://example.com/docs',
          host: 'example.com',
          excerpt: 'External auth guidance',
          fetched_at: '2026-04-10T00:00:00.000Z',
          status: 'used',
        } as any,
      ];
      mockBundle.metadata.externalSourcesRequested = 1;
      mockBundle.metadata.externalSourcesUsed = 1;
      mockBundle.metadata.externalWarnings = [];
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## 🌐 External References');
      expect(result).toContain('not part of the indexed local codebase');
      expect(result).toContain('https://example.com/docs');
      expect(result).toContain('External auth guidance');
    });

    it('renders active handoff details and disables generic memory retrieval in active_plan mode', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);
      const tempDir = await createHandoffWorkspace('plan-123');
      mockServiceClient.getWorkspacePath.mockReturnValue(tempDir);

      try {
        const result = await handleGetContext({
          query: 'test',
          handoff_mode: 'active_plan',
          plan_id: 'plan-123',
          include_draft_memories: true,
          draft_session_id: 'session-1',
        }, mockServiceClient as any);

        expect(mockServiceClient.getContextForPrompt).toHaveBeenCalledWith(
          'test',
          expect.objectContaining({
            includeMemories: false,
            includeDraftMemories: false,
          })
        );
        expect(result).toContain('## 🔁 Active Handoff');
        expect(result).toContain('Deliver the shared handoff core slice');
        expect(result).toContain('Linked review finding');
        expect(result).toContain('Continue step 1: Add shared adapters');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('renders structured handoff diagnostics when active plan lookup fails', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-missing-plan-'));
      initializePlanManagementServices(tempDir);
      mockServiceClient.getWorkspacePath.mockReturnValue(tempDir);

      try {
        const result = await handleGetContext({
          query: 'test',
          handoff_mode: 'active_plan',
          plan_id: 'plan-missing',
        }, mockServiceClient as any);

        expect(result).toContain('## 🔁 Active Handoff');
        expect(result).toContain('plan_not_found');
        expect(result).toContain('No persisted plan metadata found for plan-missing.');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('builds handoff outside cached retrieval so plan changes do not reuse stale handoff state', async () => {
      const mockBundle = createMockContextBundle();
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);
      const firstWorkspace = await createHandoffWorkspace('plan-cache-a');
      const secondWorkspace = await createHandoffWorkspace('plan-cache-b');

      try {
        mockServiceClient.getWorkspacePath.mockReturnValue(firstWorkspace);
        const first = await handleGetContext({
          query: 'cache handoff proof',
          handoff_mode: 'active_plan',
          plan_id: 'plan-cache-a',
        }, mockServiceClient as any);

        mockServiceClient.getWorkspacePath.mockReturnValue(secondWorkspace);
        const second = await handleGetContext({
          query: 'cache handoff proof',
          handoff_mode: 'active_plan',
          plan_id: 'plan-cache-b',
        }, mockServiceClient as any);

        expect(first).toContain('`plan-cache-a`');
        expect(second).toContain('`plan-cache-b`');
      } finally {
        fs.rmSync(firstWorkspace, { recursive: true, force: true });
        fs.rmSync(secondWorkspace, { recursive: true, force: true });
      }
    });

    it('should render higher-relevance files first in overview and detailed context', async () => {
      FEATURE_FLAGS.context_packs_v2 = true;
      const mockBundle: ContextBundle = {
        summary: 'Ordered context bundle',
        query: 'sort by relevance',
        files: [
          createFileContext('src/low.ts', 0.22, 'Low priority helper', 'low priority draft'),
          createFileContext('src/high.ts', 0.96, 'High priority core', 'high priority path'),
          createFileContext('src/mid.ts', 0.61, 'Mid priority support', 'mid priority support'),
        ],
        hints: ['Files should be ranked by relevance'],
        metadata: {
          totalFiles: 3,
          totalSnippets: 3,
          totalTokens: 300,
          tokenBudget: 8000,
          truncated: false,
          searchTimeMs: 42,
        },
      };
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'sort by relevance' }, mockServiceClient as any);

      expect(result.indexOf('| 1 | `src/high.ts` |')).toBeLessThan(result.indexOf('| 2 | `src/mid.ts` |'));
      expect(result.indexOf('### 1. `src/high.ts`')).toBeLessThan(result.indexOf('### 2. `src/mid.ts`'));
      expect(result).toContain('## ✅ Why These Files');
      expect(result.indexOf('- `src/high.ts`:')).toBeLessThan(result.indexOf('- `src/mid.ts`:'));
    });

    it('should render context-pack v2 sections with real newlines when flag is enabled', async () => {
      FEATURE_FLAGS.context_packs_v2 = true;
      const mockBundle = createMockContextBundle();
      mockBundle.files[0]!.selectionRationale = 'Chosen for top relevance';
      mockBundle.dependencyMap = {
        'src/test.ts': ['src/helper.ts'],
      };
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'test' }, mockServiceClient as any);

      expect(result).toContain('## ✅ Why These Files');
      expect(result).toContain('## 🧭 Dependency Map');
      expect(result).not.toContain('\\\\n');
    });

    it('renders additive selection explainability when file context carries provenance receipts', async () => {
      const mockBundle = createMockContextBundle();
      (mockBundle.files[0] as any).selectionExplainability = {
        selectedBecause: ['graph seed symbol matched loginService'],
        scoreBreakdown: {
          baseScore: 0.71,
          graphScore: 0.1,
          combinedScore: 0.81,
        },
      };
      (mockBundle.files[0] as any).selectionProvenance = {
        graphStatus: 'ready',
        seedSymbols: ['loginService'],
        neighborPaths: ['src/auth/loginService.ts'],
      };
      mockServiceClient.getContextForPrompt.mockResolvedValue(mockBundle);

      const result = await handleGetContext({ query: 'login service' }, mockServiceClient as any);

      expect(result).toContain('Selection Signals');
      expect(result).toContain('graph seed symbol matched loginService');
      expect(result).toContain('Graph status: `ready`');
      expect(result).toContain('Seed symbols: `loginService`');
    });

    it('should show empty state message when no results', async () => {
      const emptyBundle: ContextBundle = {
        summary: 'No results',
        query: 'test',
        files: [],
        hints: [],
        metadata: {
          totalFiles: 0,
          totalSnippets: 0,
          totalTokens: 0,
          tokenBudget: 8000,
          truncated: false,
          searchTimeMs: 50,
        },
      };
      mockServiceClient.getContextForPrompt.mockResolvedValue(emptyBundle);

      const result = await handleGetContext({ query: 'nonexistent' }, mockServiceClient as any);

      expect(result).toContain('No relevant code found');
    });
  });

  describe('Tool Schema', () => {
    it('should have correct name', () => {
      expect(getContextTool.name).toBe('get_context_for_prompt');
    });

    it('should have required query property', () => {
      expect(getContextTool.inputSchema.required).toContain('query');
    });

    it('should have all expected properties', () => {
      const props = Object.keys(getContextTool.inputSchema.properties);
      expect(props).toContain('query');
      expect(props).toContain('max_files');
      expect(props).toContain('token_budget');
      expect(props).toContain('include_related');
      expect(props).toContain('min_relevance');
      expect(props).toContain('handoff_mode');
      expect(props).toContain('plan_id');
    });

    it('should expose additive handoff schema without changing required args', () => {
      expect(getContextTool.inputSchema.required).toEqual(['query']);
      expect(getContextTool.inputSchema.properties.handoff_mode).toEqual(
        expect.objectContaining({
          type: 'string',
          enum: ['none', 'active_plan'],
          default: 'none',
        })
      );
      expect(getContextTool.inputSchema.properties.plan_id).toEqual(
        expect.objectContaining({
          type: 'string',
        })
      );
    });
  });
});

/**
 * Helper to create mock context bundle
 */
function createMockContextBundle(): ContextBundle {
  const mockFile: FileContext = {
    path: 'src/test.ts',
    extension: '.ts',
    summary: 'Test module with helper functions',
    relevance: 0.85,
    tokenCount: 150,
    snippets: [
      {
        text: 'export function testHelper() {\n  return true;\n}',
        lines: '1-3',
        relevance: 0.85,
        tokenCount: 15,
        codeType: 'function',
      },
    ],
  };

  return {
    summary: 'Context for "test": 1 files from src, primarily containing function definitions',
    query: 'test',
    files: [mockFile],
    hints: ['File types: .ts (1)', 'Code patterns: function (1)'],
    metadata: {
      totalFiles: 1,
      totalSnippets: 1,
      totalTokens: 150,
      tokenBudget: 8000,
      truncated: false,
      searchTimeMs: 120,
    },
  };
}

function createFileContext(
  path: string,
  relevance: number,
  summary: string,
  snippetText: string
): FileContext {
  return {
    path,
    extension: '.ts',
    summary,
    relevance,
    tokenCount: 100,
    snippets: [
      {
        text: snippetText,
        lines: '1-5',
        relevance,
        tokenCount: 20,
        codeType: 'function',
      },
    ],
  };
}

async function createHandoffWorkspace(planId: string): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-handoff-context-'));
  initializePlanManagementServices(tempDir);
  const saveResult = await getPlanPersistenceService().savePlan(createPersistedPlan(planId), { overwrite: true });
  if (!saveResult.success) {
    throw new Error(saveResult.error ?? `Failed to save plan ${planId}`);
  }

  fs.mkdirSync(path.join(tempDir, '.memories'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, '.memories', 'decisions.md'),
    [
      '# Decisions',
      '',
      'This file stores architecture decisions.',
      '',
      '### [2026-04-17] Shared handoff contract',
      '- Keep the handoff payload fixed.',
      `- [meta] linked_plans: ${planId}`,
      '- [meta] created_at: 2026-04-17T00:00:00.000Z',
      '- [meta] updated_at: 2026-04-17T00:00:00.000Z',
      '',
      '### [2026-04-18] Linked review finding',
      '- Retrieval routing must not change.',
      '- [meta] subtype: review_finding',
      `- [meta] linked_plans: ${planId}`,
      '- [meta] linked_files: src/mcp/serviceClient.ts',
      '- [meta] updated_at: 2026-04-18T12:00:00.000Z',
      '- [meta] created_at: 2026-04-18T12:00:00.000Z',
      '',
    ].join('\n'),
    'utf-8'
  );

  return tempDir;
}

function createPersistedPlan(id: string) {
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
    context_files: ['src/mcp/tools/planManagement.ts', 'src/mcp/serviceClient.ts'],
    codebase_insights: ['Plan persistence and memory parsing already exist.'],
  };
}
