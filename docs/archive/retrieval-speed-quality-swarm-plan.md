# Plan: Retrieval Speed + Quality Swarm Upgrade

## Summary
This plan upgrades retrieval to be faster and smarter while keeping rollout safe and measurable. It is optimized for parallel multi-agent execution with explicit dependencies and decision-locked defaults:
1. Scope: all profiles (`fast`, `balanced`, `rich`).
2. Rollout mode: feature-flagged, defaults OFF.
3. Evaluation set: existing fixtures plus one locked holdout set.
4. Acceptance targets: `nDCG@10 >= +12%`, `MRR@10 >= +10%`, `Recall@50 >= +20%`, latency caps `fast<=350ms`, `balanced<=700ms`, `rich<=1200ms`.

## Public Interfaces / Type Changes
1. Add retrieval feature flags in `src/config/features.ts`: `CE_RETRIEVAL_REWRITE_V2`, `CE_RETRIEVAL_RANKING_V2`, `CE_RETRIEVAL_REQUEST_MEMO_V2` (all default `false`).
2. Extend retrieval option surface in `src/internal/retrieval/types.ts` with explicit mode toggles: `rewriteMode?: 'v1'|'v2'`, `rankingMode?: 'v1'|'v2'`.
3. Extend benchmark input contract in `scripts/bench.ts` with deterministic dataset selector for holdout runs (`--dataset-id holdout` or equivalent fixed selector).
4. Extend CI quality fixture contract to include holdout metric IDs as required checks.

## Dependency Graph
`T0 -> T1,T2,T3a`  
`T1,T3a -> T3b`  
`T3a -> T4`  
`T2,T3a,T3b,T4 -> T5`  
`T2,T3b,T4,T5 -> T6`  
`T6 -> T7`  
`T2,T3b,T4,T5 -> T8a`  
`T1,T7,T8a -> T8b`  
`T1,T2 -> T9a`  
`T7,T8b,T9a -> T9b`  
`T9b -> T10 -> T11`

## Tasks

