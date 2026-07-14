/**
 * Layer 3: MCP Interface Layer - Index Status Tool
 *
 * Provides index health/metadata for observability.
 */

import { ContextServiceClient, IndexStatus } from '../serviceClient.js';
import { indexStatusOutputSchema } from '../schemas/convertedToolOutputSchemas.js';
import type { ContextEngineToolResult } from '../types/toolResult.js';
import { okResult } from '../utils/resultBuilder.js';
import { evaluateIndexFreshness } from './index.js';

export { indexStatusOutputSchema } from '../schemas/convertedToolOutputSchemas.js';

export interface IndexStatusArgs {
  // No arguments required for now
}

export type IndexStatusStructuredContent = {
  schema_version: 1;
  status: {
    workspace: string;
    state: IndexStatus['status'];
    lastIndexed: string | null;
    fileCount: number;
    isStale: boolean;
    lastError: string | null;
    /** R4 additive — omitted when healthy / unavailable. */
    staleCauses?: IndexStatus['staleCauses'];
    indexedGenerationFingerprint?: string | null;
    currentGenerationFingerprint?: string | null;
  };
  freshness: {
    code: string;
    severity: string;
    summary: string;
  };
  guidance: string[];
  embeddingRuntime: null | {
    state: string;
    configured: {
      id: string;
      modelId: string;
      vectorDimension: number;
    } | null;
    active: {
      id: string;
      modelId: string;
      vectorDimension: number;
    } | null;
    fallback: {
      id: string;
      modelId: string;
      vectorDimension: number;
    } | null;
    lastFailure: string | null;
    nextRetryAt: string | null;
    loadFailures: number | null;
    hashFallbackActive: boolean | null;
  };
  /** R6 additive composite health. */
  composite?: NonNullable<IndexStatus['composite']>;
  components?: NonNullable<IndexStatus['components']>;
};

function formatTableCell(value: string | undefined): string {
  return (value ?? 'None')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|');
}

function normalizeEmbeddingRuntime(status: IndexStatus): IndexStatusStructuredContent['embeddingRuntime'] {
  const runtime = status.embeddingRuntime;
  if (!runtime || runtime.state === 'uninitialized') {
    return null;
  }

  const normalizeRuntime = (value: typeof runtime.active | undefined) =>
    value
      ? {
          id: value.id,
          modelId: value.modelId,
          vectorDimension: value.vectorDimension,
        }
      : null;

  return {
    state: runtime.state,
    configured: normalizeRuntime(runtime.configured),
    active: normalizeRuntime(runtime.active),
    fallback: normalizeRuntime(runtime.fallback),
    lastFailure: runtime.lastFailure ?? null,
    nextRetryAt: runtime.nextRetryAt ?? null,
    loadFailures: runtime.loadFailures ?? null,
    hashFallbackActive: runtime.hashFallbackActive ?? null,
  };
}

export function buildIndexStatusStructuredContent(status: IndexStatus): IndexStatusStructuredContent {
  const freshness = evaluateIndexFreshness(status);
  return {
    schema_version: 1,
    status: {
      workspace: status.workspace,
      state: status.status,
      lastIndexed: status.lastIndexed ?? null,
      fileCount: status.fileCount,
      isStale: status.isStale,
      lastError: status.lastError ?? null,
      ...(status.staleCauses && status.staleCauses.length > 0
        ? { staleCauses: status.staleCauses }
        : {}),
      ...(status.indexedGenerationFingerprint !== undefined
        ? { indexedGenerationFingerprint: status.indexedGenerationFingerprint }
        : {}),
      ...(status.currentGenerationFingerprint !== undefined
        ? { currentGenerationFingerprint: status.currentGenerationFingerprint }
        : {}),
    },
    freshness: {
      code: freshness.code,
      severity: freshness.severity,
      summary: freshness.summary,
    },
    guidance: freshness.guidance,
    embeddingRuntime: normalizeEmbeddingRuntime(status),
    ...(status.composite ? { composite: status.composite, components: status.components } : {}),
  };
}

export function formatIndexStatusText(status: IndexStatus): string {
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
    `| **Last Error** | ${formatTableCell(status.lastError)} |\n` +
    `| **Freshness** | ${freshnessEmoji} ${freshness.code} |\n` +
    `| **Freshness Summary** | ${freshness.summary} |\n`;

  if (status.staleCauses && status.staleCauses.length > 0) {
    output += `| **Stale Causes** | ${status.staleCauses.join(', ')} |\n`;
  }
  if (status.indexedGenerationFingerprint) {
    output += `| **Indexed Generation** | \`${status.indexedGenerationFingerprint.slice(0, 12)}…\` |\n`;
  }
  if (status.currentGenerationFingerprint) {
    output += `| **Current Generation** | \`${status.currentGenerationFingerprint.slice(0, 12)}…\` |\n`;
  }

  if (status.embeddingRuntime && status.embeddingRuntime.state !== 'uninitialized') {
    const embeddingStatus =
      status.embeddingRuntime.state === 'degraded'
        ? `⚠️ degraded (fallback: \`${status.embeddingRuntime.active.id}\`; configured: \`${status.embeddingRuntime.configured.id}\`)`
        : `✅ ${status.embeddingRuntime.active.id}`;
    output += `| **Embedding Runtime** | ${embeddingStatus} |\n`;
    if (status.embeddingRuntime.state === 'degraded') {
      output +=
        `| **Embedding Failure** | ${formatTableCell(status.embeddingRuntime.lastFailure ?? 'Unknown')} |\n` +
        `| **Embedding Retry** | ${status.embeddingRuntime.nextRetryAt ?? 'pending'} |\n` +
        `| **Embedding Load Failures** | ${status.embeddingRuntime.loadFailures} |\n`;
    }
  }

  if (status.composite) {
    output += `| **Composite Overall** | ${status.composite.overall} |\n`;
    const parts = Object.entries(status.composite.components)
      .map(([id, report]) => `${id}=${report.state}`)
      .join(', ');
    output += `| **Components** | ${formatTableCell(parts)} |\n`;
  }

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
): Promise<ContextEngineToolResult<IndexStatusStructuredContent>> {
  const status = serviceClient.getIndexStatus();
  return okResult(formatIndexStatusText(status), buildIndexStatusStructuredContent(status));
}

export const indexStatusTool = {
  name: 'index_status',
  description: 'Retrieve current index health metadata (status, last indexed time, file count, staleness).',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputSchema: indexStatusOutputSchema,
};
