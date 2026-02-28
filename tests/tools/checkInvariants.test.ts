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
      { diff, invariants_path: invPath },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(result.findings.some((f: any) => f.id === 'SEC123')).toBe(true);
  });

  it('keeps existing behavior for malformed non-empty diff input', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-inv-malformed-'));
    const invPath = path.join(tmpDir, '.review-invariants.yml');
    fs.writeFileSync(invPath, 'security: []\n', 'utf-8');

    const resultStr = await handleCheckInvariants(
      { diff: 'plain text, not a diff', invariants_path: invPath },
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
      { diff, invariants_path: invPath },
      { getWorkspacePath: () => tmpDir } as any
    );
    const result = JSON.parse(resultStr);
    expect(result.success).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
