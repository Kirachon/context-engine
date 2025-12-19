import type { ContextBundle, IndexResult, IndexStatus, SearchResult } from '../../src/mcp/serviceClient.js';
import type { EnhancedPlanOutput } from '../../src/mcp/types/planning.js';

export const FIXED_TIME_ISO = '2025-01-01T00:00:00.000Z';

export type SnapshotCase = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expectError?: boolean;
};

export const SEARCH_RESULTS: Record<string, SearchResult[]> = {
  default: [
    {
      path: 'src/auth/login.ts',
      content: 'export function login(user) {\n  return user;\n}\n',
      relevanceScore: 0.92,
      lines: '1-3',
      matchType: 'semantic',
      retrievedAt: FIXED_TIME_ISO,
    },
    {
      path: 'src/db/schema.ts',
      content: 'export const schema = {\n  users: {}\n};\n',
      relevanceScore: 0.65,
      lines: '1-3',
      matchType: 'semantic',
      retrievedAt: FIXED_TIME_ISO,
    },
    {
      path: 'src/auth/login.ts',
      content: '// helper\nexport function hashPassword(pwd) {\n  return pwd;\n}\n',
      relevanceScore: 0.55,
      lines: '5-8',
      matchType: 'semantic',
      retrievedAt: FIXED_TIME_ISO,
    },
  ],
  database: [
    {
      path: 'src/db/connection.ts',
      content: 'export function connect() {\n  return true;\n}\n',
      relevanceScore: 0.88,
      lines: '1-3',
      matchType: 'semantic',
      retrievedAt: FIXED_TIME_ISO,
    },
    {
      path: 'src/db/schema.ts',
      content: 'export const schema = {\n  users: {}\n};\n',
      relevanceScore: 0.72,
      lines: '1-3',
      matchType: 'semantic',
      retrievedAt: FIXED_TIME_ISO,
    },
  ],
};

export const INDEX_STATUS: IndexStatus = {
  workspace: 'D:/mock-workspace',
  status: 'idle',
  lastIndexed: FIXED_TIME_ISO,
  fileCount: 42,
  isStale: false,
  lastError: undefined,
};

export const INDEX_RESULT: IndexResult = {
  indexed: 12,
  skipped: 2,
  errors: [],
  duration: 0,
};

export const FILE_CONTENTS: Record<string, string> = {
  'README.md': '# Readme\n\nThis is a mock readme.\n',
  'src/auth/login.ts': 'export function login() {\n  return true;\n}\n',
};

export const BASE_PLAN: EnhancedPlanOutput = {
  id: 'plan_test',
  version: 1,
  created_at: FIXED_TIME_ISO,
  updated_at: FIXED_TIME_ISO,
  goal: 'Test planning output',
  scope: { included: ['Core flow'], excluded: ['Nice-to-have'], assumptions: [], constraints: [] },
  mvp_features: [
    { name: 'MVP Feature', description: 'Minimal test feature', steps: [1] },
  ],
  nice_to_have_features: [],
  architecture: {
    notes: 'Keep it simple',
    patterns_used: ['Adapter'],
    diagrams: [],
  },
  risks: [
    { issue: 'Mock risk', mitigation: 'Mitigate with tests', likelihood: 'low', impact: 'Low' },
  ],
  milestones: [],
  steps: [
    {
      step_number: 1,
      id: 'step_1',
      title: 'Setup',
      description: 'Create initial scaffolding',
      files_to_modify: [{ path: 'src/app.ts', change_type: 'modify', estimated_loc: 12, complexity: 'simple', reason: 'Mock change' }],
      files_to_create: [],
      files_to_delete: [],
      depends_on: [],
      blocks: [],
      can_parallel_with: [],
      priority: 'high',
      estimated_effort: '1h',
      acceptance_criteria: ['Build passes'],
    },
  ],
  dependency_graph: {
    nodes: [{ id: 'step_1', step_number: 1 }],
    edges: [],
    critical_path: [1],
    parallel_groups: [],
    execution_order: [1],
  },
  testing_strategy: {
    unit: 'Mock unit tests',
    integration: 'Mock integration tests',
    e2e: 'Mock e2e tests',
    coverage_target: '80%',
    test_files: [],
  },
  acceptance_criteria: [
    { description: 'Snapshot outputs match', verification: 'Run snapshot harness' },
  ],
  confidence_score: 0.5,
  questions_for_clarification: ['Any special constraints?'],
  context_files: ['src/app.ts'],
  codebase_insights: ['Mock insight'],
};