### T0: Baseline Freeze and Target Lock
- **depends_on**: `[]`
- **location**: retrieval quality fixture + benchmark docs/artifacts
- **description**: Freeze baseline artifacts and lock numeric acceptance thresholds so later comparisons are deterministic.
- **validation**: Baseline manifest includes commit SHA, dataset ID, threshold table, and artifact hashes.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T1: Holdout Dataset Contract and Leakage Guard
- **depends_on**: `[T0]`
- **location**: CI config + benchmark fixtures
- **description**: Add holdout query set with schema version, dataset hash, and contamination/leakage check.
- **validation**: Gate fails if schema/hash mismatch or if holdout overlap policy is violated.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T2: Retrieval Telemetry Upgrade
- **depends_on**: `[T0]`
- **location**: retrieval pipeline metrics layer
- **description**: Add counters/timers for cache hit/miss, expansion variant count, rerank candidate count, stage latency.
- **validation**: Metrics emitted in tests and available in generated telemetry artifact.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T3a: Flag Scaffolding (Safety First)
- **depends_on**: `[T0]`
- **location**: feature-flag config and retrieval entry points
- **description**: Introduce `v2` flags and wire no-op behavior with defaults OFF.
- **validation**: With all flags OFF, outputs are unchanged from baseline.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T3b: Query Rewrite v2
- **depends_on**: `[T1, T3a]`
- **location**: query expansion/rewrite module
- **description**: Improve rewrite quality using safer synonym groups, stricter guards, and profile-aware variant budgets.
- **validation**: Rewrite regression tests pass and harmful-expansion test cases are blocked.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T4: Ranking Signals v2
- **depends_on**: `[T3a]`
- **location**: rerank/scoring module
- **description**: Add deterministic ranking signals: path-token overlap, source-consensus bonus, exact-symbol bonus.
- **validation**: Ranking order tests prove expected prioritization and deterministic tie-break behavior.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T5: Repeated-Work Skip + Memoization Safety
- **depends_on**: `[T2, T3a, T3b, T4]`
- **location**: internal retrieval/context handler cache path
- **description**: Enable request-level memoization with explicit key versioning and invalidation policy.
- **validation**: Collision/stale-read tests pass; repeated identical calls reduce stage work counters.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T6: Profile Tuning Integration
- **depends_on**: `[T2, T3b, T4, T5]`
- **location**: retrieval orchestration/profile mapping
- **description**: Tune per-profile `perQueryTopK`, `maxVariants`, rerank budget/timeouts while preserving fail-open behavior.
- **validation**: Profile-specific tests and latency guard checks pass for fast/balanced/rich.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T7: Rollout Defaults and Operator Controls
- **depends_on**: `[T6]`
- **location**: config docs + startup/env contract
- **description**: Keep v2 flags OFF by default, document enable sequence, and keep rollback/kill-switch path explicit.
- **validation**: Toggle tests confirm instant fallback to baseline behavior.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T8a: Feature-Level Test Expansion
- **depends_on**: `[T2, T3b, T4, T5]`
- **location**: retrieval unit/tool tests
- **description**: Add targeted tests for rewrite/ranking/memoization semantics and telemetry emission.
- **validation**: New targeted suites pass with both v1 and v2 mode coverage.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T8b: Integration + Cold/Warm Benchmark Tests
- **depends_on**: `[T1, T7, T8a]`
- **location**: benchmark + integration test harness
- **description**: Add integration checks for cold/warm behavior and holdout run path.
- **validation**: Deterministic integration tests pass and produce expected artifacts.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T9a: Gate Framework Wiring
- **depends_on**: `[T1, T2]`
- **location**: retrieval quality report/gate scripts + fixture pack
- **description**: Wire holdout and telemetry checks into report generation and gate contracts.
- **validation**: Gate consumes new IDs and fails correctly on synthetic bad fixtures.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T9b: Gate Enforcement + Rollback Drill
- **depends_on**: `[T7, T8b, T9a]`
- **location**: CI gate scripts + ops/runbook docs
- **description**: Enforce new gates in CI and run rollback drill using kill-switch path.
- **validation**: CI enforcement test passes; rollback drill receipt is generated and verifiable.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T10: Shadow/Canary Validation
- **depends_on**: `[T9b]`
- **location**: staged evaluation workflow artifacts
- **description**: Run limited shadow/canary evaluation with abort thresholds before full promotion.
- **validation**: Abort criteria and continue criteria are both testable and logged in artifacts.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T11: Reproducibility Lock + Final Evidence Closeout
- **depends_on**: `[T10]`
- **location**: benchmark evidence artifacts + summary report
- **description**: Finalize before/after evidence with fixed seed/config snapshot/commit+dataset hashes.
- **validation**: Final report reproduces metric deltas and gate verdict from committed artifacts only.
- **status**: Not Completed
- **log**:
- **files edited/created**:

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | T0 | Immediately |
| 2 | T1, T2, T3a | T0 complete |
| 3 | T3b, T4, T9a | dependencies complete |
| 4 | T5, T8a | dependencies complete |
| 5 | T6 | T2, T3b, T4, T5 complete |
| 6 | T7 | T6 complete |
| 7 | T8b, T9b | dependencies complete |
| 8 | T10 | T9b complete |
| 9 | T11 | T10 complete |

## Test Plan and Acceptance
1. Targeted tests: retrieval internals + search tool profile behavior + memoization safety + rewrite/ranking determinism.
2. Gate checks: retrieval quality report generation and retrieval quality gate enforcement with holdout required IDs.
3. Benchmark proof: PR suite plus reproducibility-locked before/after compare for all three profiles.
4. Rollback safety: explicit kill-switch/toggle drill receipt required before final closeout.
5. Final pass criteria: all required quality metrics pass, profile latency caps pass, no regression in fallback/error safety paths.

## Assumptions and Defaults
1. No new external runtime dependency is introduced; changes remain in existing TypeScript/Node toolchain.
2. Existing fixture/gate framework remains source of truth; holdout set is additive, not replacement.
3. Feature flags remain OFF by default until T10 passes.
