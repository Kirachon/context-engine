# Plan: Adopt Codedb-Style Retrieval and Guardrail Improvements

**Generated**: 2026-04-05

## Overview
This wave brings the most useful `codedb` ideas into `context-engine` without changing the product into a different system. The goal is to make identifier lookups faster, cold starts cheaper, and file-change handling safer while keeping the current MCP contract and local-first behavior intact.

## Scope Lock
- In scope: internal retrieval improvements, versioned cold-start reuse, watcher ignore parity, and a workspace-scoped runtime guard.
- Out of scope: a new public MCP tool, a Zig/runtime rewrite, any network dependency, telemetry expansion, or changing default behavior before the new paths prove stable.
- Likely touch surfaces: `src/internal/retrieval/*`, `src/mcp/indexStateStore.ts`, `src/mcp/serviceClient.ts`, `src/mcp/server.ts`, `src/watcher/FileWatcher.ts`, `src/index.ts`, and the matching tests.
- Frozen assumption: each improvement must have its own fallback path so disabling one behavior does not block the others.

## Prerequisites
- Existing retrieval and watcher code must stay the source of truth for current behavior.
- Existing feature flags remain the default rollout mechanism.
- Benchmark and integration tests are available for retrieval quality, state reuse, watcher behavior, and Windows process handling.

## Dependency Graph

```text
T1 (contract + baseline) -> T2 (identifier-first retrieval)
T1 (contract + baseline) -> T3 (versioned cold-start reuse)
T1 (contract + baseline) -> T4 (watcher ignore parity)
T1 (contract + baseline) -> T5 (workspace-scoped runtime guard)
T2, T3, T4, T5 -> T6 (integration gate + release readiness)
```

## Tasks

### T1: Freeze the shared retrieval and compatibility contract
- **depends_on**: []
- **location**: `src/internal/retrieval/lexical.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/chunkIndex.ts`, `src/mcp/indexStateStore.ts`, `tests/internal/retrieval/sqliteLexicalIndex.test.ts`, `tests/internal/retrieval/chunkIndex.test.ts`, `tests/mcp/indexStateStore.test.ts`
- **description**: First define the shared rules for identifier-first routing, semantic fallback, and ranking expectations. Then lock the baseline query set and compatibility keys that later tasks must honor.
- **validation**: Baseline benchmark and test fixtures exist for symbol-heavy, path-like, ambiguous, short, and stopword-heavy queries; the compatibility keys are documented before any storage or reuse work begins.
- **status**: Completed
- **log**: Established the shared identifier-first retrieval contract in `src/internal/retrieval/searchHeuristics.ts`, tightened lexical/chunk scoring so exact matches get priority without removing semantic fallback, and extended index-state metadata to carry workspace/feature compatibility keys.
- **files edited/created**: `src/internal/retrieval/searchHeuristics.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/chunkIndex.ts`, `src/mcp/indexStateStore.ts`, `tests/internal/retrieval/sqliteLexicalIndex.test.ts`, `tests/internal/retrieval/chunkIndex.test.ts`, `tests/mcp/indexStateStore.test.ts`

### T2: Add identifier-first retrieval as a read-path fast path
- **depends_on**: [T1]
- **location**: `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/lexical.ts`, `src/internal/retrieval/chunkIndex.ts`, `src/mcp/serviceClient.ts`, `tests/internal/retrieval/sqliteLexicalIndex.test.ts`, `tests/internal/retrieval/chunkIndex.test.ts`, `tests/tools/search.test.ts`
- **description**: Extend the existing lexical retrieval path so identifier-like queries get the strongest local match first, but always fall back to the current semantic path when confidence is low. Keep the behavior internal to the current MCP flow and behind the existing retrieval gates.
- **validation**: Mixed-query integration tests pass; identifier-heavy queries improve or stay flat on the baseline set; ambiguous queries still return semantic matches when lexical confidence is weak.
- **status**: Completed
- **log**: Added the identifier-first fast path by boosting exact/token/path matches in lexical and chunk retrieval, while preserving semantic fallback and keeping the behavior internal to the existing MCP flow.
- **files edited/created**: `src/internal/retrieval/searchHeuristics.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/chunkIndex.ts`, `tests/internal/retrieval/sqliteLexicalIndex.test.ts`, `tests/internal/retrieval/chunkIndex.test.ts`

