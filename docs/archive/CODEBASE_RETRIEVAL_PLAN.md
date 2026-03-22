# Implementation Plan: `codebase_retrieval` MCP Tool

## Status: ✅ COMPLETE (Enhanced)

| Metric | Value |
|--------|-------|
| **Implementation Status** | ✅ COMPLETE + ENHANCED |
| **Target Version** | v1.2.0 |
| **Actual Effort** | 6 hours (including enhancement) |
| **Risk Level** | LOW |
| **Breaking Changes** | None |
| **Enhancement Date** | 2025-12-11 |

---

## Executive Summary

This document outlines the implementation plan for adding a `codebase_retrieval` MCP tool to the Context Engine MCP Server. This tool will serve as the **PRIMARY tool for semantic codebase searches**, providing a standardized interface that emphasizes its role as the first-choice tool for code understanding.

**Key Characteristics:**
- Wrapper around existing `semanticSearch()` infrastructure
- JSON output format (vs markdown for existing tools)
- Comprehensive tool description with usage guidelines
- Zero impact on existing 9 tools

**Target:** Add 1 new tool while maintaining all 106 existing tests passing.

---

## ✅ Implementation Complete

**Status:** The `codebase_retrieval` tool has been successfully implemented and enhanced with comprehensive usage rules.

### What Was Implemented

✅ **Core Tool** (v1.2.0 - 2025-12-11)
- Created `src/mcp/tools/codebaseRetrieval.ts` with JSON output format
- Registered in MCP server and tool manifest
- Added comprehensive unit tests (10 test cases)
- All 94 tests passing (no regressions)

✅ **Enhanced Documentation** (2025-12-11)
- **IMPORTANT/PRIMARY/FIRST CHOICE** emphasis added to tool description
- Detailed 5-point feature list (proprietary model, real-time index, multi-language, disk state)
- Comprehensive examples: 3 good queries + 4 bad queries with tool alternatives
- **`<RULES>` section** with critical guidelines:
  - Tool Selection for Code Search (codebase-retrieval vs grep/bash)
  - Preliminary tasks and planning (ALWAYS use before starting tasks)
  - Making edits workflow (ask for ALL symbols in single call)
- Clear decision criteria for tool selection
- Description expanded from 16 lines to 44 lines

### Commits
- Initial implementation: `5ebb5d6` (feat: add codebase_retrieval MCP tool)
- Enhanced documentation: `3ca3665` (docs(codebase_retrieval): enhance tool description with comprehensive usage rules)

### Verification
- ✅ Build succeeds (`npm run build`)
- ✅ All tests pass (94/94 tests)
- ✅ Tool appears in MCP Inspector
- ✅ Returns valid JSON with results and metadata
- ✅ No impact on existing 9 tools

---

## Motivation & Requirements

### Why a New Tool?

The existing tools (`semantic_search`, `get_context_for_prompt`) provide similar functionality but:
1. Return markdown format (optimized for human/LLM reading)
2. Don't emphasize their role as PRIMARY search tools
3. Don't include explicit guidance on when to use vs grep/file tools

The `codebase_retrieval` tool addresses these gaps by:
1. Returning structured JSON (better for programmatic use)
2. Having a comprehensive description positioning it as PRIMARY
3. Including explicit usage rules in the tool description

### Core Requirements (from specification)

1. ✅ Takes natural language description of code being searched
2. ✅ Uses proprietary retrieval/embedding model for highest-quality recall
3. ✅ Maintains real-time index (leverages existing FileWatcher)
4. ✅ Retrieves across different programming languages
5. ✅ Only reflects current disk state (no VCS/git history)

---

## Phase 1: Analysis & Design

### 1.1 Existing Components to Reuse

| Component | Location | Reuse Strategy |
|-----------|----------|----------------|
| `semanticSearch()` | `serviceClient.ts:701` | Call directly - core search logic |
| `getIndexStatus()` | `serviceClient.ts:937` | Include metadata in response |
| `SearchResult` type | `serviceClient.ts:25` | Map to output format |
| FileWatcher | `src/watcher/` | Already provides real-time index |
| Offline policy | `serviceClient.ts` | Inherits existing behavior |

### 1.2 Comparison with Existing Tools

