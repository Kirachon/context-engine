import type { IndexStatus } from '../serviceClient.js';

type IndexFreshnessWarningOptions = {
  prefix?: string;
  subject?: string;
};

export interface IndexFreshnessInfo {
  code: 'healthy' | 'indexing' | 'unindexed' | 'stale' | 'error';
  severity: 'ok' | 'warning' | 'error';
  summary: string;
  guidance: string[];
}

export interface StartupAutoIndexDecision {
  shouldAutoIndex: boolean;
  freshness: IndexFreshnessInfo;
}

export function evaluateIndexFreshness(status: IndexStatus): IndexFreshnessInfo {
  if (status.status === 'error') {
    return {
      code: 'error',
      severity: 'error',
      summary: 'Index is unhealthy due to an indexing error.',
      guidance: [
        'Run `reindex_workspace` to rebuild from scratch.',
        'Review `lastError` and server logs for the root cause before retrying.',
      ],
    };
  }

  if (status.status === 'indexing') {
    return {
      code: 'indexing',
      severity: 'warning',
      summary: 'Indexing is currently in progress; results may be incomplete.',
      guidance: ['Wait for indexing to complete, then re-check with `index_status`.'],
    };
  }

  if (!status.lastIndexed) {
    return {
      code: 'unindexed',
      severity: 'warning',
      summary: 'Index has not been built yet for this workspace.',
      guidance: ['Run `index_workspace` to build the initial index.'],
    };
  }

  if (status.isStale) {
    return {
      code: 'stale',
      severity: 'warning',
      summary: 'Index appears stale and may not reflect recent file changes.',
      guidance: ['Run `index_workspace` to refresh or `reindex_workspace` for a full rebuild.'],
    };
  }

  return {
    code: 'healthy',
    severity: 'ok',
    summary: 'Index is healthy and up to date.',
    guidance: [],
  };
}

export function evaluateStartupAutoIndex(status: IndexStatus): StartupAutoIndexDecision {
  const freshness = evaluateIndexFreshness(status);
  return {
    shouldAutoIndex: freshness.code === 'unindexed' || freshness.code === 'stale',
    freshness,
  };
}

export function getIndexFreshnessWarning(
  status: IndexStatus,
  options: IndexFreshnessWarningOptions = {}
): string | null {
  const { prefix = '', subject = 'Results' } = options;
  const reasons: string[] = [];
  const freshness = evaluateIndexFreshness(status);

  if (freshness.code === 'error') {
    reasons.push(`index status is error${status.lastError ? ` (${status.lastError})` : ''}`);
  }
  if (freshness.code === 'unindexed') {
    reasons.push('workspace appears unindexed');
  }
  if (freshness.code === 'stale') {
    reasons.push('index is stale');
  }

  if (reasons.length === 0) {
    return null;
  }

  return `${prefix}Index freshness warning: ${reasons.join('; ')}. ${subject} may be incomplete or outdated until reindexing succeeds.`;
}
