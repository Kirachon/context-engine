import { describe, it, expect } from '@jest/globals';
import { parseUnifiedDiff } from '../../../src/reviewer/diff/parse.js';
import { classifyChange } from '../../../src/reviewer/diff/classify.js';

describe('reviewer/diff/classify', () => {
  it('classifies docs-only changes as docs', () => {
    const diff = `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Readme
+More docs
`;

    const parsed = parseUnifiedDiff(diff);
    expect(classifyChange(parsed)).toBe('docs');
  });

  it('classifies mostly-infra changes as infra', () => {
    const diff = `diff --git a/package.json b/package.json
index 1234567..abcdefg 100644
--- a/package.json
+++ b/package.json
@@ -1,3 +1,3 @@
 {
-  "name": "x"
+  "name": "y"
 }
diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/.github/workflows/test.yml
@@ -0,0 +1,2 @@
+name: Test
+on: [push]
`;

    const parsed = parseUnifiedDiff(diff);
    expect(classifyChange(parsed)).toBe('infra');
  });

  it('classifies new non-doc file additions as feature', () => {
    const diff = `diff --git a/src/newFeature.ts b/src/newFeature.ts
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/src/newFeature.ts
@@ -0,0 +1,3 @@
+export function add(a: number, b: number) {
+  return a + b;
+}
`;

    const parsed = parseUnifiedDiff(diff);
    expect(classifyChange(parsed)).toBe('feature');
  });

  it('classifies changes with bugfix-like keywords as bugfix', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function a() {
-  return "ok";
+  return "fix crash";
 }
`;

    const parsed = parseUnifiedDiff(diff);
    expect(classifyChange(parsed)).toBe('bugfix');
  });
});

