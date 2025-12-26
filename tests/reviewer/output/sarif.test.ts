import { describe, it, expect } from '@jest/globals';
import { toSarif } from '../../../src/reviewer/output/sarif.js';

describe('reviewer/output/sarif', () => {
  it('generates SARIF 2.1.0 with results', () => {
    const sarif = toSarif({
      run_id: 'r1',
      risk_score: 3,
      classification: 'feature',
      hotspots: [],
      summary: 's',
      findings: [
        {
          id: 'F001',
          severity: 'HIGH',
          category: 'security',
          confidence: 0.9,
          title: 'Issue',
          location: { file: 'src/a.ts', startLine: 1, endLine: 1 },
          evidence: ['e'],
          impact: 'i',
          recommendation: 'r',
        },
      ],
      stats: { files_changed: 1, lines_added: 1, lines_removed: 0, duration_ms: 1, deterministic_checks_executed: 1 },
      metadata: { reviewed_at: new Date().toISOString(), tool_version: 'x', warnings: [] },
    });

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
  });
});

