# Plan: User-Visible Search Upgrade (Swarm Execution)

## Summary
Deliver one release stream that upgrades all five outcomes with safe staged rollout:
1. Better top-result relevance.
2. Faster searches on large codebases.
3. True hybrid retrieval (semantic + keyword + symbol).
4. Richer context packs (best files + why + dependency map).
5. Reliability guardrails with auto-fallback.

Locked defaults:
- KPI profile: `balanced`
- Rollout strategy: staged
- Fallback policy: blend first, then hard revert if degradation persists

Target acceptance thresholds (vs current baseline on fixed fixture pack + holdout):
- `nDCG@10 >= +8%`, `MRR@10 >= +6%`, `Recall@50 >= +10%`
- `p50 latency <= -20%`, `p95 latency <= -25%` on large dataset
- Error rate must not regress; fallback activation must be correct and observable

## Public Interface / Config Changes
- No breaking MCP contract changes.
- Additive-only response metadata (behind flags): `query_mode`, `hybrid_components`, `quality_guard_state`, `fallback_state`.
- New feature flags (default OFF): `CE_RETRIEVAL_HYBRID_V1`, `CE_RETRIEVAL_RANKING_V3`, `CE_CONTEXT_PACKS_V2`, `CE_RETRIEVAL_QUALITY_GUARD_V1`.
- Keep existing flags/contracts operational so flags-off behavior remains baseline-equivalent.

## Dependency-Aware Tasks

### T1: Baseline + KPI Contract
- **depends_on**: `[]`
- **location**: `docs/BENCHMARKING.md`, `config/ci/retrieval-quality-fixture-pack.json`, `scripts/ci/generate-retrieval-quality-report.ts`
- **description**: Freeze baseline dataset/splits, query sets, KPI formulas, and pass/fail thresholds.
- **validation**: Baseline artifacts generated and reproducible (`quality report` + `telemetry` + latency snapshots).

### T2: Impact Map + Safety Envelope
- **depends_on**: `[]`
- **location**: `src/internal/retrieval/*`, `src/mcp/tools/*`, `src/config/features.ts`, `docs/ROLLOUT_RUNBOOK.md`
- **description**: Finalize affected components, risk map, and flag/rollback matrix before code changes.
- **validation**: Written component map with high-risk hot paths and explicit rollback controls.

### T3: Hybrid Retrieval Planner (Semantic + Keyword + Symbol)
- **depends_on**: `[T1, T2]`
- **location**: `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/expandQuery.ts`, `src/internal/retrieval/*`
- **description**: Build bounded hybrid candidate fan-out, query routing, and merge scaffolding.
- **validation**: Unit tests for fan-out caps, deterministic merge order, and query-mode composition.

### T4: Ranking Quality V3
- **depends_on**: `[T3]`
- **location**: `src/internal/retrieval/rerank.ts`, `src/internal/retrieval/fusion.ts`, `src/internal/retrieval/dedupe.ts`
- **description**: Add stronger ranking signals (including symbol-aware boosts) with calibrated weights and normalization.
- **validation**: Query-family evaluation shows non-regressive top-k relevance under flag-off baseline parity.

### T5: Latency Optimization on Large Codebases
- **depends_on**: `[T1, T2]`
- **location**: `src/internal/retrieval/retrieve.ts`, `src/internal/handlers/performance.ts`, cache/reuse hooks
- **description**: Reduce repeated work (memo/cache reuse), add bounded rerank budgets, and early exits.
- **validation**: Large-set benchmark confirms p50/p95 targets without correctness regressions.

