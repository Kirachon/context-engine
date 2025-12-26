/**
 * Layer 3: MCP Interface Layer - Tool Manifest
 *
 * Provides capability discovery for MCP clients.
 */

import { ContextServiceClient } from '../serviceClient.js';

export interface ToolManifestArgs {
  // No arguments
}

const manifest = {
  version: '1.8.0',
  capabilities: [
    'semantic_search',
    'file_retrieval',
    'context_enhancement',
    'index_status',
    'lifecycle',
    'automation',
    'policy',
    'planning',
    'plan_persistence',
    'approval_workflow',
    'execution_tracking',
    'version_history',
    'code_review',
    'enterprise_review',
  ],
  tools: [
    // Core Context Tools
    'index_workspace',
    'codebase_retrieval',
    'semantic_search',
    'get_file',
    'get_context_for_prompt',
    'enhance_prompt',
    // Index Management Tools
    'index_status',
    'reindex_workspace',
    'clear_index',
    'tool_manifest',
    // Planning Tools (v1.4.0)
    'create_plan',
    'refine_plan',
    'visualize_plan',
    // Plan Persistence Tools (v1.4.0)
    'save_plan',
    'load_plan',
    'list_plans',
    'delete_plan',
    // Approval Workflow Tools (v1.4.0)
    'request_approval',
    'respond_approval',
    // Execution Tracking Tools (v1.4.0)
    'start_step',
    'complete_step',
    'fail_step',
    'view_progress',
    // History & Versioning Tools (v1.4.0)
    'view_history',
    'compare_plan_versions',
    'rollback_plan',
    // Code Review Tools (v1.7.0)
    'review_changes',
    'review_git_diff',
    // Enterprise Review (v1.8.0)
    'review_diff',
  ],
  features: {
    planning: {
      description: 'AI-powered implementation planning with DAG analysis',
      version: '1.4.0',
      tools: ['create_plan', 'refine_plan', 'visualize_plan'],
    },
    persistence: {
      description: 'Save, load, and manage execution plans',
      version: '1.4.0',
      tools: ['save_plan', 'load_plan', 'list_plans', 'delete_plan'],
    },
    approval_workflow: {
      description: 'Built-in approval system for plans and steps',
      version: '1.4.0',
      tools: ['request_approval', 'respond_approval'],
    },
    execution_tracking: {
      description: 'Step-by-step execution with dependency management',
      version: '1.4.0',
      tools: ['start_step', 'complete_step', 'fail_step', 'view_progress'],
    },
    version_history: {
      description: 'Plan versioning with diff and rollback support',
      version: '1.4.0',
      tools: ['view_history', 'compare_plan_versions', 'rollback_plan'],
    },
    defensive_programming: {
      description: 'Comprehensive null/undefined handling across all services',
      version: '1.4.1',
      improvements: [
        'Safe array handling in all planning services',
        'Fallback values for missing properties',
        'Enhanced error messages with context',
      ],
    },
    internal_handlers: {
      description: 'Layer 2.5 - Internal shared handlers for code consolidation',
      version: '1.5.0',
      improvements: [
        'Shared retrieval, context, and enhancement handlers',
        'Advanced retrieval features (dedupe, expand, rerank)',
        'Snapshot testing infrastructure for regression checks',
        'Reduced code duplication (~100 lines in enhance.ts)',
        'Tool inventory generator and documentation',
      ],
    },
    code_review: {
      description: 'AI-powered code review with structured output and confidence scoring',
      version: '1.7.0',
      tools: ['review_changes', 'review_git_diff'],
      features: [
        'Structured output schema (Codex-style findings)',
        'Confidence scoring per finding and overall',
        'Priority levels (P0-P3) with semantic meaning',
        'Changed lines filter to reduce noise',
        'Category-based analysis (correctness, security, performance, etc.)',
        'Actionable fix suggestions',
        'Git integration (automatic diff retrieval)',
        'Support for staged, unstaged, branch, and commit diffs',
      ],
    },
    enterprise_review: {
      description: 'Deterministic diff-first preflight review with risk scoring',
      version: '1.8.0',
      tools: ['review_diff'],
      features: [
        'Risk scoring (1-5) based on deterministic preflight',
        'Change classification (feature/bugfix/refactor/infra/docs)',
        'Hotspot detection for sensitive areas',
        'Structured JSON output suitable for CI/IDE integrations',
      ],
    },
  },
};

export async function handleToolManifest(
  _args: ToolManifestArgs,
  _serviceClient: ContextServiceClient
): Promise<string> {
  return JSON.stringify(manifest, null, 2);
}

export const toolManifestTool = {
  name: 'tool_manifest',
  description: 'Discover available tools and capabilities exposed by the server.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
