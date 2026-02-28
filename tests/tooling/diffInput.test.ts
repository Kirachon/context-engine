import { describe, it, expect } from '@jest/globals';
import {
  assertNonEmptyDiffScope,
  looksLikeUnifiedDiff,
  normalizeOptionalDiffInput,
  normalizeRequiredDiffInput,
  parseRequiredDiffInput,
} from '../../src/mcp/tooling/diffInput.js';

describe('tooling/diffInput', () => {
  it('normalizes optional diff input and trims whitespace', () => {
    expect(normalizeOptionalDiffInput(undefined)).toBeUndefined();
    expect(normalizeOptionalDiffInput(123)).toBeUndefined();
    expect(normalizeOptionalDiffInput('   \n\t  ')).toBeUndefined();
    expect(normalizeOptionalDiffInput('\n diff --git a/a.ts b/a.ts \n')).toBe('diff --git a/a.ts b/a.ts');
  });

  it('throws configured error for missing required diff input', () => {
    expect(() => normalizeRequiredDiffInput('   ', 'diff required')).toThrow('diff required');
    expect(() => normalizeRequiredDiffInput(null, 'diff required')).toThrow('diff required');
  });

  it('detects unified diff shape for git-style and patch-style payloads', () => {
    const gitStyle = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;
    const patchStyle = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;

    expect(looksLikeUnifiedDiff(gitStyle)).toBe(true);
    expect(looksLikeUnifiedDiff(patchStyle)).toBe(true);
    expect(looksLikeUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n')).toBe(false);
    expect(looksLikeUnifiedDiff('plain text, not a diff')).toBe(false);
  });

  it('validates required diff shape only when unified-diff guard is requested', () => {
    expect(parseRequiredDiffInput('plain text', 'missing')).toBe('plain text');
    expect(() => parseRequiredDiffInput('plain text', 'missing', 'not unified')).toThrow('not unified');
  });

  it('guards against no-op diff scopes unless changed_files is provided', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;
    expect(() => assertNonEmptyDiffScope(diff, undefined, 'no scope')).not.toThrow();
    const patchStyle = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+b
`;
    expect(() => assertNonEmptyDiffScope(patchStyle, undefined, 'no scope')).not.toThrow();
    expect(() => assertNonEmptyDiffScope('plain text, not a diff', undefined, 'no scope')).toThrow('no scope');
    expect(() => assertNonEmptyDiffScope('plain text, not a diff', ['src/a.ts'], 'no scope')).not.toThrow();
  });
});
