import type { EnterpriseFinding } from '../types.js';
import { excludeById, filterByAllowedValues, filterByThreshold, limitToMax } from './shared.js';

export function postProcessFindings(args: {
  mergedFindings: EnterpriseFinding[];
  confidenceThreshold: number;
  categories?: string[];
  allowlistFindingIds?: string[];
  maxFindings: number;
}): {
  filteredForOutput: EnterpriseFinding[];
  limitedFindings: EnterpriseFinding[];
} {
  const filtered = filterByAllowedValues(
    filterByThreshold(args.mergedFindings, f => f.confidence, args.confidenceThreshold),
    f => f.category as any,
    args.categories
  );

  const filteredForOutput = excludeById(filtered, f => f.id, args.allowlistFindingIds);
  const limitedFindings = limitToMax(filteredForOutput, args.maxFindings);

  return { filteredForOutput, limitedFindings };
}

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

export function evaluateFailurePolicy(args: {
  findings: EnterpriseFinding[];
  failOnSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  failOnInvariantIds: string[];
}): { shouldFail: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const failIds = new Set(args.failOnInvariantIds.filter(Boolean));
  const threshold = SEVERITY_ORDER[args.failOnSeverity] ?? SEVERITY_ORDER.CRITICAL;

  for (const f of args.findings) {
    if (failIds.has(f.id)) {
      reasons.push(`Invariant ${f.id} forced-fail`);
      continue;
    }
    const sev = SEVERITY_ORDER[f.severity] ?? 0;
    if (sev >= threshold) {
      reasons.push(`${f.severity} ${f.id}: ${f.title}`);
    }
  }

  return { shouldFail: reasons.length > 0, reasons: reasons.slice(0, 20) };
}