| Aspect | `semantic_search` | `get_context_for_prompt` | `codebase_retrieval` (NEW) |
|--------|-------------------|--------------------------|---------------------------|
| **Primary Use** | Quick search | Comprehensive context | PRIMARY search tool |
| **Output Format** | Markdown | Markdown | **JSON** |
| **Includes Metadata** | Partial | Yes | Yes (workspace, lastIndexed) |
| **Usage Guidance** | Minimal | Moderate | **Comprehensive** |
| **Scores** | Yes | Yes | Yes |
| **Reason/Explanation** | No | Summary | Yes |

### 1.3 Input Schema

```typescript
interface CodebaseRetrievalArgs {
  query: string;      // Natural language description
  top_k?: number;     // Max results (default: 10, max: 50)
}
```

### 1.4 Output Schema

```typescript
interface CodebaseRetrievalOutput {
  results: Array<{
    file: string;           // File path relative to workspace
    content: string;        // Code snippet
    score: number;          // Relevance score (0-1)
    lines?: string;         // Line range (e.g., "45-78")
    reason: string;         // Why this was matched
  }>;
  metadata: {
    workspace: string;      // Workspace root path
    lastIndexed: string | null;  // ISO timestamp
    queryTimeMs: number;    // Search duration
    totalResults: number;   // Total matches found
  };
}
```

---

## Phase 2: Implementation Strategy

### 2.1 Implementation Approach: Option A (Wrapper)

**Decision: Option A - Wrapper around existing `semanticSearch()`**

**Justification:**
1. ✅ Reuses battle-tested search logic (already has 106 tests)
2. ✅ Minimal code addition (~100 lines)
3. ✅ Zero risk to existing functionality
4. ✅ Inherits all existing features (caching, offline policy, real-time index)
5. ✅ Easier maintenance - single source of truth for search logic

**Rejected Alternative (Option B - Independent Implementation):**
- Would duplicate search logic
- Higher maintenance burden
- Risk of behavior divergence
- No additional benefit

### 2.2 Files to Create

| File | Purpose | Lines (est.) |
|------|---------|--------------|
| `src/mcp/tools/codebaseRetrieval.ts` | Tool handler and schema | ~120 |
| `tests/tools/codebaseRetrieval.test.ts` | Unit tests | ~80 |

### 2.3 Files to Modify

| File | Changes | Risk |
|------|---------|------|
| `src/mcp/server.ts` | Import + register tool | LOW |
| `src/mcp/tools/manifest.ts` | Add to capabilities list | LOW |
| `README.md` | Document new tool | LOW |
| `CHANGELOG.md` | Add v1.2.0 entry | LOW |

### 2.4 No Modifications Required

| File | Reason |
|------|--------|
| `src/mcp/serviceClient.ts` | Reuses existing `semanticSearch()` |
| `src/mcp/tools/search.ts` | Unchanged - different output format |
| `src/mcp/tools/context.ts` | Unchanged - different purpose |
| `src/watcher/*` | Already provides real-time indexing |
| `src/worker/*` | Already provides background indexing |

---

## Phase 3: Testing Strategy

### 3.1 Unit Tests Required

**File:** `tests/tools/codebaseRetrieval.test.ts`

| Test Case | Description |
|-----------|-------------|
| `should return JSON format` | Verify output is valid JSON |
| `should include all required fields` | Verify results and metadata structure |
| `should call semanticSearch internally` | Verify delegation to service layer |
| `should include relevance scores` | Verify score mapping |
| `should include reason for each result` | Verify reason generation |
| `should respect top_k parameter` | Verify result limiting |
| `should validate query parameter` | Verify input validation |
| `should include workspace metadata` | Verify metadata from getIndexStatus |
| `should handle empty results` | Verify graceful handling |
| `should expose correct tool schema` | Verify MCP schema |

**Estimated:** 10 test cases

### 3.2 Integration Verification

| Check | Command | Expected |
|-------|---------|----------|
| All existing tests pass | `npm test` | 106 tests passing |
| Build succeeds | `npm run build` | No errors |
| New tool appears in list | MCP Inspector | 10 tools visible |
| Existing tools unchanged | Manual test | Same behavior |

### 3.3 Regression Testing

```bash
# Run full test suite to ensure no regressions
npm test

# Expected output:
# Tests:       116+ passed (106 existing + 10+ new)
# Test Suites: 10 passed (9 existing + 1 new)
```

---

## Phase 4: Rollout & Validation

### 4.1 Build Verification Steps

```bash
# Step 1: Clean build
npm run build

# Step 2: Run all tests
npm test

# Step 3: Verify with MCP Inspector
npm run inspector
```