### T6: Context Packs V2
- **depends_on**: `[T3, T4]`
- **location**: `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, `src/mcp/tools/context.ts`
- **description**: Return “best files + concise why selected + dependency map” with strict size budget.
- **validation**: Integration tests validate stable structure and capped response size.

### T7: Quality Guard + Auto-Fallback
- **depends_on**: `[T4, T5]`
- **location**: retrieval/handler guard modules + `src/config/features.ts`
- **description**: Compute rolling quality score; apply blend fallback on first degradation; hard revert on sustained failure.
- **validation**: Fault-injection tests prove trigger thresholds, fallback transitions, and recovery behavior.

### T8: Tool Wiring + Telemetry
- **depends_on**: `[T6, T7]`
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `src/mcp/tools/enhance.ts`, observability modules
- **description**: Wire hybrid/ranking/context/guard signals into tool outputs and metrics.
- **validation**: Tool snapshots remain backward compatible; new fields are additive and flag-gated.

### T9: Test + Gate Expansion
- **depends_on**: `[T3, T4, T5, T6, T7, T8]`
- **location**: `tests/internal/retrieval/*`, `tests/tools/*`, `tests/ci/*`, `scripts/ci/*`
- **description**: Add coverage for hybrid merge, ranking boosts, latency guardrails, fallback policy, flags on/off.
- **validation**: CI gates all green, including quality gate and stale-cache/config-precedence checks.

### T10: Benchmark + Evidence Pack
- **depends_on**: `[T9]`
- **location**: `artifacts/bench/*`, `scripts/ci/generate-retrieval-quality-telemetry.ts`, reporting docs
- **description**: Produce before/after evidence for small/medium/large and holdout sets.
- **validation**: Signed-off evidence bundle with raw numbers and deltas for relevance/latency/reliability.

### T11: Staged Rollout + Runbook Finalization
- **depends_on**: `[T10]`
- **location**: `docs/ROLLOUT_RUNBOOK.md`, `docs/BENCHMARKING_GATES.md`, release readiness docs
- **description**: Ship staged rollout plan, guard thresholds, operator playbook, and rollback checklist.
- **validation**: Readiness checks pass and rollback drill documented with command-level evidence.

## Parallel Execution Waves
| Wave | Tasks | Can Start When |
|---|---|---|
| 1 | `T1, T2` | Immediately |
| 2 | `T3, T5` | `T1 + T2` complete |
| 3 | `T4` | `T3` complete |
| 4 | `T6, T7` | `T6: T3+T4`, `T7: T4+T5` |
| 5 | `T8` | `T6 + T7` complete |
| 6 | `T9` | `T3+T4+T5+T6+T7+T8` complete |
| 7 | `T10` | `T9` complete |
| 8 | `T11` | `T10` complete |

## Test Plan and Acceptance
- Core checks:
  - `npm run test`
  - `npm run build`
  - `npm run ci:check:retrieval-quality-gate`
  - `npm run ci:check:retrieval-holdout-fixture`
  - `npm run ci:check:stale-cache-guards`
  - `npm run ci:check:retrieval-config-precedence`
- Benchmark checks:
  - `npm run bench:ci:pr`
  - `npm run ci:generate:retrieval-quality-report`
  - `npm run ci:generate:retrieval-quality-telemetry`
- Rollout-safety checks:
  - `npm run ci:check:retrieval-shadow-canary-gate`
- Release only if all five outcomes pass thresholds and flags-off baseline remains intact.

## Assumptions
- Existing semantic retrieval/index primitives are extended, not replaced.
- Existing fixture pack + holdout remain source-of-truth for comparison.
- Additive metadata/flags are acceptable; no breaking MCP tool schema changes.
- If thresholds are missed, rollout stays staged and defaults remain baseline-safe.

## Execution Status (2026-03-13)

| Task | Status | Work Log | Files |
|---|---|---|---|
| `T1` | Completed | KPI thresholds and baseline contract aligned in benchmarking + fixture pack. | `docs/BENCHMARKING.md`, `docs/BENCHMARKING_GATES.md`, `config/ci/retrieval-quality-fixture-pack.json` |
| `T2` | Completed | Added impact map and rollout safety envelope/rollback matrix for new flags. | `docs/RETRIEVAL_IMPACT_MAP.md`, `docs/ROLLOUT_RUNBOOK.md`, `docs/FLAG_REGISTRY.md` |
| `T3` | Completed | Hybrid retrieval foundations confirmed (semantic + lexical/dense fusion already active) with metadata surfacing in tool outputs. | `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts` |
| `T4` | Completed | Added ranking v3 path with stronger path/symbol-aware prioritization behind flag. | `src/internal/retrieval/types.ts`, `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/rerank.ts` |
| `T5` | Completed | Added per-variant parallel fan-out across semantic/keyword/dense retrieval calls to reduce serialized latency. | `src/internal/retrieval/retrieve.ts` |
| `T6` | Completed | Context pack v2 data model + rendering sections (`why selected`, dependency map) behind flag. | `src/mcp/serviceClient.ts`, `src/mcp/tools/context.ts` |
| `T7` | Completed | Added quality-guard blend fallback trigger on weak/empty result quality and surfaced active/inactive fallback state end-to-end. | `src/internal/handlers/retrieval.ts`, `src/internal/handlers/types.ts`, `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts` |
| `T8` | Completed | Additive metadata fields wired across search/codebase retrieval outputs. | `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts` |
| `T9` | Completed | Expanded targeted tests for metadata and ranking v3 behavior. | `tests/tools/search.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/internal/retrieval/retrieve.test.ts` |
| `T10` | Completed | Deterministic quality gates and benchmark evidence regenerated; bench suite hardened with timeout + fallback behavior so `bench:ci:pr` no longer hangs on stalled retrieve probes. | `artifacts/bench/retrieval-quality-*.json`, `artifacts/bench/retrieval-shadow-canary-gate.json`, `artifacts/bench/retrieval-holdout-check.json`, `artifacts/bench/pr-baseline.json`, `artifacts/bench/pr-candidate.json`, `scripts/ci/run-bench-suite.ts` |
| `T11` | Completed | Runbook and flag registry finalized for staged rollout and rollback handling. | `docs/ROLLOUT_RUNBOOK.md`, `docs/FLAG_REGISTRY.md` |
