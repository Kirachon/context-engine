import { describe, it, expect } from '@jest/globals';
import { handleReviewDiff } from '../../src/mcp/tools/reviewDiff.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('review_diff tool', () => {
  it('returns structured JSON result with deterministic findings', async () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
`;

    const resultStr = await handleReviewDiff(
      { diff, options: { max_findings: 10 } },
      { getWorkspacePath: () => process.cwd() } as any
    );
    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty('run_id');
    expect(result).toHaveProperty('risk_score', 4);
    expect(result).toHaveProperty('classification');
    expect(result).toHaveProperty('hotspots');
    expect(result).toHaveProperty('findings');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.stats.files_changed).toBe(1);
  });

  it('runs invariants when invariants_path is provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-reviewdiff-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(
      invPath,
      [
        'security:',
        '  - id: SEC999',
        '    rule: "No eval()"',
        '    paths: ["src/**"]',
        '    severity: HIGH',
        '    category: security',
        '    action: deny',
        '    deny: { regex: { pattern: "\\\\beval\\\\(" } }',
        '',
      ].join('\n'),
      'utf-8'
    );

    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export function a() {
+  eval("1+1");
   return 1;
 }
`;

    const resultStr = await handleReviewDiff(
      { diff, options: { max_findings: 10, invariants_path: invPath } },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.findings.some((f: any) => f.id === 'SEC999')).toBe(true);
  });

  it('runs LLM passes when enable_llm is true', async () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
`;

    let callCount = 0;
    const resultStr = await handleReviewDiff(
      { diff, options: { max_findings: 10, enable_llm: true, two_pass: true, risk_threshold: 3 } },
      {
        getWorkspacePath: () => process.cwd(),
        getFile: async () => `export const x = 1;\nexport const y = 2;\n`,
        searchAndAsk: async () => {
          callCount++;
          return JSON.stringify({
            findings: [
              {
                id: callCount === 1 ? 'F001' : 'F002',
                severity: callCount === 1 ? 'HIGH' : 'MEDIUM',
                category: callCount === 1 ? 'architecture' : 'correctness',
                confidence: 0.9,
                title: callCount === 1 ? 'Structural' : 'Detailed',
                location: { file: 'src/mcp/tools/x.ts', startLine: 1, endLine: 1 },
                evidence: ['e'],
                impact: 'i',
                recommendation: 'r',
              },
            ],
          });
        },
      } as any
    );

    const result = JSON.parse(resultStr);
    expect(result.stats.llm_passes_executed).toBe(2);
    expect(result.findings.some((f: any) => f.id === 'F001')).toBe(true);
    expect(result.findings.some((f: any) => f.id === 'F002')).toBe(true);
  });

  it('sets should_fail when a CRITICAL invariant is violated', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gate-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(
      invPath,
      [
        'security:',
        '  - id: SEC777',
        '    rule: "No eval()"',
        '    paths: ["src/**"]',
        '    severity: CRITICAL',
        '    category: security',
        '    action: deny',
        '    deny: { regex: { pattern: "\\\\beval\\\\(" } }',
        '',
      ].join('\n'),
      'utf-8'
    );

    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export function a() {
+  eval("1+1");
   return 1;
 }
`;

    const resultStr = await handleReviewDiff(
      { diff, options: { invariants_path: invPath } },
      { getWorkspacePath: () => tmpDir, getFile: async () => 'x', searchAndAsk: async () => '{}' } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.should_fail).toBe(true);
    expect(Array.isArray(result.fail_reasons)).toBe(true);
  });

  it('includes markdown when include_markdown is true', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export function a() {
+  eval("1+1");
   return 1;
 }
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-md-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(
      invPath,
      [
        'security:',
        '  - id: SEC888',
        '    rule: "No eval()"',
        '    paths: ["src/**"]',
        '    severity: CRITICAL',
        '    category: security',
        '    action: deny',
        '    deny: { regex: { pattern: "\\\\beval\\\\(" } }',
        '',
      ].join('\n'),
      'utf-8'
    );

    const resultStr = await handleReviewDiff(
      { diff, options: { invariants_path: invPath, include_markdown: true } },
      { getWorkspacePath: () => tmpDir, getFile: async () => 'x', searchAndAsk: async () => '{}' } as any
    );
    const result = JSON.parse(resultStr);
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown).toContain('## Code Review Summary');
    expect(result.markdown).toContain('## Findings');
  });
});