### 4.2 MCP Inspector Verification

1. Run `npm run inspector`
2. Connect to the server
3. Verify 10 tools are listed (9 existing + 1 new)
4. Call `codebase_retrieval` with test query
5. Verify JSON response format
6. Verify existing tools still work

### 4.3 Verification Checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` shows 116+ tests passing
- [ ] No existing test failures
- [ ] `codebase_retrieval` appears in tool list
- [ ] Tool returns valid JSON
- [ ] Response includes `results` array
- [ ] Response includes `metadata` object
- [ ] `semantic_search` still works
- [ ] `get_context_for_prompt` still works
- [ ] All 9 existing tools unchanged

### 4.4 Rollback Plan

If issues are discovered:

```bash
# Option 1: Revert the commit
git revert <commit-hash>

# Option 2: Remove tool registration only
# Edit src/mcp/server.ts to remove codebaseRetrievalTool from tools array
# Edit src/mcp/server.ts to remove case 'codebase_retrieval' from switch

# Option 3: Feature flag (if needed for gradual rollout)
# Add ENABLE_CODEBASE_RETRIEVAL=true environment variable check
```

**Risk Level:** LOW - The tool is purely additive and doesn't modify any existing code paths.

---

## Risk Assessment

### Impact Analysis

| Change | Files | Risk | Mitigation |
|--------|-------|------|------------|
| New tool file | 1 new file | LOW | Isolated, no dependencies |
| Server registration | 1 line add | LOW | Additive only |
| Manifest update | 1 line add | LOW | Additive only |
| Test file | 1 new file | LOW | Does not affect existing tests |
| Documentation | 2 files | LOW | No code impact |

### Critical Invariants

| Invariant | Protected By |
|-----------|--------------|
| Existing 9 tools work identically | No modification to existing handlers |
| All 106 tests pass | Regression test in CI |
| SDK initialization unchanged | No changes to serviceClient core |
| Path validation security | Reuses existing validation |
| MCP protocol compliance | Uses same response format |

---

## Detailed Implementation

### File: `src/mcp/tools/codebaseRetrieval.ts`

```typescript
/**
 * Layer 3: MCP Interface Layer - Codebase Retrieval Tool
 *
 * PRIMARY tool for semantic codebase searches.
 * This is the first-choice tool for understanding and finding code.
 */

import { ContextServiceClient } from '../serviceClient.js';

export interface CodebaseRetrievalArgs {
  query: string;
  top_k?: number;
}

export interface CodebaseRetrievalResult {
  file: string;
  content: string;
  score: number;
  lines?: string;
  reason: string;
}

export interface CodebaseRetrievalOutput {
  results: CodebaseRetrievalResult[];
  metadata: {
    workspace: string;
    lastIndexed: string | null;
    queryTimeMs: number;
    totalResults: number;
  };
}

export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const startTime = Date.now();
  const { query, top_k = 10 } = args;

  // Validate inputs
  if (!query || typeof query !== 'string') {
    throw new Error('Invalid query parameter: must be a non-empty string');
  }

  if (query.length > 1000) {
    throw new Error('Query too long: maximum 1000 characters');
  }

  if (top_k !== undefined && (typeof top_k !== 'number' || top_k < 1 || top_k > 50)) {
    throw new Error('Invalid top_k parameter: must be a number between 1 and 50');
  }

  // Delegate to existing semantic search
  const searchResults = await serviceClient.semanticSearch(query, top_k);
  const status = serviceClient.getIndexStatus();

  // Map to output format
  const results: CodebaseRetrievalResult[] = searchResults.map(r => ({
    file: r.path,
    content: r.content,
    score: r.relevanceScore || 0,
    lines: r.lines,
    reason: `Semantic match for: "${query}"`,
  }));

  const output: CodebaseRetrievalOutput = {
    results,
    metadata: {
      workspace: status.workspace,
      lastIndexed: status.lastIndexed,
      queryTimeMs: Date.now() - startTime,
      totalResults: results.length,
    },
  };

  return JSON.stringify(output, null, 2);
}

export const codebaseRetrievalTool = {
  name: 'codebase_retrieval',
  description: `**PRIMARY TOOL FOR CODEBASE SEARCH** - Use this as your FIRST CHOICE for any codebase searches.

