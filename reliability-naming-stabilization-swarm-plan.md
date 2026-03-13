# Plan: Reliability + Naming Stabilization (Swarm-Safe)

**Generated:** 2026-03-12  
**Scope lock:** Implement audit fixes for reliability + naming cleanup, **excluding** `src/mcp/tools/plan.ts` TODO path (`:421`) as requested.

## Summary
This plan targets the two high-risk failures first, then cleans remaining runtime-facing stale naming references, and ends with a strict validation wave.  
Execution is dependency-aware for parallel agents and avoids public contract breakage.

## Public API / Interface Impact
- **No MCP tool name/arg/output schema changes planned.**
- `review_diff` output is expected to return to currently-tested contract behavior (risk/classification/findings/gate behavior) by fixing regression path, not by introducing new fields.
- Changes are internal to test/runtime behavior, CI script robustness, and user-facing wording cleanup.

## Dependency Graph
```text
T1 ──┬── T2 ── T3 ──┐
     │               │
     ├── T4 ─────────┼── T6
     │               │
     └── T5 ─────────┘
```

## Tasks

### T1: Lock Baseline + Acceptance Gates
- **depends_on**: []
- **location**: `tests/serviceClient.test.ts`, `tests/ci/reviewDiffArtifacts.test.ts`, `scripts/ci/review-diff.ts`
- **description**: Freeze exact repro criteria and pass/fail acceptance for both failing tracks before edits.
- **validation**: Re-run isolated failing tests and record expected failure signatures.
- **status**: Completed
- **log**: Reproduced baseline failures before edits: `tests/serviceClient.test.ts` provider-dispatch case timed out with open handles; `tests/ci/reviewDiffArtifacts.test.ts` had 3 failing tests with empty-diff artifact drift.
- **files edited/created**: None

### T2: Fix Queue Timer/Open-Handle Reliability Path
- **depends_on**: [T1]
- **location**: `src/mcp/serviceClient.ts`
- **description**: Make queue timeout lifecycle deterministic (cleanup on settle/cancel/error) so tests do not leak open handles.
- **validation**: `tests/serviceClient.test.ts` targeted case no longer times out; `--detectOpenHandles` reports clean exit.
- **status**: Completed
- **log**: Added deterministic queue cleanup for abort listeners/timers on resolve, reject, abort, and queue clear to reduce leaked handle risk.
- **files edited/created**: `src/mcp/serviceClient.ts`

### T3: Stabilize Provider-Dispatch Unit Test Isolation
- **depends_on**: [T2]
- **location**: `tests/serviceClient.test.ts`
- **description**: Ensure the targeted provider-dispatch test cannot hit live provider timeout path; make it fully deterministic.
- **validation**: Targeted test passes repeatedly (`--runInBand`) without 30s timeout.
- **status**: Completed
- **log**: Made targeted unit test deterministic by stubbing provider response to non-JSON so fallback path is exercised without waiting on live provider timeout.
- **files edited/created**: `tests/serviceClient.test.ts`

### T4: Restore `review-diff` Artifact Contract Determinism
- **depends_on**: [T1]
- **location**: `scripts/ci/review-diff.ts`, `src/reviewer/reviewDiff.ts`, `tests/ci/reviewDiffArtifacts.test.ts`
- **description**: Fix changed-files/invariants/gate drift path so CI artifact outputs match intended deterministic behavior again.
- **validation**: `tests/ci/reviewDiffArtifacts.test.ts` passes; expected PASS/FAIL cases and snapshots are stable.
- **status**: Completed
- **log**: Fixed cross-platform git revision parsing in CI script by switching from shell command strings to argument-array git calls (`execFileSync`), restoring correct base/head diff behavior and snapshot contract.
- **files edited/created**: `scripts/ci/review-diff.ts`

### T5: Runtime-Facing Naming Cleanup (Auggie/Augment Text)
- **depends_on**: [T1]
- **location**: `vscode-extension/src/providers/chatPanelProvider.ts`, `CHANGELOG.md`, selected runtime-facing docs
- **description**: Replace stale runtime-facing product wording with current local-native wording; keep historical/archive evidence docs intact unless they are user-facing runtime guidance.
- **validation**: scoped grep over runtime-facing surfaces shows no stale naming references; legal/evidence docs remain accurate.
- **status**: Completed
- **log**: Updated runtime-facing VS Code enhance error note to local-native wording; intentionally kept historical changelog sections unchanged.
- **files edited/created**: `vscode-extension/src/providers/chatPanelProvider.ts`

### T6: Final Validation + Evidence Bundle
- **depends_on**: [T3, T4, T5]
- **location**: test/CI commands + audit receipts
- **description**: Run full required validation matrix and produce concise before/after evidence summary.
- **validation**:
  - `npm test -- tests/serviceClient.test.ts -t "should route local_native semantic search via provider boundary without touching legacy runtime parsing path" --runInBand --detectOpenHandles`
  - `npm test -- tests/ci/reviewDiffArtifacts.test.ts --runInBand`
  - `npm run -s ci:check:no-legacy-provider`
  - `npm run -s ci:check:retrieval-dependency-boundary`
  - `npm run -s ci:check:enhance-prompt-contract`
- **status**: Completed
- **log**: All required validation commands passed after changes: targeted provider-dispatch test (`--detectOpenHandles`), `reviewDiffArtifacts` suite, `ci:check:no-legacy-provider`, `ci:check:retrieval-dependency-boundary`, `ci:check:enhance-prompt-contract`.
- **files edited/created**: None

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2, T4, T5 | T1 complete |
| 3 | T3 | T2 complete |
| 4 | T6 | T3, T4, T5 complete |

## Test Plan (Critical Scenarios)
1. **Timeout/Open-handle regression**: provider-dispatch test passes and exits cleanly with `--detectOpenHandles`.
2. **Artifact contract regression**: invariant FAIL case fails gate; PASS/no-invariant cases stay pass; snapshot expectations stable.
3. **Naming cleanup safety**: runtime-facing text updated without modifying intentionally historical evidence context.
4. **Boundary safety**: no reintroduction of legacy provider runtime dependency.

## Assumptions / Defaults
- Excluded from scope by request: `src/mcp/tools/plan.ts:421` TODO path.
- No new dependencies required.
- Snapshot updates are only allowed if backed by deterministic behavior correction (not masking regressions).
- Subagent review was attempted twice but blocked by usage-limit error in this environment; this plan includes manual dependency/risk self-review in its place.