export function buildContextBundle(query: string, tokenBudget = 8000): ContextBundle {
  return {
    summary: `Context for "${query}" with 2 files`,
    query,
    files: [
      {
        path: 'src/auth/login.ts',
        extension: '.ts',
        summary: 'Login handler and helpers',
        relevance: 0.9,
        tokenCount: 120,
        snippets: [
          {
            text: 'export function login(user) {\n  return user;\n}\n',
            lines: '1-3',
            relevance: 0.9,
            tokenCount: 25,
            codeType: 'function',
          },
        ],
        relatedFiles: ['src/auth/hash.ts'],
      },
      {
        path: 'src/db/schema.ts',
        extension: '.ts',
        summary: 'Database schema definitions',
        relevance: 0.6,
        tokenCount: 80,
        snippets: [
          {
            text: 'export const schema = {\n  users: {}\n};\n',
            lines: '1-3',
            relevance: 0.6,
            tokenCount: 20,
          },
        ],
      },
    ],
    hints: ['Focus on login flow', 'Schema defines users'],
    memories: [
      { category: 'facts', content: 'Uses SQLite in tests', relevanceScore: 0.6 },
    ],
    metadata: {
      totalFiles: 2,
      totalSnippets: 2,
      totalTokens: 200,
      tokenBudget,
      truncated: false,
      searchTimeMs: 12,
      memoriesIncluded: 1,
    },
  };
}

export const SNAPSHOT_CASES: SnapshotCase[] = [
  { id: 'codebase_retrieval/auth', tool: 'codebase_retrieval', args: { query: 'auth flow', top_k: 3 } },
  { id: 'codebase_retrieval/database', tool: 'codebase_retrieval', args: { query: 'database schema', top_k: 2 } },
  { id: 'codebase_retrieval/short', tool: 'codebase_retrieval', args: { query: 'login', top_k: 1 } },
  { id: 'semantic_search/auth', tool: 'semantic_search', args: { query: 'auth flow', top_k: 3 } },
  { id: 'semantic_search/database', tool: 'semantic_search', args: { query: 'database schema', top_k: 2 } },
  { id: 'semantic_search/short', tool: 'semantic_search', args: { query: 'login', top_k: 1 } },
  { id: 'get_context_for_prompt/basic', tool: 'get_context_for_prompt', args: { query: 'auth flow', max_files: 2, token_budget: 1200, include_related: true, min_relevance: 0.2 } },
  { id: 'get_context_for_prompt/database', tool: 'get_context_for_prompt', args: { query: 'database schema', max_files: 1, token_budget: 900, include_related: false, min_relevance: 0.2 } },
  { id: 'get_context_for_prompt/short', tool: 'get_context_for_prompt', args: { query: 'login', max_files: 1, token_budget: 800, include_related: true, min_relevance: 0.3 } },
  { id: 'enhance_prompt/short', tool: 'enhance_prompt', args: { prompt: 'fix login bug' } },
  { id: 'enhance_prompt/medium', tool: 'enhance_prompt', args: { prompt: 'add rate limiting to the auth endpoint' } },
  { id: 'enhance_prompt/long', tool: 'enhance_prompt', args: { prompt: 'refactor the auth module to separate validation from persistence and add tests' } },
  { id: 'get_file/readme', tool: 'get_file', args: { path: 'README.md' } },
  { id: 'index_status/basic', tool: 'index_status', args: {} },
  { id: 'tool_manifest/basic', tool: 'tool_manifest', args: {} },
  { id: 'visualize_plan/dependencies', tool: 'visualize_plan', args: { plan: JSON.stringify(BASE_PLAN), diagram_type: 'dependencies' } },
  { id: 'list_memories/basic', tool: 'list_memories', args: {} },
  { id: 'error/semantic_search_empty', tool: 'semantic_search', args: { query: '' }, expectError: true },
  { id: 'error/codebase_retrieval_topk', tool: 'codebase_retrieval', args: { query: 'test', top_k: 0 }, expectError: true },
  { id: 'error/get_context_token_budget', tool: 'get_context_for_prompt', args: { query: 'test', token_budget: 100 }, expectError: true },
  { id: 'error/enhance_prompt_empty', tool: 'enhance_prompt', args: { prompt: '' }, expectError: true },
  { id: 'error/get_file_range', tool: 'get_file', args: { path: 'README.md', start_line: 5, end_line: 2 }, expectError: true },
];