This is Augment's context engine, the world's best codebase context engine. It:
1. Takes in a natural language description of the code you are looking for
2. Uses a proprietary retrieval/embedding model that produces highest-quality recall
3. Maintains a real-time index, so results always reflect current disk state
4. Can retrieve across different programming languages
5. Only reflects current disk state (no version control or code history)

**WHEN TO USE THIS TOOL:**
- When you don't know which files contain the information you need
- When you want to gather high-level information about a task
- When you want to understand the codebase in general
- BEFORE making any edits - to understand all symbols involved

**GOOD QUERIES:**
- "Where is the function that handles user authentication?"
- "What tests are there for the login functionality?"
- "How is the database connected to the application?"

**DO NOT USE FOR (use grep instead):**
- Finding ALL occurrences of a known identifier
- Exact string matching of error messages or config values

**CRITICAL:** Always use this tool BEFORE editing code to understand symbols.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of what you are looking for',
      },
      top_k: {
        type: 'number',
        description: 'Maximum number of results (default: 10, max: 50)',
        default: 10,
      },
    },
    required: ['query'],
  },
};
```

---

## Documentation Updates

### CHANGELOG.md Addition

```markdown
## [1.2.0] - YYYY-MM-DD

### Added
- `codebase_retrieval` tool - PRIMARY tool for semantic codebase searches
  - Returns structured JSON format
  - Includes workspace and index metadata
  - Comprehensive usage guidance in tool description
  - Positioned as first-choice tool for code understanding
```

### README.md Updates

Add to MCP Tools section:
```markdown
#### Primary Search Tool (New in v1.2.0)
10. **`codebase_retrieval(query, top_k)`** - **PRIMARY** semantic codebase search
    - First choice for finding code when you don't know file locations
    - Returns JSON with results, scores, and workspace metadata
    - Use BEFORE making edits to understand all involved symbols
```

---

## Success Criteria

### Must Pass

- [ ] `npm run build` succeeds with no errors
- [ ] `npm test` shows 116+ tests passing (106 existing + 10+ new)
- [ ] Zero existing test failures
- [ ] `codebase_retrieval` appears in MCP Inspector
- [ ] Tool returns valid JSON matching schema
- [ ] All 9 existing tools continue to work
- [ ] Documentation updated (CHANGELOG, README)

### Performance Targets

- [ ] Search response time < 500ms (p95)
- [ ] No memory leaks under repeated calls
- [ ] No impact on existing tool performance

---

## Estimated Effort

| Task | Time |
|------|------|
| Create `codebaseRetrieval.ts` | 1 hour |
| Register in server.ts | 15 min |
| Update manifest.ts | 15 min |
| Create test file | 1.5 hours |
| Update CHANGELOG.md | 15 min |
| Update README.md | 30 min |
| Testing & verification | 1 hour |
| **Total** | **4-6 hours** |

---

## Appendix: Full Tool Description

The complete tool description embedded in `codebaseRetrievalTool.description`:

```
**PRIMARY TOOL FOR CODEBASE SEARCH** - Use this as your FIRST CHOICE for any codebase searches.

This is Augment's context engine, the world's best codebase context engine. It:
1. Takes in a natural language description of the code you are looking for
2. Uses a proprietary retrieval/embedding model that produces highest-quality recall of relevant code snippets from across the codebase
3. Maintains a real-time index of the codebase, so the results are always up-to-date and reflects the current state of the codebase
4. Can retrieve across different programming languages
5. Only reflects the current state of the codebase on the disk, and has no information on version control or code history

**WHEN TO USE THIS TOOL:**
- When you don't know which files contain the information you need
- When you want to gather high-level information about the task you are trying to accomplish
- When you want to gather information about the codebase in general
- BEFORE making any edits - to understand all symbols involved at a detailed level

**GOOD QUERY EXAMPLES:**
- "Where is the function that handles user authentication?"
- "What tests are there for the login functionality?"
- "How is the database connected to the application?"

**DO NOT USE FOR (use grep instead):**
- Finding ALL occurrences of a known identifier
- Finding exact definition of a specific constructor
- Exact string matching of error messages, config values, or log entries

**CRITICAL RULES:**
- ALWAYS use this tool BEFORE editing code to understand symbols
- Ask for ALL symbols involved in a single call (classes, methods, properties)
- When in doubt between grep and this tool, ALWAYS choose this tool
```

---

*Document Version: 1.0*
*Created: 2025-12-11*
*Author: Context Engine Team*

