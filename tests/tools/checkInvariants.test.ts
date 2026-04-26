import { describe, it, expect } from '@jest/globals';
import { handleCheckInvariants } from '../../src/mcp/tools/checkInvariants.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('check_invariants tool', () => {
  it('throws the existing error message when diff is missing or invalid', async () => {
    await expect(
      handleCheckInvariants({ diff: undefined as unknown as string }, { getWorkspacePath: () => process.cwd() } as any)
    ).rejects.toThrow('Missing or invalid "diff" argument. Provide a unified diff string.');

    await expect(
      handleCheckInvariants({ diff: '' }, { getWorkspacePath: () => process.cwd() } as any)
    ).rejects.toThrow('Missing or invalid "diff" argument. Provide a unified diff string.');

    await expect(
      handleCheckInvariants({ diff: '   \n\t  ' }, { getWorkspacePath: () => process.cwd() } as any)
    ).rejects.toThrow('Missing or invalid "diff" argument. Provide a unified diff string.');

    await expect(
      handleCheckInvariants({ diff: 123 as unknown as string }, { getWorkspacePath: () => process.cwd() } as any)
    ).rejects.toThrow('Missing or invalid "diff" argument. Provide a unified diff string.');
  });

  it('returns findings when invariants are violated', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(
      invPath,
      [
        'security:',
        '  - id: SEC123',
        '    rule: \"No eval()\"',
        '    paths: [\"src/**\"]',
        '    severity: HIGH',
        '    category: security',
        '    action: deny',
        '    deny:',
        '      regex:',
        '        pattern: \"\\\\beval\\\\(\"',
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
+  eval(\"1+1\");
   return 1;
 }
`;

    const resultStr = await handleCheckInvariants(
      { diff, invariants_path: '.review-invariants.yml' },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(result.findings.some((f: any) => f.id === 'SEC123')).toBe(true);
  });

  it('blocks malformed non-empty diff input with no reviewable scope', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-malformed-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(invPath, 'security: []\n', 'utf-8');

    await expect(
      handleCheckInvariants(
        { diff: 'plain text, not a diff', invariants_path: '.review-invariants.yml' },
        { getWorkspacePath: () => tmpDir } as any
      )
    ).rejects.toThrow('No reviewable changes found in diff scope. Provide a unified diff with at least one changed file.');
  });

  it('allows malformed diff text when changed_files explicitly provides scope', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-malformed-scope-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(invPath, 'security: []\n', 'utf-8');

    const resultStr = await handleCheckInvariants(
      { diff: 'plain text, not a diff', changed_files: ['src/a.ts'], invariants_path: '.review-invariants.yml' },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('accepts partial git-style file sections without hunks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-partial-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(invPath, 'security: []\n', 'utf-8');
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
`;

    const resultStr = await handleCheckInvariants(
      { diff, invariants_path: '.review-invariants.yml' },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('rejects invariants_path outside the workspace', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-outside-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-outside-file-'));
    const outsidePath = path.join(outsideDir, '.review-invariants.yml');
    fs.writeFileSync(outsidePath, 'security: []\n', 'utf-8');

    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;

    const absoluteResult = JSON.parse(
      await handleCheckInvariants(
        { diff, invariants_path: outsidePath },
        { getWorkspacePath: () => tmpDir } as any
      )
    );
    expect(absoluteResult.success).toBe(false);
    expect(absoluteResult.error).toMatch(/absolute or drive-qualified paths are not allowed/i);

    const traversalResult = JSON.parse(
      await handleCheckInvariants(
        { diff, invariants_path: '../.review-invariants.yml' },
        { getWorkspacePath: () => tmpDir } as any
      )
    );
    expect(traversalResult.success).toBe(false);
    expect(traversalResult.error).toMatch(/path traversal is not allowed/i);
  });
});
