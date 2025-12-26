import { describe, it, expect } from '@jest/globals';
import { parseUnifiedDiff } from '../../../src/reviewer/diff/parse.js';
import { runDeterministicPreflight } from '../../../src/reviewer/checks/preflight.js';
import { createContextPlan } from '../../../src/reviewer/context/planner.js';

describe('reviewer/context/planner', () => {
  it('prioritizes hotspot files and stays within budget', () => {
    const diff = `diff --git a/src/mcp/tools/a.ts b/src/mcp/tools/a.ts
index 1234567..abcdefg 100644
--- a/src/mcp/tools/a.ts
+++ b/src/mcp/tools/a.ts
@@ -1,2 +1,3 @@
 export const a = 1;
+export const b = 2;
diff --git a/src/other/b.ts b/src/other/b.ts
index 1234567..abcdefg 100644
--- a/src/other/b.ts
+++ b/src/other/b.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
`;

    const parsed = parseUnifiedDiff(diff);
    const preflight = runDeterministicPreflight(parsed);
    const plan = createContextPlan(parsed, preflight, { tokenBudget: 1000, maxFiles: 2 });

    expect(plan.budget).toBe(1000);
    expect(plan.allocations).toHaveLength(2);
    expect(plan.allocations[0].file).toBe('src/mcp/tools/a.ts');
    const total = plan.allocations.reduce((s, a) => s + a.tokenBudget, 0);
    expect(total).toBeLessThanOrEqual(1000);
  });
});