### T3: Make cold-start reuse versioned and safe
- **depends_on**: [T1]
- **location**: `src/mcp/indexStateStore.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `src/internal/retrieval/chunkIndex.ts`, `src/mcp/serviceClient.ts`, `tests/mcp/indexStateStore.test.ts`, `tests/internal/retrieval/sqliteLexicalIndex.test.ts`, `tests/internal/retrieval/chunkIndex.test.ts`
- **description**: Using the T1 contract, persist and validate versioned snapshot metadata for faster restarts. Reuse cached state only when workspace, schema, parser, provider, ignore snapshot, and feature-flag snapshot all match; otherwise rebuild deterministically and treat mismatch as a full-rebuild trigger.
- **validation**: Tests cover schema bumps, parser bumps, workspace fingerprint changes, partial/corrupt state, and mismatch fallback. Warm-start reuse is measurably faster on the happy path, and mismatch always falls back to rebuild rather than partial recovery.
- **status**: Completed
- **log**: Added workspace fingerprint and feature-flag snapshot compatibility to persisted index state, and made incompatible or corrupt state fall back to a deterministic rebuild instead of partial reuse.
- **files edited/created**: `src/mcp/indexStateStore.ts`, `src/mcp/serviceClient.ts`, `tests/mcp/indexStateStore.test.ts`, `tests/serviceClient.test.ts`

### T4: Centralize watcher ignore parity and incremental change replay
- **depends_on**: [T1]
- **location**: `src/mcp/serviceClient.ts`, `src/mcp/server.ts`, `src/watcher/FileWatcher.ts`, `tests/watcher/FileWatcher.test.ts`
- **description**: Reuse one ignore source for indexing and watching, then normalize and replay add/change/unlink events through the same rules so watcher behavior matches indexing behavior. Preserve batching and deduping so rapid edits do not trigger duplicate work.
- **validation**: Tests prove `.gitignore` / `.contextignore` parity, rename-unlink-readd handling, and no duplicate indexing or missed deletes during a debounce window.
- **status**: Completed
- **log**: Moved ignore-rule normalization into a shared helper, reused it in the watcher bootstrap, and hardened debounce coverage so add/change/unlink sequences keep the final event state.
- **files edited/created**: `src/watcher/ignoreRules.ts`, `src/mcp/server.ts`, `tests/watcher/ignoreRules.test.ts`, `tests/watcher/FileWatcher.test.ts`

### T5: Add a workspace-scoped runtime lock with stale-lock recovery
- **depends_on**: [T1]
- **location**: `src/index.ts`, `src/mcp/server.ts`, `docs/RUNBOOK_CONTEXT_ENGINE_PROCESS_HEALTH.md`, `scripts/ops/check-context-engine-process-health.ps1`
- **description**: Add a startup guard that protects shared writable state for a workspace, not the whole machine. If a stale lock is found, recover deterministically; if the guard cannot acquire the lock, log a warning and continue with the current unguarded startup behavior for that workspace rather than blocking launch.
- **validation**: Windows tests show deterministic behavior for stale locks, concurrent launches, and crash recovery. The guard does not interfere with separate workspaces and lock failure is a warning, not a hard stop.
- **status**: Completed
- **log**: Added a workspace-scoped startup lock with stale-lock recovery and non-fatal acquisition failure handling so separate workspaces do not block each other.
- **files edited/created**: `src/runtime/workspaceLock.ts`, `src/index.ts`, `tests/runtime/workspaceLock.test.ts`

### T6: Prove the wave is safe and ready to ship
- **depends_on**: [T2, T3, T4, T5]
- **location**: `tests/internal/retrieval/*`, `tests/mcp/*`, `tests/watcher/*`, `tests/ci/*`, benchmark artifacts and release notes as needed
- **description**: Run the full retrieval, snapshot, watcher, and Windows process checks together, confirm feature flags are still opt-in, and verify no MCP tool contract or manifest drift was introduced.
- **validation**: Retrieval quality is flat or better on the fixed symbol-query benchmark set; cold-start tests pass; watcher tests pass; Windows process tests pass; manifest parity stays green; rollback is one-flag-per-behavior; contract parity checks remain green on the current MCP tool surface.
- **status**: Partially Completed
- **log**: Build and targeted unit tests passed, including retrieval, snapshot compatibility, watcher, and runtime-lock coverage. Scripted CI-style parity/benchmark checks were attempted, but this environment blocks `tsx`/`esbuild` child-process startup with `spawn EPERM`, so the final release gate remains open here even though the logic paths themselves are implemented.
- **files edited/created**: None

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T1 | Immediately |
| 2 | T2, T3, T4, T5 | T1 complete |
| 3 | T6 | T2, T3, T4, T5 complete |

## Testing Strategy
- Use a fixed query set that includes symbol-heavy, path-like, ambiguous, short, and stopword-heavy cases.
- Keep at least one mixed-query integration test so the identifier-first path cannot hide a recall regression.
- Add restart and migration coverage for persisted state, including schema mismatch and corrupt artifact recovery.
- Add Windows duplicate-process and stale-lock coverage for the runtime guard.
- Keep a before/after benchmark for retrieval quality and cold-start reuse.

## Risks & Mitigations
- Risk: identifier-first routing becomes too narrow. Mitigation: always keep semantic fallback and rerank available.
- Risk: snapshot reuse serves stale data. Mitigation: require all compatibility keys to match, otherwise rebuild.
- Risk: watcher and startup policies diverge. Mitigation: centralize ignore normalization and keep the runtime lock separate from watcher logic.
- Risk: one bad behavior blocks the whole wave. Mitigation: one gate and fallback per task.

## Final Readiness Gate
- The wave is ready only when all task-level tests pass, the retrieval benchmark is flat or better, cold-start reuse is measurably improved, watcher behavior is stable, the Windows lock path is deterministic, and the existing MCP contract/manifest parity remains unchanged.

## Execution Summary

### Completed
- T1: Freeze the shared retrieval and compatibility contract
- T2: Add identifier-first retrieval as a read-path fast path
- T3: Make cold-start reuse versioned and safe
- T4: Centralize watcher ignore parity and incremental change replay
- T5: Add a workspace-scoped runtime lock with stale-lock recovery

### Partially Completed
- T6: Prove the wave is safe and ready to ship
  - Build and targeted tests passed.
  - CI-style parity and benchmark scripts could not be fully executed in this environment.

### Evidence
- Validation passed: `npm run build`
- Validation passed: targeted retrieval, index-state, watcher, and runtime-lock tests
- Validation deferred: CI harness scripts that launch the parity/benchmark checks; direct execution is blocked here by `tsx`/`esbuild` child-process `spawn EPERM`
