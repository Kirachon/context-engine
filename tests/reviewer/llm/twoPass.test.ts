import { describe, it, expect } from '@jest/globals';
import { runTwoPassReview } from '../../../src/reviewer/llm/twoPass.js';
import type { EnterpriseLLMClient } from '../../../src/reviewer/llm/types.js';

describe('reviewer/llm/twoPass', () => {
  it('runs structural and detailed passes when risk is high', async () => {
    const calls: string[] = [];
    const llm: EnterpriseLLMClient = {
      call: async (_q, prompt) => {
        calls.push(prompt);
        if (calls.length === 1) {
          return JSON.stringify({
            findings: [
              {
                id: 'F001',
                severity: 'HIGH',
                category: 'architecture',
                confidence: 0.9,
                title: 'Structural issue',
                location: { file: 'src/a.ts', startLine: 1, endLine: 1 },
                evidence: ['x'],
                impact: 'y',
                recommendation: 'z',
              },
            ],
          });
        }
        return JSON.stringify({
          findings: [
            {
              id: 'F002',
              severity: 'MEDIUM',
              category: 'correctness',
              confidence: 0.8,
              title: 'Detailed issue',
              location: { file: 'src/a.ts', startLine: 2, endLine: 2 },
              evidence: ['x2'],
              impact: 'y2',
              recommendation: 'z2',
            },
          ],
        });
      },
      model: 'mock',
    };

    const result = await runTwoPassReview({
      llm,
      options: { enabled: true, twoPass: true, riskThreshold: 3 },
      riskScore: 4,
      buildStructuralPrompt: () => 'structural',
      buildDetailedPrompt: (_json) => 'detailed',
    });

    expect(result.passes_executed).toBe(2);
    expect(result.findings.map(f => f.id).sort()).toEqual(['F001', 'F002']);
  });
});

