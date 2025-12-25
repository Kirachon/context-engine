---
description: AI Code Review with Human-in-the-Loop Approval
---

# AI Code Review Workflow (HITL Standard)

This workflow follows industry best practices for AI-assisted code review with human oversight.

## When to Use
- Before creating releases
- After major feature implementations
- For security audits
- When requested by user: "review code", "code review", "check for issues"

## Workflow Steps

### 1. Run Code Review
```bash
# Review staged changes
mcp_context-engine_review_git_diff target="staged"

# Review against main branch
mcp_context-engine_review_git_diff target="main"

# Review last N commits
mcp_context-engine_review_git_diff target="HEAD~N"
```

### 2. Present Findings Report
Create a findings document with:
- Total issues found
- Priority breakdown (P0-P3)
- Each finding with:
  - File and line number
  - Issue description
  - Confidence score
  - Category (correctness, security, performance, maintainability)

**Format:**
```markdown
## Finding #N: [Title]
**File**: `path/to/file.ts:123`
**Priority**: P1 (High)
**Category**: Security
**Confidence**: 0.85

**Issue**: [Description of the problem]

**Proposed Fix**:
[Show the exact code change as a diff]
```

### 3. Request Approval (CRITICAL)

**DO NOT auto-fix any findings.** Instead, ask the user:

> "I found N issues in the code review:
>
> **P1 (Critical) - Should fix:**
> 1. [Finding title] - [file:line]
> 2. [Finding title] - [file:line]
>
> **P2 (Medium) - Consider fixing:**
> 3. [Finding title] - [file:line]
>
> Which findings should I fix? Options:
> - 'all' - Fix everything
> - 'P1 only' - Fix critical issues only
> - '1,3,5' - Fix specific numbers
> - 'none' - I'll handle manually
> - 'show 2' - Show proposed fix for #2"

### 4. Show Proposed Fixes (When Requested)

For each fix the user wants to review, show:

```markdown
## Proposed Fix for Finding #N

**Current Code:**
```typescript
// Lines 120-125 of src/file.ts
const value = data.property; // No null check
```

**Proposed Change:**
```typescript
// Lines 120-125 of src/file.ts
const value = data?.property;
if (!value) {
  console.error('Warning: property not found');
  return [];
}
```

**Approve this fix? (Y/N/modify)**
```

### 5. Apply Approved Fixes Only

After receiving approval:
1. Apply only the fixes the user approved
2. Run build to verify no errors
3. Run tests to verify no regressions
4. Commit with descriptive message listing fixed findings

### 6. Report Results

After applying fixes:
```markdown
## Fix Summary

| # | Finding | Status |
|---|---------|--------|
| 1 | HTTP loop | ✅ Fixed |
| 2 | Error handling | ✅ Fixed |
| 3 | Null check | ⏭️ Skipped (user choice) |

**Build**: ✅ Passed
**Tests**: ✅ 48/48 passing
**Commit**: abc1234
```

## Auto-Fix Rules

### ✅ Safe to Auto-Fix (No approval needed)
- Formatting/linting only
- Import sorting
- Trailing whitespace
- Simple typo corrections in comments

### ⚠️ Requires Approval (Always ask first)
- Any logic changes
- Bug fixes
- Security fixes
- API changes
- Configuration changes
- Error handling changes
- Performance optimizations

### 🔴 Never Auto-Fix
- Architectural changes
- Breaking API changes
- Database schema changes
- Authentication/authorization code
- Payment/financial code

## Example Interaction

**User**: "Review my code changes"

**Agent**: 
> I ran code review on your changes (HEAD~5) and found **5 issues**:
>
> | # | Priority | Issue | File |
> |---|----------|-------|------|
> | 1 | P1 | Infinite loop in HTTP mode | index.ts:152 |
> | 2 | P1 | Missing error handling | index.ts:144 |
> | 3 | P2 | Null check missing | AIExecutor.ts:117 |
> | 4 | P2 | Hardcoded version | index.ts:26 |
> | 5 | P2 | Potential race condition | tracking.ts:1075 |
>
> Which should I fix?
> - Type 'all', 'P1 only', specific numbers (e.g., '1,2,4'), or 'none'
> - Type 'show N' to see the proposed fix for any finding

**User**: "show 1"

**Agent**: [Shows proposed fix for finding #1]

**User**: "fix 1,2"

**Agent**: [Fixes only #1 and #2, commits, reports results]

## Notes

- This workflow is based on industry standards for Human-in-the-Loop (HITL) AI assistance
- Always prioritize user control over automation speed
- Security-sensitive changes ALWAYS require explicit approval
- When in doubt, ask rather than assume
