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
  version: '1.4.1',
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
