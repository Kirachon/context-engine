import { describe, it, expect } from '@jest/globals';
import { buildDetailedPrompt, buildStructuralPrompt, ENTERPRISE_FINDINGS_SCHEMA } from '../../../src/reviewer/prompts/enterprise.js';

describe('enterprise review prompts', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

  const context = `Path: src/a.ts
Lines 1-2
    1  const a = 1;
    2  const a = 2;`;

  const invariants = 'security: no eval()';

  it('buildStructuralPrompt keeps a compact, stable prompt shape', () => {
    const prompt = buildStructuralPrompt({
      diff,
      context,
      invariants,
      customInstructions: '  Prefer actionable feedback.  ',
    });

    expect(prompt).toContain('You are an expert code reviewer. Return only JSON matching the schema.');
    expect(prompt).toContain('Focus on architecture, API compatibility, error handling patterns, and test gaps.');
    expect(prompt).toContain('CUSTOM INSTRUCTIONS:');
    expect(prompt).toContain('DIFF:');
    expect(prompt).toContain('CONTEXT:');
    expect(prompt).toContain('INVARIANTS:');
    expect(prompt).toContain('SCHEMA:');
    expect(prompt).toContain(ENTERPRISE_FINDINGS_SCHEMA);
    expect(prompt).not.toContain('diff-first excerpts');
    expect(prompt).not.toContain('project policies');
    expect(prompt).not.toContain('Do NOT return prose.');
    expect(prompt).not.toContain('Prefer actionable feedback.  ');
  });

  it('buildDetailedPrompt keeps structural findings separate and compact', () => {
    const prompt = buildDetailedPrompt({
      diff,
      context,
      invariants,
      structuralFindingsJson: '{"findings":[]}',
      customInstructions: '  Focus on regression risk.  ',
    });

    expect(prompt).toContain('You are an expert code reviewer. Return only JSON matching the schema.');
    expect(prompt).toContain('Focus on correctness bugs, edge cases, security issues, and performance regressions.');
    expect(prompt).toContain('STRUCTURAL FINDINGS:');
    expect(prompt).toContain('DIFF:');
    expect(prompt).toContain('CONTEXT:');
    expect(prompt).toContain('INVARIANTS:');
    expect(prompt).toContain('SCHEMA:');
    expect(prompt).toContain(ENTERPRISE_FINDINGS_SCHEMA);
    expect(prompt).not.toContain('Use structural findings as guidance; add new findings only.');
    expect(prompt).not.toContain('diff-first excerpts');
    expect(prompt).not.toContain('project policies');
    expect(prompt).not.toContain('Focus on regression risk.  ');
  });
});
