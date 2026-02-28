/**
 * Layer 3: MCP Interface Layer - Lifecycle Tools
 *
 * Provides workspace lifecycle operations: reindex and clear index.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { evaluateIndexFreshness } from './index.js';

export interface ReindexWorkspaceArgs {
  // Optional future flags can be added here
}

export interface ClearIndexArgs {
  // No parameters needed
}

export async function handleReindexWorkspace(
  _args: ReindexWorkspaceArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const startTime = Date.now();

  await serviceClient.clearIndex();
  const result = await serviceClient.indexWorkspace();
  const status = serviceClient.getIndexStatus();
  const freshness = evaluateIndexFreshness(status);

  const elapsed = Date.now() - startTime;

  return JSON.stringify(
    {
      success: true,
      message: 'Workspace reindexed successfully',
      elapsed_ms: elapsed,
      indexed: result.indexed,
      skipped: result.skipped,
      errors: result.errors,
      index_status: status.status,
      is_stale: status.isStale,
      last_indexed: status.lastIndexed,
      freshness: freshness.code,
      freshness_message: freshness.summary,
      freshness_guidance: freshness.guidance,
      last_error: status.lastError ?? null,
    },
    null,
    2
  );
}

export async function handleClearIndex(
  _args: ClearIndexArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  await serviceClient.clearIndex();
  const status = serviceClient.getIndexStatus();
  const freshness = evaluateIndexFreshness(status);
  return JSON.stringify(
    {
      success: true,
      message: 'Index cleared. Re-run index_workspace to rebuild.',
      index_status: status.status,
      is_stale: status.isStale,
      last_indexed: status.lastIndexed,
      freshness: freshness.code,
      freshness_message: freshness.summary,
      freshness_guidance: freshness.guidance,
      last_error: status.lastError ?? null,
    },
    null,
    2
  );
}

export const reindexWorkspaceTool = {
  name: 'reindex_workspace',
  description: 'Clear current index state and rebuild it from scratch.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const clearIndexTool = {
  name: 'clear_index',
  description: 'Remove saved index state and clear caches without rebuilding.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
