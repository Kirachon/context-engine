import { describe, it, expect } from '@jest/globals';
import { evaluateFailurePolicy, postProcessFindings } from '../../../src/reviewer/post/normalize.js';
import type { EnterpriseFinding } from '../../../src/reviewer/types.js';

function f(partial: Partial<EnterpriseFinding> & Pick<EnterpriseFinding, 'id' | 'severity' | 'category' | 'confidence' | 'title'>): EnterpriseFinding {
  return {
    id: partial.id,
    severity: partial.severity,
    category: partial.category,
    confidence: partial.confidence,
    title: partial.title,
    location: partial.location ?? { file: 'src/a.ts', startLine: 1, endLine: 1 },
    evidence: partial.evidence ?? [],
    impact: partial.impact ?? 'impact',
    recommendation: partial.recommendation ?? 'recommendation',
    suggested_patch: partial.suggested_patch,
  };
}

describe('reviewer/post/normalize', () => {
  it('postProcessFindings preserves input order (no sorting) while filtering/allowlisting/limiting', () => {
    const mergedFindings = [
      f({ id: 'A', severity: 'LOW', category: 'style', confidence: 0.9, title: 'A' }),
      f({ id: 'B', severity: 'CRITICAL', category: 'security', confidence: 0.2, title: 'B' }), // filtered by confidence
      f({ id: 'C', severity: 'HIGH', category: 'security', confidence: 0.9, title: 'C' }), // allowlisted
      f({ id: 'D', severity: 'MEDIUM', category: 'security', confidence: 0.9, title: 'D' }),
      f({ id: 'E', severity: 'INFO', category: 'documentation', confidence: 0.9, title: 'E' }),
    ];

    const { filteredForOutput, limitedFindings } = postProcessFindings({
      mergedFindings,
      confidenceThreshold: 0.55,
      categories: undefined,
      allowlistFindingIds: ['C'],
      maxFindings: 2,
    });

    expect(filteredForOutput.map(x => x.id)).toEqual(['A', 'D', 'E']);
    expect(limitedFindings.map(x => x.id)).toEqual(['A', 'D']);
  });

  it('evaluateFailurePolicy respects fail_on_severity and fail_on_invariant_ids', () => {
    const findings = [
      f({ id: 'X', severity: 'LOW', category: 'style', confidence: 0.9, title: 'x' }),
      f({ id: 'Y', severity: 'HIGH', category: 'security', confidence: 0.9, title: 'y' }),
      f({ id: 'Z', severity: 'INFO', category: 'maintainability', confidence: 0.9, title: 'z' }),
    ];

    const bySeverity = evaluateFailurePolicy({
      findings,
      failOnSeverity: 'HIGH',
      failOnInvariantIds: [],
    });
    expect(bySeverity.shouldFail).toBe(true);
    expect(bySeverity.reasons.some(r => r.includes('HIGH Y'))).toBe(true);

    const forced = evaluateFailurePolicy({
      findings,
      failOnSeverity: 'CRITICAL',
      failOnInvariantIds: ['Z'],
    });
    expect(forced.shouldFail).toBe(true);
    expect(forced.reasons.some(r => r.includes('Invariant Z forced-fail'))).toBe(true);
  });
});

