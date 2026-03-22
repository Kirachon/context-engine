# Plan: Repo-Aware Startup and Auto-Indexing

**Generated**: 2026-03-22

## Execution Summary

Status: complete

Completed tasks:
- T1: Workspace resolution helper
- T2: Startup auto-index decisioning
- T3: One-time launcher and beginner docs
- T4: Startup and launcher smokes
- T5: Final compatibility check

Files implemented:
- `src/index.ts`
- `src/workspace/resolveWorkspace.ts`
- `src/mcp/serviceClient.ts`
- `src/mcp/tooling/indexFreshness.ts`
- `src/mcp/tools/index.ts`
- `README.md`
- `docs/MCP_CLIENT_SETUP.md`
- `docs/WINDOWS_DEPLOYMENT_GUIDE.md`
- `tests/workspace/resolveWorkspace.test.ts`
- `tests/mcp/indexFreshness.test.ts`
- `tests/serviceClient.test.ts`
- `tests/launcher.test.ts`

## Summary
Make Context Engine feel repo-aware without per-repo `config.toml` edits by adding workspace auto-detection, non-blocking startup indexing, and beginner-friendly one-time launcher guidance. The server should still accept explicit `--workspace`, but when users launch it from a repo it should resolve the right workspace automatically, start quickly, and background-index if the workspace is missing or stale.

## Key Changes
- Add a dedicated workspace-resolution helper with this precedence:
  1. explicit `--workspace`
  2. current working directory
  3. nearest parent git root when launched from a subdirectory
  4. if no git root is found, keep cwd and log a clear warning
- Add a startup index decision helper that reuses existing status/freshness logic:
  - auto-index on startup only for `unindexed` or `stale`
  - do not auto-index for `healthy`
  - do not start a duplicate job if indexing is already running
  - keep startup non-blocking even when indexing is triggered
- Keep one-time client registration, not per-repo setup:
  - remove the expectation that users edit `config.toml` for every repo
  - document a stable one-time launcher path plus repo-aware reuse afterward
- Add an opt-out for startup auto-index so large repos and slow machines can disable it without breaking manual indexing.

## Acceptance Criteria
- `--workspace` always wins.
- If `--workspace` is absent, cwd is used first, then git-root fallback if needed.
- If no git root exists, the server stays on cwd and warns clearly instead of guessing.
- The server starts without requiring per-repo `config.toml` edits.
- Startup auto-index is fire-and-forget and does not block server readiness.
- `unindexed` and `stale` trigger background indexing on startup.
- `healthy` does not trigger startup indexing.
- `indexing` does not create a second concurrent job.
- Background indexing failure does not stop the server.
- Manual `index_workspace` / `reindex_workspace` remains the escape hatch.
- Existing explicit `--workspace`, `manage-server.bat`, and `codex mcp add` flows continue to work.

## Tasks

### T1: Workspace resolution helper
- **depends_on**: []
- **location**: `src/index.ts`, `bin/context-engine-mcp.js`
- **description**: Extract workspace detection into a reusable helper with the precedence above and a clear cwd fallback when no git root is found.
- **validation**: Unit tests cover explicit `--workspace`, cwd launch, nested subdirectory git-root fallback, and non-git fallback behavior.

### T2: Startup auto-index decisioning
- **depends_on**: [T1]
- **location**: `src/index.ts`, `src/mcp/serviceClient.ts`, `src/mcp/tooling/indexFreshness.ts`
- **description**: Add a startup hook that checks existing index status/freshness and starts background indexing only for `unindexed` or `stale`, without blocking server startup or duplicating in-flight work.
- **validation**: Startup tests prove `healthy` skips, `unindexed` and `stale` trigger background indexing, `indexing` skips duplicate work, and the server remains usable while indexing runs.

### T3: One-time launcher and beginner docs
- **depends_on**: [T1, T2]
- **location**: `README.md`, `docs/MCP_CLIENT_SETUP.md`, `docs/WINDOWS_DEPLOYMENT_GUIDE.md`, `manage-server.bat`
- **description**: Reframe setup as one-time MCP registration plus repo-aware reuse, and document first-run behavior, workspace selection, auto-index behavior, and the `--workspace` override.
- **validation**: Docs show a beginner path and an operator path that match the runtime behavior and do not instruct per-repo `config.toml` edits.

### T4: Startup and launcher smokes
- **depends_on**: [T1, T2, T3]
- **location**: `tests/index.test.ts`, `tests/mcp/indexFreshness.test.ts`, `tests/launcher.test.ts`
- **description**: Add coverage for repo-root launch, nested-subfolder launch, explicit override, first-run missing index, stale index, healthy index, indexing-in-progress, and one-time launcher behavior.
- **validation**: Tests prove startup is non-blocking, workspace resolution is deterministic, and the one-time launcher path works without per-repo config edits.

### T5: Final compatibility check
- **depends_on**: [T1, T2, T3, T4]
- **location**: `README.md`, `docs/MCP_CLIENT_SETUP.md`, `src/index.ts`, `src/mcp/serviceClient.ts`
- **description**: Re-run affected test slices and verify no regressions in explicit `--workspace`, manual indexing tools, or watcher behavior.
- **validation**: Targeted tests pass, docs match runtime behavior, and no existing explicit-workspace flows regress.

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T1 | Immediately |
| 2 | T2 | T1 complete |
| 3 | T3 | T1 and T2 complete |
| 4 | T4 | T1, T2, and T3 complete |
| 5 | T5 | T4 complete |

## Testing Strategy
- Unit test workspace precedence and fallback behavior.
- Smoke test startup in:
  - repo root
  - nested subfolder
  - explicit `--workspace`
- Smoke test index states:
  - `missing`
  - `stale`
  - `healthy`
  - `indexing`
  - `error`
- Verify the server starts before background indexing completes.
- Verify docs examples match the real launcher commands and one-time registration flow.

## Assumptions
- One-time MCP client registration is still required somewhere on the machine/client, but per-repo `config.toml` edits are not.
- If no git root is found, the server keeps the current directory and logs a clear warning rather than failing hard.
- Auto-index-on-startup is non-blocking and uses the existing background indexing path.
- A startup auto-index opt-out flag or env knob will be available for large repos and slow machines.
- Explicit `--workspace` remains the override for unusual layouts, monorepos, or incorrect auto-detection.
- No changes are planned for retrieval ranking, prompt logic, or AI provider behavior.
