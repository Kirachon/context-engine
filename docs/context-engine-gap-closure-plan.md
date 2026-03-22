# Plan: Close the Remaining Context Engine Gaps
**Generated**: 2026-03-22

## Summary
Fix the remaining correctness and UX gaps surfaced by the audit:
- preserve in-memory index error state across disk hydration without claiming new persisted error storage
- harden explicit workspace overrides and keep CLI help text aligned with the repo-aware launcher flow
- make plan edits honest by aligning the `modify.diff` contract with the executor behavior

Subagent review agreed the startup/status work is low-risk and bounded; `apply_changes` is the only contract-sensitive area, so it is split into contract alignment and executor implementation.

## Dependency Graph
```text
T3 ──> T4
T1, T2, T3, T4 ──> T5
```

## Tasks

### T1: Preserve error state during disk hydration
- **depends_on**: []
- **location**: `src/mcp/serviceClient.ts`, `tests/serviceClient.test.ts`
- **description**: Stop `hydrateIndexStatusFromDisk()` from downgrading an existing in-memory `error` state to `idle`; do not add new persisted error storage in this plan.
- **validation**: Regression test proves an in-memory `error` plus `lastError` survive hydration, and startup auto-index still respects the error state.

### T2: Harden explicit workspace overrides and launcher help
- **depends_on**: []
- **location**: `src/workspace/resolveWorkspace.ts`, `tests/workspace/resolveWorkspace.test.ts`, `tests/launcher.test.ts`
- **description**: Fail fast when `--workspace` is present without a value or points to a missing or non-directory path; keep cwd and git-root fallback behavior unchanged when no override is provided, and update CLI help / launcher examples to match the repo-aware flow.
- **validation**: Invalid explicit workspace exits clearly; valid override still works; existing fallback cases remain green; help text no longer shows the stale per-repo config example.

### T3: Align the `modify.diff` contract
- **depends_on**: []
- **location**: `src/mcp/prompts/planning.ts`, `src/mcp/services/planningService.ts`, `src/mcp/types/planning.ts`, `src/mcp/tools/plan.ts`, `tests/tools/planLifecycle.contract.test.ts`
- **description**: Make the plan-generation and validation surfaces explicitly treat `modify.diff` as supported so the contract matches the intended executor behavior before the write path changes.
- **validation**: Contract snapshots, generated-change validation, and service-layer tests all agree on the supported `modify.diff` shape and no longer advertise unsupported behavior.

### T4: Implement diff application in plan `apply_changes`
- **depends_on**: [T3]
- **location**: `src/mcp/tools/plan.ts`, `tests/tools/plan.test.ts`
- **description**: Implement `modify`-with-diff application for plan edits using an internal patch helper; validate the diff and destination path before creating backups; keep create/delete behavior and backup/error reporting unchanged; leave rename unsupported with an explicit warning.
- **validation**: Diff-based modify requests apply correctly, malformed diffs fail clearly, sibling-prefix traversal is rejected, backups are created at the right time, and existing full-content updates still work.

### T5: Final regression sweep
- **depends_on**: [T1, T2, T3, T4]
- **location**: affected test suites and CI checks
- **description**: Run focused regression coverage for hydration, workspace validation, launcher/help output, contract alignment, and plan edit application.
- **validation**: Targeted tests pass; no regressions in repo-aware startup, manual indexing, or plan execution.

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T1, T2, T3 | Immediately |
| 2 | T4 | T3 complete |
| 3 | T5 | T1, T2, T3, T4 complete |

## Test Plan
- `serviceClient` regression for error hydration.
- Workspace override regression for missing-value, invalid, and valid `--workspace`.
- Launcher/help output check for the repo-aware example.
- Contract regression for supported `modify.diff` shape.
- Plan execution regression for diff-based `modify` changes, backups, and malformed diff handling.
- End-to-end smoke that existing repo-aware startup and auto-index behavior still behave as before.

## Assumptions
- Repo-aware startup and auto-indexing are already correct and out of scope for this plan.
- `modify.diff` should be supported rather than removed, because the contract already exposes it and the current gap is implementation, not intent.
- No new runtime dependency is required unless the internal patch helper proves too large; if that happens, keep the dependency local and version-pinned.
- Explicit `--workspace` remains an override; it should not change the cwd/git-root fallback path when absent.
- This plan only preserves in-memory error state during hydration; restart-visible persisted error state would be a separate enhancement if we ever want it.
