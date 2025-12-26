import { describe, it, expect } from '@jest/globals';
import { dedupeFindingsById } from '../../../src/reviewer/post/findings.js';
import type { EnterpriseFinding } from '../../../src/reviewer/types.js';

function f(id: string): EnterpriseFinding {
  return {
    id,
    severity: 'LOW',
    category: 'style',
    confidence: 0.9,
    title: id,
    location: { file: 'src/a.ts', startLine: 1, endLine: 1 },
    evidence: [],
    impact: 'impact',
    recommendation: 'rec',
  };
}

describe('reviewer/post/findings', () => {
  it('dedupeFindingsById preserves first occurrence order', () => {
    const input = [f('A'), f('B'), f('A'), f('C'), f('B')];
    const out = dedupeFindingsById(input);
    expect(out.map(x => x.id)).toEqual(['A', 'B', 'C']);
  });
});

