import { describe, it, expect } from '@jest/globals';
import { parseUnifiedDiff } from '../../../src/reviewer/diff/parse.js';
import { runDeterministicPreflight } from '../../../src/reviewer/checks/preflight.js';

describe('reviewer/checks/preflight', () => {
  it('detects hotspots and public API changes in MCP tool paths', () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
`;

    const parsed = parseUnifiedDiff(diff);
    const result = runDeterministicPreflight(parsed);

    expect(result.hotspots).toContain('src/mcp');
    expect(result.public_api_changed).toBe(true);
    expect(result.config_changed).toBe(false);
    expect(result.tests_touched).toBe(false);
  });

  it('computes risk score using the documented formula', () => {
    const diff = `diff --git a/src/mcp/tools/x.ts b/src/mcp/tools/x.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/x.ts
+++ b/src/mcp/tools/x.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
`;

    const parsed = parseUnifiedDiff(diff);
    const result = runDeterministicPreflight(parsed);

    // base=1
    // hotspots=1 => +0.5
    // public_api_changed=true => +1.5
    // tests_not_touched=true => +1
    // total raw = 4.0 => ceil => 4
    expect(result.raw_risk_score).toBe(4);
    expect(result.risk_score).toBe(4);
  });
});

