# Context Engine - API Reference

## MCP Tools Reference

This document provides API specifications for MCP tools exposed by Context Engine.

Note: treat `tool_manifest` (and the tools' `inputSchema` returned by MCP) as the source of truth if this document drifts.

## Table of Contents

1. [Context & Search Tools](#context--search-tools)
2. [Review Tools](#review-tools)
3. [Planning Tools](#planning-tools)
4. [Execution Tools](#execution-tools)
5. [Reactive Review Tools](#reactive-review-tools)
6. [Persistence Tools](#persistence-tools)
7. [Utility Tools](#utility-tools)

---

## Context & Search Tools

### 1. `semantic_search`

**Description**: Find code snippets by semantic meaning using embeddings.

**Input Schema**:
```typescript
{
  query: string;              // Natural language search query
  top_k?: number;             // Number of results (default: 10, max: 50)
  mode?: "fast" | "deep";     // fast (default) or deep (more recall, higher latency)
  bypass_cache?: boolean;     // Bypass caches for this call (default: false)
  timeout_ms?: number;        // Cap time spent in retrieval pipeline (ms)
}
```

**Output**: Markdown string formatted for human/agent consumption.

**Example**:
```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "authentication logic",
    "top_k": 10,
    "mode": "fast"
  }
}
```

---

### 2. `get_file`

**Description**: Retrieve complete file contents with metadata.

**Input Schema**:
```typescript
{
  path: string;               // File path relative to workspace
  include_metadata?: boolean; // Include git info (default: true)
}
```

**Output**:
```typescript
{
  path: string;               // File path
  content: string;            // Full file contents
  size: number;               // File size in bytes
  lines: number;              // Total line count
  metadata?: {
    last_modified: string;    // ISO timestamp
    git_status?: string;      // Git status (modified, staged, etc.)
  };
}
```

---

### 3. `get_context_for_prompt`

**Description**: Primary context enhancement tool - bundles relevant code for AI prompts.

**Input Schema**:
```typescript
{
  query: string;              // Context query
  max_files?: number;         // Max files to include (default: 5, max: 20)
  token_budget?: number;      // Token budget (default: 8000)
  include_related?: boolean;  // Include related/imported files (default: true)
  min_relevance?: number;     // Minimum relevance score (default: 0.3)
  bypass_cache?: boolean;     // Bypass caches for this call (default: false)
}
```

**Output**: Markdown string formatted for human/agent consumption.

---

### 4. `codebase_retrieval`

**Description**: Advanced semantic search with filtering and ranking.

**Input Schema**:
```typescript
{
  query: string;              // Search query
  options?: {
    top_k?: number;           // Results limit
    file_types?: string[];    // Filter by extension (.ts, .js, etc.)
    exclude_paths?: string[]; // Paths to exclude
    include_tests?: boolean;  // Include test files (default: false)
  };
}
```

**Output**: Similar to `semantic_search` with additional filtering metadata.

---

### 5. `git_commit_retrieval`

**Description**: Search commit history for relevant changes.

**Input Schema**:
```typescript
{
  query: string;              // Search query
  max_commits?: number;       // Commit limit (default: 10)
  since?: string;             // ISO date or relative (e.g., "1 week ago")
  author?: string;            // Filter by author
}
```

**Output**:
```typescript
{
  commits: Array<{
    sha: string;              // Commit hash
    message: string;          // Commit message
    author: string;           // Author name
    date: string;             // ISO timestamp
    files_changed: string[];  // Modified files
    relevance_score: number;  // Match score (0-1)
  }>;
  total_found: number;
}
```

---

### 6. `get_workspace_info`

**Description**: Get workspace metadata and health status.

**Input Schema**: None

**Output**:
```typescript
{
  workspace_path: string;     // Absolute workspace path
  git_root?: string;          // Git repository root
  branch?: string;            // Current git branch
  total_files: number;        // Indexed file count
  index_status: {
    healthy: boolean;
    last_indexed: string;     // ISO timestamp
    index_size: number;       // Index size in bytes
  };
  cache_stats: {
    hit_rate: number;         // Cache hit rate (0-1)
    size: number;             // Cache entry count
    commit_keyed: boolean;    // Commit-based invalidation enabled
  };
}
```

---

## Review Tools

### 7. `review_diff`

**Description**: Enterprise-grade diff-first review with deterministic preflight and structured JSON output. Optional static analysis (`tsc`/`semgrep`), optional LLM passes, optional SARIF/Markdown outputs, and CI gating via `should_fail`.

**Input Schema**:
```typescript
{
  diff: string;                    // Unified diff content (required)
  changed_files?: string[];        // Optional list of changed file paths
  base_sha?: string;              // Optional base commit SHA
  head_sha?: string;              // Optional head commit SHA
  options?: {
    confidence_threshold?: number; // Default: 0.55
    max_findings?: number;         // Default: 20
    categories?: string[];
    invariants_path?: string;      // Default: ".review-invariants.yml" (when used by CI)

    enable_static_analysis?: boolean; // Default: false
    static_analyzers?: ('tsc' | 'semgrep')[]; // Default: ['tsc']
    static_analysis_timeout_ms?: number; // Default: 60000
    static_analysis_max_findings_per_analyzer?: number; // Default: 20
    semgrep_args?: string[];

    enable_llm?: boolean;          // Default: false
    llm_force?: boolean;           // Default: false
    two_pass?: boolean;            // Default: true
    risk_threshold?: number;       // Default: 3
    token_budget?: number;         // Default: 8000
    max_context_files?: number;    // Default: 5
    custom_instructions?: string;

    fail_on_severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'; // Default: CRITICAL
    fail_on_invariant_ids?: string[];
    allowlist_finding_ids?: string[];

    include_sarif?: boolean;       // Default: false
    include_markdown?: boolean;    // Default: false
  };
}
```

**Output**: `EnterpriseReviewResult` (see `src/reviewer/types.ts`)

---

### 8. `review_changes`

**Description**: LLM-powered review of a unified diff returning a `ReviewResult` (Codex-style). This is a different schema/pipeline than `review_diff`.

**Input Schema**:
```typescript
{
  diff: string;                  // Required
  file_contexts?: string;        // Optional JSON string: { [path]: content }
  base_ref?: string;
  confidence_threshold?: number; // Default: 0.7
  max_findings?: number;         // Default: 20
  categories?: string;           // Comma-separated categories
  changed_lines_only?: boolean;  // Default: true
  custom_instructions?: string;
  exclude_patterns?: string;     // Comma-separated globs
}
```

**Output**: `ReviewResult` (see `src/mcp/types/codeReview.ts`)

---

### 9. `review_git_diff`

**Description**: Retrieve a git diff for a target (staged/unstaged/head/branch/commit) and then run `review_changes`.

**Input Schema**:
```typescript
{
  target?: string;              // Default: 'staged'
  base?: string;                // For branch comparisons
  include_patterns?: string[];  // Optional file globs
  options?: object;             // Same shape as ReviewOptions (see `ReviewResult` types)
}
```

**Output**:
```typescript
{
  git_info: object;
  review: ReviewResult;
}
```

---

### 10. `review_auto`

**Description**: Smart wrapper that automatically chooses the best review tool:\n- If `diff` is provided, runs `review_diff`.\n- Otherwise runs `review_git_diff` (pulls changes from git).\n\nReturns a stable wrapper payload: `{ selected_tool, rationale, output }`.

**Input Schema**:
```typescript
{
  tool?: 'auto' | 'review_diff' | 'review_git_diff'; // Default: 'auto'

  // For review_diff
  diff?: string;
  changed_files?: string[];
  review_diff_options?: object; // Same shape as review_diff options

  // For review_git_diff
  target?: string;              // Default: 'staged'
  base?: string;
  include_patterns?: string[];
  review_git_diff_options?: object; // Same shape as ReviewOptions
}
```

**Output**:
```typescript
{
  selected_tool: 'review_diff' | 'review_git_diff';
  rationale: string;
  output: object; // EnterpriseReviewResult OR { git_info, review }
}
```

---

### 11. `run_static_analysis`

**Description**: Run local static analyzers (TypeScript and optional Semgrep) independently.

**Input Schema**:
```typescript
{
  changed_files?: string[];
  options?: {
    analyzers?: ('tsc' | 'semgrep')[];  // Default: ['tsc']
    timeout_ms?: number;               // Default: 60000
    max_findings_per_analyzer?: number;// Default: 20
    semgrep_args?: string[];
  };
}
```

**Output**:
```typescript
{
  success: boolean;
  analyzers: string[];
  warnings: string[];
  results: unknown[];
  findings: unknown[];
}
```

---

### 12. `check_invariants`

**Description**: Run deterministic YAML invariants (`.review-invariants.yml`) against a unified diff.

**Input Schema**:
```typescript
{
  diff: string;                // Required
  changed_files?: string[];
  invariants_path?: string;    // Default: ".review-invariants.yml"
}
```

**Output**:
```typescript
{
  success: boolean;
  invariants_path: string;
  checked_invariants: number;
  warnings: string[];
  findings: unknown[];
  error?: string;
}
```

## Planning Tools

### `create_plan`

**Description**: Generate a new implementation plan. Returns a **Markdown report** and includes the full plan JSON in a `<details>` block.

**Input Schema**:
```typescript
{
  task: string;                 // Required
  max_context_files?: number;   // Default: 10
  context_token_budget?: number;// Default: 12000
  generate_diagrams?: boolean;  // Default: true
  mvp_only?: boolean;           // Default: false
}
```

---

### `refine_plan`

**Description**: Refine an existing plan (add detail, incorporate feedback, answer clarifying questions). Returns Markdown + full JSON plan.

**Input Schema**:
```typescript
{
  current_plan: string;         // Required JSON string (EnhancedPlanOutput)
  feedback?: string;
  clarifications?: string;      // Optional JSON object as string
  focus_steps?: number[];
}
```

---

### `visualize_plan`

**Description**: Generate Mermaid diagrams from a plan (dependencies, architecture, gantt).

**Input Schema**:
```typescript
{
  plan: string;                 // Required JSON string (EnhancedPlanOutput)
  diagram_type?: 'dependencies' | 'architecture' | 'gantt'; // Default: 'dependencies'
}
```

**Output**:
```typescript
{
  diagram_type: string;
  mermaid: string;
  plan_id: string;
  plan_version: number;
}
```

---

## Execution Tools

### `execute_plan`

**Description**: Execute steps from a plan. By default this is preview-only; set `apply_changes=true` to write to disk.

**Input Schema**:
```typescript
{
  plan: string;                 // Required JSON string (EnhancedPlanOutput)
  mode?: 'single_step' | 'all_ready' | 'full_plan'; // Default: 'single_step'
  step_number?: number;         // Required when mode='single_step'
  apply_changes?: boolean;      // Default: false
  max_steps?: number;           // Default: 5
  stop_on_failure?: boolean;    // Default: true
  additional_context?: string;
}
```

**Output**: Markdown report + a `<details>` block containing full JSON execution results.

---

## Reactive Review Tools

### `reactive_review_pr`

**Description**: Start a reactive PR review session (and begin execution). Returns a `session_id`.

**Input Schema**:
```typescript
{
  commit_hash: string;          // Required
  base_ref: string;             // Required
  changed_files: string;        // Required (comma-separated or JSON array string)
  title?: string;
  author?: string;
  additions?: number;
  deletions?: number;
  parallel?: boolean;
  max_workers?: number;
}
```

---

### `get_review_status`

**Description**: Get status/progress for a reactive review session.

**Input Schema**:
```typescript
{ session_id: string }
```

---

### `pause_review` / `resume_review`

**Input Schema**:
```typescript
{ session_id: string }
```

---

### `get_review_telemetry`

**Description**: Get detailed telemetry for a reactive review session.

**Input Schema**:
```typescript
{ session_id: string }
```

---

### `scrub_secrets`

**Input Schema**:
```typescript
{ content: string; show_start?: number; show_end?: number }
```

---

### `validate_content`

**Input Schema**:
```typescript
{
  content: string;
  content_type?: 'review_finding' | 'plan_output' | 'generated_code' | 'raw_text';
  file_path?: string;
  scrub_secrets?: boolean;
}
```

---

## Persistence Tools (Phase 2 plan management)

### `save_plan`

**Input Schema**:
```typescript
{
  plan: string;                 // Required JSON string (EnhancedPlanOutput)
  name?: string;
  tags?: string[];
  overwrite?: boolean;
}
```

---

### `load_plan`

**Input Schema**:
```typescript
{ plan_id?: string; name?: string }
```

---

### `list_plans`

**Input Schema**:
```typescript
{ status?: string; tags?: string[]; limit?: number }
```

---

### Other plan management tools

- `delete_plan`
- `request_approval`, `respond_approval`
- `start_step`, `complete_step`, `fail_step`
- `view_progress`, `view_history`
- `compare_plan_versions`, `rollback_plan`

## Error Handling

All tools return errors in this format:

```typescript
{
  error: {
    code: string;             // Error code (e.g., "INVALID_INPUT")
    message: string;          // Human-readable message
    details?: any;            // Additional context
  }
}
```

Common error codes:
- `INVALID_INPUT`: Invalid parameters
- `FILE_NOT_FOUND`: File doesn't exist
- `TIMEOUT`: Operation timed out
- `EXECUTION_FAILED`: Step execution failed
- `PLAN_NOT_FOUND`: Plan ID not found
- `SESSION_NOT_FOUND`: Session ID not found

---

## Rate Limits & Quotas

- **Semantic Search**: No hard limit, cached results
- **LLM Review**: Subject to LLM provider limits
- **Static Analysis**: Limited by system resources
- **Concurrent Sessions**: Limited by `max_concurrent_steps` config

---

**Version**: 1.9.0  
**Last Updated**: 2025-12-26
