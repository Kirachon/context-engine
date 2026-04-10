/**
 * Layer 3: MCP Interface Layer - Tool Manifest
 *
 * Provides capability discovery for MCP clients.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { buildManifestDiscoverability } from '../tooling/discoverability.js';

export interface ToolManifestArgs {
  // No arguments
}

export const MCP_SERVER_VERSION = '1.9.0';

export const toolManifest = {
  version: MCP_SERVER_VERSION,
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
    'static_analysis',
    'resources',
    'prompts',
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
    // Memory Tools (v1.4.1)
    'add_memory',
    'list_memories',
    // Planning Tools (v1.4.0)
    'create_plan',
    'refine_plan',
    'visualize_plan',
    'execute_plan',
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
    'review_auto',
    // Ecosystem utilities (optional)
    'check_invariants',
    'run_static_analysis',
    // Reactive Review tools (v1.6.0)
    'reactive_review_pr',
    'get_review_status',
    'pause_review',
    'resume_review',
    'get_review_telemetry',
    'scrub_secrets',
    'validate_content',
  ],
  discoverability: buildManifestDiscoverability(),
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
      version: '1.9.0',
      tools: ['review_diff'],
      features: [
        'Risk scoring (1-5) based on deterministic preflight',
        'Change classification (feature/bugfix/refactor/infra/docs)',
        'Hotspot detection for sensitive areas',
        'Structured JSON output suitable for CI/IDE integrations',
        'Optional local static analyzers (tsc/semgrep) for additional signal',
      ],
    },
    static_analysis: {
      description: 'Optional local static analyzers for CI/IDE feedback',
      version: '1.9.0',
      tools: ['run_static_analysis', 'check_invariants'],
      features: [
        'TypeScript typecheck via tsc (noEmit)',
        'Optional semgrep integration when available on PATH',
        'Deterministic output (no LLM) suitable for CI',
      ],
    },
  },
};

export function getToolManifest(): typeof toolManifest {
  return toolManifest;
}

export async function handleToolManifest(
  _args: ToolManifestArgs,
  _serviceClient: ContextServiceClient
): Promise<string> {
  return JSON.stringify(toolManifest, null, 2);
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
