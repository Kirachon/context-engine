import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseUnifiedDiff } from '../../../src/reviewer/diff/parse.js';
import { loadInvariantsConfig } from '../../../src/reviewer/checks/invariants/load.js';
import { runInvariants } from '../../../src/reviewer/checks/invariants/runner.js';

describe('reviewer/checks/invariants', () => {
  it('loads YAML invariants and produces findings for deny/when_require', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-invariants-'));
    const invariantsPath = path.join(tmpDir, '.review-invariants.yml');

    fs.writeFileSync(
      invariantsPath,
      [
        'security:',
        '  - id: SEC001',
        '    rule: "If req.user is used, requireAuth() must be present"',
        '    paths: ["src/api/**"]',
        '    severity: CRITICAL',
        '    category: security',
        '    action: when_require',
        '    when: { regex: { pattern: "req\\\\.user" } }',
        '    require: { regex: { pattern: "requireAuth\\\\(" } }',
        '  - id: SEC002',
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

    const diff = `diff --git a/src/api/user.ts b/src/api/user.ts
index 1234567..abcdefg 100644
--- a/src/api/user.ts
+++ b/src/api/user.ts
@@ -1,2 +1,4 @@
 export function handler(req: any) {
+  const u = req.user;
+  eval("1+1");
 }
`;

    const parsed = parseUnifiedDiff(diff);
    const config = loadInvariantsConfig(tmpDir, '.review-invariants.yml');
    const result = runInvariants(parsed, ['src/api/user.ts'], config);

    expect(result.findings.map(f => f.id).sort()).toEqual(['SEC001', 'SEC002']);
    expect(result.checked_invariants).toBeGreaterThanOrEqual(2);
  });
});

