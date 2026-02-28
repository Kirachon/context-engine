/**
 * Layer 3: MCP Interface Layer - Index Status Tool
 *
 * Provides index health/metadata for observability.
 */

import { ContextServiceClient, IndexStatus } from '../serviceClient.js';
import { evaluateIndexFreshness } from './index.js';

export interface IndexStatusArgs {
  // No arguments required for now
}

function formatStatus(status: IndexStatus): string {
  const freshness = evaluateIndexFreshness(status);
  const statusEmoji =
    status.status === 'indexing'
      ? '⏳'
      : status.status === 'error' || freshness.severity === 'error'
        ? '⚠️'
        : freshness.severity === 'warning'
          ? '🟡'
          : '✅';
  const freshnessEmoji =
    freshness.severity === 'error' ? '⚠️' : freshness.severity === 'warning' ? '🟡' : '✅';

  let output = `# 🩺 Index Status\n\n` +
    `| Property | Value |\n` +
    `|----------|-------|\n` +
    `| **Workspace** | \`${status.workspace}\` |\n` +
    `| **Status** | ${statusEmoji} ${status.status} |\n` +
    `| **Last Indexed** | ${status.lastIndexed ?? 'never'} |\n` +
    `| **File Count** | ${status.fileCount} |\n` +
    `| **Is Stale** | ${status.isStale ? 'Yes' : 'No'} |\n` +
    `| **Last Error** | ${status.lastError ?? 'None'} |\n` +
    `| **Freshness** | ${freshnessEmoji} ${freshness.code} |\n` +
    `| **Freshness Summary** | ${freshness.summary} |\n`;

  if (freshness.guidance.length > 0) {
    output += `\n## Freshness Guidance\n` +
      freshness.guidance.map((step) => `- ${step}`).join('\n') +
      '\n';
  }

  return output;
}

export async function handleIndexStatus(
  _args: IndexStatusArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const status = serviceClient.getIndexStatus();
  return formatStatus(status);
}

export const indexStatusTool = {
  name: 'index_status',
  description: 'Retrieve current index health metadata (status, last indexed time, file count, staleness).',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
