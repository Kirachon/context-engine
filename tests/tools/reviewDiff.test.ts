import { describe, it, expect } from '@jest/globals';
import { handleReviewDiff } from '../../src/mcp/tools/reviewDiff.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('review_diff tool', () => {
  it('throws the existing error message when diff is missing or invalid', async () => {
    await expect(handleReviewDiff({ diff: undefined as unknown as string }, {} as any)).rejects.toThrow(
      'Missing or invalid "diff" argument. Provide a unified diff string.'
    );

    await expect(handleReviewDiff({ diff: '' }, {} as any)).rejects.toThrow(
      'Missing or invalid "diff" argument. Provide a unified diff string.'
    );

    await expect(handleReviewDiff({ diff: '   \n\t  ' }, {} as any)).rejects.toThrow(
      'Missing or invalid "diff" argument. Provide a unified diff string.'
    );

    await expect(handleReviewDiff({ diff: 123 as unknown as string }, {} as any)).rejects.toThrow(
      'Missing or invalid "diff" argument. Provide a unified diff string.'
    );
  });

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
    expect(result).not.toHaveProperty('flow');
    expect(result.stats.files_changed).toBe(1);
    expect(result.stats).toHaveProperty('timings_ms');
    expect(typeof result.stats.timings_ms.preflight).toBe('number');
  });

  it('exposes static analyzer metadata when static analysis is enabled', async () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
`;

    const resultStr = await handleReviewDiff(
      { diff, options: { enable_static_analysis: true, static_analyzers: ['semgrep'] } },
      { getWorkspacePath: () => process.cwd() } as any
    );
    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty('static_analysis');
    expect(result.static_analysis).toHaveProperty('analyzers_requested', ['semgrep']);
    expect(Array.isArray(result.static_analysis.analyzers_executed)).toBe(true);
    expect(Array.isArray(result.static_analysis.results)).toBe(true);
    expect(Array.isArray(result.static_analysis.warnings)).toBe(true);
    expect(result.static_analysis.results.length).toBeGreaterThanOrEqual(1);
    expect(result.static_analysis.results[0]).toHaveProperty('analyzer', 'semgrep');
    expect(typeof result.static_analysis.results[0].duration_ms).toBe('number');
  });

  it('blocks malformed non-empty diff input with no reviewable scope', async () => {
    await expect(
      handleReviewDiff(
        { diff: 'plain text, not a diff' },
        { getWorkspacePath: () => process.cwd(), getFile: async () => '', searchAndAsk: async () => '' } as any
      )
    ).rejects.toThrow('No reviewable changes found in diff scope. Provide a unified diff with at least one changed file.');
  });

  it('allows malformed diff text when changed_files explicitly provides scope', async () => {
    const resultStr = await handleReviewDiff(
      { diff: 'plain text, not a diff', changed_files: ['src/a.ts'] },
      { getWorkspacePath: () => process.cwd(), getFile: async () => '', searchAndAsk: async () => '' } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.stats.files_changed).toBe(1);
  });

  it('accepts partial git-style file sections without hunks', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
`;
    const resultStr = await handleReviewDiff(
      { diff },
      { getWorkspacePath: () => process.cwd(), getFile: async () => '', searchAndAsk: async () => '' } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.stats.files_changed).toBe(1);
    expect(result.stats.lines_added).toBe(0);
    expect(result.stats.lines_removed).toBe(0);
  });

  it('does not require provider/model resolution when enable_llm is false', async () => {
    const originalProvider = process.env.CE_AI_PROVIDER;
    process.env.CE_AI_PROVIDER = 'invalid-provider-value';
    try {
      const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;
      const resultStr = await handleReviewDiff(
        { diff, options: { enable_llm: false } },
        { getWorkspacePath: () => process.cwd(), getFile: async () => '' } as any
      );
      const result = JSON.parse(resultStr);
      expect(result).toHaveProperty('stats');
    } finally {
      if (originalProvider === undefined) delete process.env.CE_AI_PROVIDER;
      else process.env.CE_AI_PROVIDER = originalProvider;
    }
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

    const previous = process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS;
    process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS = '65000';

    let callCount = 0;
    const callArgs: unknown[][] = [];
    try {
      const resultStr = await handleReviewDiff(
        { diff, options: { max_findings: 10, enable_llm: true, two_pass: true, risk_threshold: 3 } },
        {
          getWorkspacePath: () => process.cwd(),
          getFile: async () => `export const x = 1;\nexport const y = 2;\n`,
          getActiveAIModelLabel: () => 'test-model',
          searchAndAsk: async (...args: unknown[]) => {
            callArgs.push(args);
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
      expect(typeof result.stats.timings_ms.llm_structural).toBe('number');
      expect(callArgs.every((args) => (args[2] as { timeoutMs?: number } | undefined)?.timeoutMs === 65000)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS;
      else process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS = previous;
    }
  });

  it('uses per-call llm_timeout_ms override when provided', async () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
`;

    const previous = process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS;
    process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS = '65000';

    let capturedTimeoutMs: number | undefined;
    try {
      const resultStr = await handleReviewDiff(
        {
          diff,
          options: {
            enable_llm: true,
            llm_timeout_ms: 120000,
            two_pass: true,
            risk_threshold: 3,
          },
        },
        {
          getWorkspacePath: () => process.cwd(),
          getFile: async () => `export const x = 1;\nexport const y = 2;\n`,
          getActiveAIModelLabel: () => 'test-model',
          searchAndAsk: async (_searchQuery: string, _prompt: string, opts?: { timeoutMs?: number }) => {
            capturedTimeoutMs = opts?.timeoutMs;
            return JSON.stringify({
              findings: [
                {
                  id: 'F001',
                  severity: 'HIGH',
                  category: 'architecture',
                  confidence: 0.9,
                  title: 'Structural',
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
      expect(capturedTimeoutMs).toBe(120000);
    } finally {
      if (previous === undefined) delete process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS;
      else process.env.CE_REVIEW_DIFF_LLM_TIMEOUT_MS = previous;
    }
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
