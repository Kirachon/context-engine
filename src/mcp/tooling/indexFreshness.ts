import type { IndexStatus } from '../serviceClient.js';

type IndexFreshnessWarningOptions = {
  prefix?: string;
  subject?: string;
};

export function getIndexFreshnessWarning(
  status: IndexStatus,
  options: IndexFreshnessWarningOptions = {}
): string | null {
  const { prefix = '', subject = 'Results' } = options;
  const reasons: string[] = [];

  if (status.status === 'error') {
    reasons.push(`index status is error${status.lastError ? ` (${status.lastError})` : ''}`);
  }
  if (!status.lastIndexed || status.fileCount === 0) {
    reasons.push('workspace appears unindexed');
  }
  if (status.isStale) {
    reasons.push('index is stale');
  }

  if (reasons.length === 0) {
    return null;
  }

  return `${prefix}Index freshness warning: ${reasons.join('; ')}. ${subject} may be incomplete or outdated until reindexing succeeds.`;
}
