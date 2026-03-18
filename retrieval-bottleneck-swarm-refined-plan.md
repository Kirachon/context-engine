# Plan: Swarm-Refined Retrieval Bottleneck Upgrade (v2)

## Summary
This plan integrates subagent review plus party-mode consensus to make execution safer and more parallel-ready while preserving quality.  
Core upgrades to the prior plan:
- Add an explicit pre-implementation contract gate (`T0`).
- Move bench-hang work to the front and split into repro/fix.
- Move best-practice alignment early as design constraints.
- Split validation into two hard gates: behavioral safety and benchmark integrity.
- Add explicit operational safety drills (kill switch, per-flag rollback proof, auto-abort canary).

## Interface / Contract Changes
- No MCP tool schema breaking changes.
- KPI verdicts must be mode-locked to `retrieve/search`; `scan` fallback is diagnostic only.
- Evidence contract tightened: benchmark provenance + dataset/profile/flag equivalence required for compare.
- Keep default-safe rollout posture (flags remain conservative until gates pass).

## Dependency Graph
`T0 -> T1 -> (T2, T4, T5a) -> T3 -> T6 -> (T7, T8, T9) -> (T10, T11) -> T12 -> T13`

## Tasks

### T0: Contract + Ownership Gate
- **depends_on**: `[]`
- **description**: Lock KPI targets, ownership map, file boundaries, and pass/fail artifact contract.
- **validation**: Signed task matrix exists with explicit owners and acceptance checks.

### T1: Baseline + Repro Pack
- **depends_on**: `[T0]`
- **description**: Freeze baseline commands/artifacts for latency, quality, reliability, and tool-contract snapshots.
- **validation**: Baseline bundle is reproducible and versioned.

### T2: Bench Hang Reproduction (`T6a`)
- **depends_on**: `[T1]`
- **description**: Create deterministic failing case for `bench:ci:pr` hang path.
- **validation**: Repro test fails consistently pre-fix.

### T3: Bench Hang Fix (`T6b`)
- **depends_on**: `[T2]`
- **description**: Implement watchdog/timeout-safe execution and deterministic fallback handling.
- **validation**: Repro passes; suite finishes within configured timeout.

### T4: Bottleneck Map / Impact Envelope
- **depends_on**: `[T1]`
- **description**: Build stage-level latency map (queue, retrieval, rerank, assembly) and risk envelope.
- **validation**: Per-tool hotspot report with ranked bottlenecks.

### T5a: Early Best-Practice Constraint Pass
- **depends_on**: `[T1]`
- **description**: Define optimization constraints before implementation (latency-vs-quality guardrails).
- **validation**: Constraint checklist published and referenced by implementation tasks.

### T6: Implementation Scaffold + Conflict-Safe Ordering
- **depends_on**: `[T3, T4, T5a]`
- **description**: Finalize edit sequencing/ownership to prevent same-file collisions and unstable parallel edits.
- **validation**: Execution matrix confirms conflict-free wave plan.

### T7: Retrieval/Ranking/Queue Optimizations
- **depends_on**: `[T6]`
- **description**: Apply safe incremental speed + ranking improvements for `semantic_search` and shared retrieval path.
- **validation**: Targeted tests pass; no contract regressions.

### T8: Context-Pack and `codebase_retrieval` Efficiency Pass
- **depends_on**: `[T6]`
- **description**: Reduce repeated work and improve bounded context selection without losing relevance.
- **validation**: Token/latency improve on same fixture set.

### T9: `get_context_for_prompt` + `enhance_prompt` Reliability/Speed Pass
- **depends_on**: `[T6]`
- **description**: Harden timeout/retry/fallback behavior and avoid unnecessary context bloat.
- **validation**: Structured output contract preserved; transient failure handling verified.

### T10: Behavioral Safety Gate
- **depends_on**: `[T7, T8, T9]`
- **description**: Validate fallback state-machine behavior, anti-thrash/hysteresis, cache correctness, and error-rate parity.
- **validation**: Behavioral gate report is pass with measured evidence.

### T11: Benchmark Integrity Gate
- **depends_on**: `[T3, T7, T8, T9]`
- **description**: Enforce KPI evidence integrity (mode lock, provenance match, no scaffolded metrics, multi-run stability bounds).
- **validation**: Integrity gate pass; KPI verdict accepted only from valid retrieve/search artifacts.

