---
description: Mandatory Testing Workflow for Enterprise Code Review Implementation
---

# Implementation Testing Workflow (MANDATORY)

This workflow MUST be followed by any agent implementing features for the Context Engine.

## ⚠️ Critical Rule

**NEVER proceed to the next task with failing tests.**

## Test Commands

| Command | When to Use | Expected Time |
|---------|-------------|---------------|
| `npm run build` | After ANY code change | ~5 seconds |
| `npm test` | After EVERY feature | ~30 seconds |
| `npm run test:quick` | Quick iteration check | ~10 seconds |
| `npm run test:reviewer` | Enterprise review features | ~15 seconds |
| `npm run validate` | Before completing a phase | ~45 seconds |

## Implementation Loop

```
┌─────────────────────────────────────────────────────────┐
│  1. Write/Modify Code                                   │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  2. Run: npm run build                                  │
│     → Fix any TypeScript errors                         │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  3. Run: npm test                                       │
│     → All 213+ tests must pass                          │
└─────────────────────┬───────────────────────────────────┘
                      │
            ┌─────────┴─────────┐
            │                   │
            ▼                   ▼
      ┌──────────┐        ┌──────────┐
      │ PASS ✅  │        │ FAIL ❌  │
      └────┬─────┘        └────┬─────┘
           │                   │
           ▼                   ▼
    ┌────────────┐      ┌────────────────────┐
    │ Next Task  │      │ FIX BEFORE         │
    └────────────┘      │ PROCEEDING         │
                        │ (go back to step 1)│
                        └────────────────────┘
```

## Phase-Specific Test Targets

### Phase 1: Foundation
- New tests: `tests/reviewer/diff/*.test.ts`
- New tests: `tests/tools/reviewDiff.test.ts`
- Target: 213 existing + ~20 new = 233 tests passing

### Phase 2: Enterprise Trust
- New tests: `tests/reviewer/checks/*.test.ts`
- New tests: `tests/reviewer/adapters/*.test.ts`
- Target: 233 + ~30 new = 263 tests passing

### Phase 3: LLM Integration
- New tests: `tests/reviewer/llm/*.test.ts`
- New tests: `tests/reviewer/context/*.test.ts`
- Target: 263 + ~25 new = 288 tests passing

### Phase 4: CI/GitHub
- New tests: `tests/integration/*.test.ts`
- New tests: `tests/reviewer/output/*.test.ts`
- Target: 288 + ~25 new = 313 tests passing

## Backward Compatibility Rules

1. **Never modify existing tool schemas** - Only add new tools
2. **Never remove existing exports** - Only add new exports
3. **Run `npm run test:compat`** before completing any phase
4. **Existing 38 MCP tools must work unchanged**

## Test Failure Recovery

```
If test fails:
├── Is it a NEW test you wrote?
│   └── YES → Fix your implementation
│       └── Run tests again
│
├── Is it an EXISTING test?
│   └── YES → You broke backward compatibility!
│       ├── Revert your change
│       ├── Understand what broke
│       └── Reimplement without breaking
│
└── Is it a flaky test?
    └── Run `npm test` again
        └── If still fails → treat as real failure
```

## Verification Before Phase Completion

Before marking ANY phase complete, run:

```bash
# Full validation
npm run validate

# This runs:
# 1. npm run build (must pass)
# 2. npm test (all tests must pass)
# 3. npm run verify (sanity check)
```

## Example Test File Structure

When implementing `src/reviewer/diff/parse.ts`, create test FIRST:

```typescript
// tests/reviewer/diff/parse.test.ts
import { parseDiff, extractHunks } from '../../../src/reviewer/diff/parse.js';

describe('Diff Parser', () => {
  test('parses simple unified diff', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+newline
 line2`;
    
    const result = parseDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].hunks).toHaveLength(1);
  });

  test('handles empty diff', () => {
    expect(() => parseDiff('')).not.toThrow();
  });
});
```

## DO NOT

- ❌ Skip running tests
- ❌ Proceed with failing tests
- ❌ Modify existing test expectations to make them pass
- ❌ Comment out failing tests
- ❌ Use `test.skip()` on existing tests

## DO

- ✅ Run tests after every code change
- ✅ Write tests before implementation (TDD)
- ✅ Fix failures immediately
- ✅ Check backward compatibility
- ✅ Ask for help if stuck on test failures