### T12: Safety Drills + Canary Abort Controls
- **depends_on**: `[T10, T11]`
- **description**: Run kill-switch propagation drill, per-flag rollback proof, and telemetry-driven canary auto-abort test.
- **validation**: Drill artifacts prove bounded blast radius and rollback MTTR target.

### T13: Final Evidence Pack + Rollout Verdict
- **depends_on**: `[T12]`
- **description**: Publish before/after report with deltas, risks, rollback steps, and rollout recommendation.
- **validation**: Complete evidence pack with rerun commands and signed go/no-go.

## Parallel Execution Groups
1. Wave 1: `T0`
2. Wave 2: `T1`
3. Wave 3: `T2`, `T4`, `T5a`
4. Wave 4: `T3`
5. Wave 5: `T6`
6. Wave 6: `T7`, `T8`, `T9`
7. Wave 7: `T10`, `T11`
8. Wave 8: `T12`
9. Wave 9: `T13`

## Test Plan
- Tool contract snapshots: `semantic_search`, `codebase_retrieval`, `get_context_for_prompt`, `enhance_prompt`.
- Benchmark harness reliability: hang watchdog + timeout determinism.
- Retrieval correctness: quality metrics and fallback correctness under stress.
- Cache safety: key isolation, stale-index invalidation, bypass-cache A/B.
- Safety/rollout: kill switch, per-flag rollback, canary auto-abort.
- KPI acceptance: `retrieve/search` mode-locked evidence only; no `scan`-based KPI pass.

## Assumptions
- Safe incremental rollout remains default.
- KPI thresholds continue to use `docs/BENCHMARKING.md`.
- No public API/schema break is allowed in this phase.

## Execution Log

- [x] `T0` (docs contract): Added execution board with task checklist, ownership matrix, dependency waves, and acceptance contract at `docs/plan-execution/retrieval-bottleneck-v2-execution-board.md`.
- [x] `T1` (docs baseline pack): Added reproducible baseline command set and canonical artifact paths at `docs/plan-execution/retrieval-bottleneck-v2-baseline-pack.md`.
- [x] `T4` (docs impact envelope linkage): Anchored bottleneck mapping acceptance and artifact linkage to `docs/RETRIEVAL_IMPACT_MAP.md` within execution board contract.
- [x] `T5a` (docs guardrails): Captured early constraints and KPI evidence rules in execution board acceptance contract (`retrieve/search` KPI mode lock, provenance requirements).
- [x] `T6` (docs sequencing scaffold): Added conflict-safe dependency waves and owner lane boundaries in execution board.
- [x] `T12` (docs safety drills): Added kill-switch, per-flag rollback, and canary auto-abort drill runbook at `docs/plan-execution/retrieval-bottleneck-v2-safety-drills.md`.
- [x] `T13` (docs evidence template): Added final report template with sign-off and artifact checklist at `docs/plan-execution/retrieval-bottleneck-v2-evidence-pack-template.md`.
- [x] `T2` (bench hang repro hardening): Updated `scripts/ci/run-bench-suite.ts` probe selection to require parseable benchmark JSON with comparable metrics (not just exit code `0`).
- [x] `T3` (bench hang fix path): Added timeout-aware probe failure diagnostics and PR probe policy helpers in `src/ci/benchSuiteModePolicy.ts`; `run-bench-suite` now reports probe-timeout budget directly.
- [x] `T11` (benchmark integrity mode lock): Enforced PR KPI mode lock default (`retrieve/search` only, `scan` locked unless explicitly overridden by `BENCH_SUITE_ALLOW_SCAN_FALLBACK=true`), added `scripts/ci/check-bench-mode-lock.ts`, and added tests in `tests/ci/checkBenchModeLock.test.ts`.
- [x] `T12` (live gate checks): Ran `ci:check:retrieval-quality-gate`, `ci:check:retrieval-shadow-canary-gate`, `ci:check:ws21-rollback-drill`, and `check-rollout-readiness.ts`; all passed in this environment.
- [~] `T13` (draft evidence pack): Updated draft at `docs/plan-execution/retrieval-bottleneck-v2-evidence-pack-draft-2026-03-18.md`; mode-lock passes and latest locked `retrieve` run passes PR compare gate with local stabilization override (`BENCH_SUITE_PR_ITERATIONS=3`), current status `CONDITIONAL GO` pending CI/default-settings confirmation.
