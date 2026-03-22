# Archived Plan: Swarm-Ready Retrieval Slowness Program (Updated with Party-Mode Review)

> Status: completed and retained for reference. The active short summary lives in `docs/updates-openai-roadmap-summary.md`.

## Summary
This plan is decision-complete and optimized for parallel multi-agent execution.

- `Track A` (stabilization): deliver near-term live-work usability with `no-regression + reliability` posture.
- `Track B` (migration): execute full gap closure from the improvement plan with `LanceDB-first` MVP architecture.
- Subagent feedback is incorporated for dependency rewiring, rollout gate rigor, and edge-case coverage.
- Wave 1 status: completed `T1`, `T2`, and `T3` implementation slices covering contract-freeze tests, benchmark protocol docs, and `searchAndAsk` telemetry instrumentation.
- Wave 2 status: completed `T4`, `T5`, and `T6` governance, baseline-evidence, and queue-policy stabilization slices.
- Wave 3 status: completed `T8`, `T7`, and `TE1` benchmark-provenance, tuning-backlog, and telemetry-data-quality slices.
- Wave 4 status: completed `T9`, `TE2`, and `TE3` rollout-playbook, queue-stress, and compatibility-negative slices.
- Wave 5 status: completed `T16a` initial execution board, which now maps the remaining migration milestones to owners, timing, evidence, and gates.
- Wave 6 status: completed `T11` MVP ADR freeze, which locks the LanceDB-first MVP vector path and blocks multi-backend drift during migration.
- Wave 7 status: completed `T12` retrieval V2 artifact/version/fallback contract, which separates retrieval fallback from AI-provider fallback and records the versioned artifact fields needed for migration gates.
- Wave 8 status: completed `T13a` draft Track B backlog, which buckets the remaining migration work into candidate waves without freezing the final dependency order yet.
- Wave 9 status: completed `T14` shadow parity framework, which defines the legacy-vs-candidate comparison model, required shadow artifact fields, and evidence outputs before canary or release promotion.
- Wave 10 status: completed `T15` canary and rollback criteria, plus the `TE4` failure-mode rehearsal sidecar, which hardens the operator decision path before default flips.
- Wave 11 status: completed `T13b` finalized migration dependency waves, which freeze the remaining Track B order after parity, rollback, and rehearsal evidence are all in place.
- Wave 12 status: completed `M1` Track B execution start gate, which blocks migration execution until the finalized waves and rollback criteria are signed off.
- Wave 13 status: completed `T16b` final integrated execution board, which now serves as the canonical execution board for both tracks.

## Public Interfaces / Contracts
- Public MCP tool contracts remain unchanged in Track A for `semantic_search` and `codebase_retrieval`.
- Queue/reject behavior changes are treated as internal policy unless already covered by existing typed error envelopes.
- Track B introduces internal versioned retrieval artifacts and fallback-separation policy, with no caller-visible contract changes until explicitly versioned.

## Dependency Graph

```text
T1  T2  T3  T4
 \  |  / \  |
  \ | /   \ |
    T5     T6
     \    / | \
      \  /  |  \
       T7   |   T8
        \   |  /  \
         \  | /    \
            T9      \
             \       \
              \       T10
               \     /  \
                \   /    \
                 T11      \
                  \ \      \
                   \ \      T16a
                    \ \
                     T12
                    /  \
                 T13a   T14
                    \     \
                     \     T15
                      \   /
                      T13b
                        |
                       M1
                        |
                       T16b

Edge tasks:
TE1 depends_on [T3,T5]
TE2 depends_on [T6,T8]
TE3 depends_on [T1,T8]
TE4 depends_on [T14,T15]
```

## Tasks

### T1: Contract + SLO Freeze
- **depends_on**: []
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `docs/BENCHMARKING.md`
- **description**: Freeze contract behavior and lock Track A SLO posture (`no-regression + reliability`) with explicit pass/fail criteria by tool and lane.
- **validation**: Contract parity fixture set defined and gate criteria documented.
- **status**: Completed
- **log**: Added compatibility tests that lock legacy/default `semantic_search` and `codebase_retrieval` behavior without changing runtime shapes.
- **files edited/created**: `tests/tools/search.test.ts`, `tests/tools/codebaseRetrieval.test.ts`

### T2: Benchmark Slice Matrix Freeze
- **depends_on**: []
- **location**: `docs/PERF_DATASET.md`, `docs/BENCHMARKING.md`
- **description**: Lock required slices: tool/profile/state/query-family/repo-size and replicate method (`>=3` for release decisions).
- **validation**: Matrix and replicate policy published as baseline protocol.
- **status**: Completed
- **log**: Expanded the benchmark protocol with required metadata, slice matrix, warm/cold/queued definitions, and repeatability rules.
- **files edited/created**: `docs/PERF_DATASET.md`, `docs/BENCHMARKING.md`

### T3: Telemetry Dictionary and Semantics
- **depends_on**: []
- **location**: `src/mcp/serviceClient.ts`, `docs/BENCHMARKING.md`
- **description**: Define metric names, dimensions, stage timing semantics, and reproducibility fields.
- **validation**: Metric dictionary and event schema version documented.
- **status**: Completed
- **log**: Added queue-wait, provider-execution, and total `searchAndAsk` histograms to the runtime plus matching docs and a queued-call test.
- **files edited/created**: `src/mcp/serviceClient.ts`, `tests/serviceClient.test.ts`, `docs/BENCHMARKING.md`

### T4: Rollout Governance Gate Template
- **depends_on**: []
- **location**: `docs/context-engine-improvement-plan.md`
- **description**: Define stage gates with numeric criteria, owner roles (`promote`, `abort`), and kill-switch/rollback evidence requirements.
- **validation**: Governance template includes thresholds, windows, and authority fields.
- **status**: Completed
- **log**: Added a reusable governance gate template with owner, numeric threshold, evidence bundle, freeze trigger, rollback trigger, and decision-rule guidance.
- **files edited/created**: `docs/BENCHMARKING_GATES.md`

### T5: Baseline Evidence Pack (Cold/Warm/Queued)
- **depends_on**: [T1, T2, T3]
- **location**: `docs/BENCHMARKING.md`, `scripts/ci/ws19-slo-gate.ts`
- **description**: Produce reproducible baseline evidence with required metadata and slice coverage.
- **validation**: Baseline artifacts complete and reproducible with required fields present.
- **status**: Completed
- **log**: Added required evidence fields, provenance nesting guidance, and queued-run metadata for reproducible baseline artifacts.
- **files edited/created**: `docs/BENCHMARKING.md`, `docs/plan-execution/retrieval-bottleneck-v2-baseline-pack.md`

### T6: Queue Policy Spec in Observe Mode
- **depends_on**: [T1, T3]
- **location**: `src/mcp/serviceClient.ts`
- **description**: Specify lane caps, fairness, timeout semantics, reject mode policy, and observe-first rollout.
- **validation**: Queue policy doc defines behavior under saturation without immediate default enforcement.
- **status**: Completed
- **log**: Documented observe/shadow/enforce queue rollout, added queue-policy flags, and covered observe-mode saturation behavior in runtime tests.
- **files edited/created**: `src/mcp/serviceClient.ts`, `tests/serviceClient.test.ts`, `docs/FLAG_REGISTRY.md`, `docs/ROLLOUT_RUNBOOK.md`

### T8: Track A CI Gates (Contract + Reliability + No-Regression)
- **depends_on**: [T1, T2, T3, T4, T5, T6]
- **location**: `scripts/ci/ws19-slo-gate.ts`, `docs/BENCHMARKING.md`
- **description**: Implement Track A gate package with explicit thresholds and reproducibility checks.
- **validation**: CI gate spec enforces required metrics and artifact completeness.
- **status**: Completed
- **log**: Hardened benchmark provenance and reproducibility checks across PR/nightly/release artifacts, including the raw benchmark emitter, and added missing-field regression coverage for the compare gate.
- **files edited/created**: `scripts/bench.ts`, `scripts/ci/bench-provenance.ts`, `scripts/ci/run-bench-suite.ts`, `scripts/ci/release-bench.ts`, `scripts/ci/bench-compare.ts`, `tests/ci/benchCompare.test.ts`

### T7: Track A Stabilization Tuning Backlog
- **depends_on**: [T5, T6]
- **location**: `src/internal/retrieval/retrieve.ts`, `src/mcp/serviceClient.ts`
- **description**: Prioritize fast defaults, bounded expansion/rerank, and timeout budget tuning using baseline evidence.
- **validation**: Backlog is ranked by latency impact/risk and mapped to Track A gates.
- **status**: Completed
- **log**: Added a prioritized Track A tuning backlog in the benchmarking docs, centered on bounded fan-out, timeout tuning, queue pressure, and repeatable slice rechecks.
- **files edited/created**: `docs/BENCHMARKING.md`

### T9: Track A Rollout Playbook (Light Shadow + Canary + Rollback)
- **depends_on**: [T4, T6, T7, T8]
- **location**: `docs/context-engine-improvement-plan.md`
- **description**: Define promotion/abort workflow for stabilization release with evidence bundle requirements.
- **validation**: Playbook includes numeric gates, minimum sample windows, and rollback trigger matrix.
- **status**: Completed
- **log**: Added and then tightened the Phase 9 Track A rollout playbook so promotion gates are anchored to `docs/BENCHMARKING_GATES.md` (PR/nightly/release), with explicit evidence-bundle requirements, minimum replicate windows, and rollback/kill-switch posture.
- **files edited/created**: `docs/context-engine-improvement-plan.md`

### T10: Full Gap Matrix (Implemented / Partial / Missing)
- **depends_on**: [T1, T2, T3, T4, T5, T6]
- **location**: `docs/context-engine-improvement-plan.md`, `docs/retrieval-slowness-final-plan.md`
- **description**: Build complete gap matrix with latency impact, risk, and confidence for all plan items.
- **validation**: Matrix covers all items and is decision-ready for architecture selection.
- **status**: Completed
- **log**: Added a phase-by-phase gap matrix snapshot covering Workstream 0 through Phase 10. The highest-impact missing pieces are still the V2 seam/flags, Tree-sitter chunking, FTS5 lexical indexing, a real vector backend/embedding runtime, and a true background incremental pipeline.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

### T10 Gap Matrix Snapshot

| Phase | Overall status | Already implemented | Still missing / highest impact |
| --- | --- | --- | --- |
| Workstream 0 | Partial | Repo-wide Codex guidance exists externally, and the repo already has skill scaffolding plus benchmark/contract docs. | Root `AGENTS.md` in-repo; the requested retrieval/eval skill packs and scripts. |
| Phase 1 | Partial | Contract-freeze tests, queue metrics, benchmark provenance, rollout gates, flags, and shadow compare are present. | `RetrievalProviderV2` / `IndexStoreV2` / `ChunkStoreV2` / `RerankerV2` / `SearchTelemetryV2`, exact v2 flags, and the full versioned artifact schema. |
| Phase 2 | Partial | Benchmark harness, holdout fixture packs, provenance checks, and quality-gate scripts already exist. | A fuller internal eval dataset and broader BEIR/Ragas-style loops with exact-symbol/file coverage. |
| Phase 3 | Missing | File-level indexing/watcher plumbing and incremental state exist. | Tree-sitter parser, chunk store, symbol graph, neighbor-chunk metadata, and chunk-level retrieval. |
| Phase 4 | Missing | Heuristic fallback keyword search exists. | SQLite FTS5, persistent lexical store, and index-aware boost tuning. |
| Phase 5 | Partial | Dense-index scaffolding and hash-based embeddings exist. | Qdrant/LanceDB backend, real embedding runtime, and true index-time embeddings. |
| Phase 6 | Partial | Hybrid fusion, rerank caps, and fail-open tests exist. | A real cross-encoder reranker and actual lexical/vector inputs from the new indexes. |
| Phase 7 | Partial | Index-state storage, skip-unchanged indexing, and background worker support exist. | A watcher/debounce pipeline, warm-load path, and true chunk/vector refresh pipeline. |
| Phase 8 | Partial | Intent heuristics and context-packing helpers exist. | A richer router and chunk-aware packing/provenance. |
| Phase 9 | Partial | Rollout docs, gates, flags, shadow compare, and kill-switch posture are present. | A runtime control plane for paired legacy-v2 shadow/canary traffic. |
| Phase 10 | Missing | Benchmark suites and decommission docs exist. | Retire the query-time hot path and legacy file-scan fallback, plus a tombstone/archive policy. |

Highest-impact gaps:
- Root repo-local `AGENTS.md` plus the requested Codex retrieval/eval skill packs.
- The V2 seam and exact v2/legacy flags needed for a true shadow migration path.
- Tree-sitter chunking and a chunk store, which are the biggest structural change still missing.
- A persistent FTS5 lexical index and a real vector backend/runtime.
- A true background incremental pipeline that keeps heavy work out of the search hot path.

### T11: MVP ADR Freeze (`LanceDB-first`)
- **depends_on**: [T10, T5, T8]
- **location**: `docs/context-engine-improvement-plan.md`
- **description**: Freeze one MVP architecture path and prohibit multi-backend drift during MVP.
- **validation**: Signed ADR includes rationale, tradeoffs, and non-goals.
- **status**: Completed
- **log**: Added an architecture decision record that freezes the MVP vector backend as LanceDB-first, defers Qdrant to a later post-MVP decision, and blocks dual-write, dual-read, or runtime backend switching during MVP.
- **files edited/created**: `docs/context-engine-improvement-plan.md`

### T12: Retrieval V2 Artifact/Version/Fallback Separation Spec
- **depends_on**: [T3, T4, T10, T11]
- **location**: `src/mcp/serviceClient.ts`, `docs/context-engine-improvement-plan.md`
- **description**: Define artifact versioning and explicit separation of retrieval fallback vs AI-provider fallback domains.
- **validation**: Spec includes compatibility rules, failure modes, and rollback semantics.
- **status**: Completed
- **log**: Added the Retrieval V2 artifact/fallback contract section to the improvement plan and synced the fallback-related flag registry so retrieval fallback, AI-provider admission, and shadow comparison remain distinct.
- **files edited/created**: `docs/context-engine-improvement-plan.md`, `docs/FLAG_REGISTRY.md`

### T13a: Track B Draft Execution Backlog
- **depends_on**: [T11, T12, T8]
- **location**: `docs/retrieval-slowness-final-plan.md`
- **description**: Create initial migration backlog with candidate task waves.
- **validation**: Draft backlog exists with dependency hypotheses and risk tags.
- **status**: Completed
- **log**: Added a draft Track B backlog that groups the remaining migration work into candidate waves, preserving the sequencing from parity evidence to rollback criteria to final wave freeze.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

#### Draft Track B Backlog (candidate only)

| Draft wave | Candidate tasks | Focus | Sequencing rationale |
| --- | --- | --- | --- |
| A | T14 | Shadow parity framework | Can run in parallel with T13a once T12 is complete; this defines the evidence shape before rollback criteria are finalized. |
| B | T15 | Canary and rollback criteria | Depends on the parity framework from T14 and the rollout posture already established in T9. |
| C | T13b | Finalized migration dependency waves | Freeze the executable migration wave order only after T13a, T14, and T15 are stable. |
| D | M1 | Track B execution start gate | Hard gate after T13b and T15 to prevent premature migration execution. |
| E | T16b | Final integrated execution board | Last integration pass once Track A and Track B are both closed and the execution gate is ready. |

This backlog is intentionally draft-only. It preserves sequencing and ownership boundaries for the remaining migration work without freezing the final dependency waves yet.

### T14: Migration Shadow Parity Framework Plan
- **depends_on**: [T3, T5, T9, T12]
- **location**: `docs/BENCHMARKING.md`, `docs/context-engine-improvement-plan.md`
- **description**: Define parity measurement framework for migration shadow runs.
- **validation**: Shadow plan includes overlap/error/latency parity criteria and evidence outputs.
- **status**: Completed
- **log**: Added the shadow parity framework to the benchmark and migration docs so legacy-vs-candidate comparison inputs, parity dimensions, required artifact fields, and required evidence outputs are explicit before canary or release promotion.
- **files edited/created**: `docs/BENCHMARKING.md`, `docs/context-engine-improvement-plan.md`

### T15: Migration Canary + Rollback Criteria Plan
- **depends_on**: [T14, T9]
- **location**: `docs/context-engine-improvement-plan.md`
- **description**: Define migration promotion/abort criteria with hard rollback drills before any default flip.
- **validation**: Canary and rollback criteria include threshold matrix and ownership.
- **status**: Completed
- **log**: Added the migration canary and rollback criteria section to the improvement plan, including entry conditions, promotion rules, rollback order, ownership, and the required artifact bundle for stage changes.
- **files edited/created**: `docs/context-engine-improvement-plan.md`

### T13b: Finalized Migration Dependency Waves
- **depends_on**: [T13a, T14, T15]
- **location**: `docs/retrieval-slowness-final-plan.md`
- **description**: Finalize executable migration waves after parity and rollback criteria are fixed.
- **validation**: Final wave plan has no unresolved dependencies.
- **status**: Completed
- **log**: Finalized the remaining Track B wave order after parity, rollback, and failure-mode rehearsal were in place, so the execution path is now frozen instead of draft-only.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

#### Finalized Migration Waves

| Sequence | Tasks | Entry condition | Exit condition |
| --- | --- | --- | --- |
| 1 | T15, TE4 | T14 and T9 complete | Canary criteria, rollback order, and failure-mode rehearsal locked |
| 2 | T13b | Sequence 1 complete | Remaining migration waves frozen |
| 3 | M1 | T13b complete | Track B execution start gate signed off |
| 4 | T16b | M1 complete and T7/T9 complete | Final integrated execution board published |

### T16a: Initial Execution Board
- **depends_on**: [T4, T10]
- **location**: `docs/retrieval-slowness-final-plan.md`
- **description**: Create initial owner/timeline/evidence board from governance + full gap matrix.
- **validation**: Board maps each milestone to owner and required artifact.
- **status**: Completed
- **log**: Added a compact execution board for the remaining migration milestones, with role placeholders, wave timing, evidence artifacts, and entry/exit gates so the next phases can be scheduled unambiguously.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

#### Initial Execution Board

| Milestone | Owner / role placeholder | Target wave / timing | Required evidence artifacts | Entry gate / dependency | Exit gate |
| --- | --- | --- | --- | --- | --- |
| T11 | Architecture lead | Wave 6, immediately after T10 | ADR freeze in `docs/context-engine-improvement-plan.md`; decision note | T10 gap matrix complete | LanceDB-first MVP frozen; no multi-backend drift |
| T12 | Retrieval runtime lead | Wave 7, after T11 | Retrieval V2 artifact/version/fallback spec | T11 complete | Separate retrieval fallback from AI-provider fallback |
| T13a | Program manager | Wave 8 prep, after T12 and T8 | Draft migration backlog with candidate waves | T12 and T8 complete | Backlog sorted by dependency and risk |
| T14 | Benchmark lead | Wave 8, in parallel with T13a | Shadow parity framework in `docs/BENCHMARKING.md` and `docs/context-engine-improvement-plan.md` | T3, T5, T9, and T12 complete | Overlap, error, and latency parity criteria defined |
| T15 | Rollout / release lead | Wave 9, after T14 | Canary and rollback criteria in `docs/context-engine-improvement-plan.md` | T14 and T9 complete | Promotion / abort thresholds and ownership defined |
| T13b | Migration lead | Wave 10 prep, after T13a, T14, and T15 | Finalized migration dependency waves | T13a, T14, and T15 complete | No unresolved dependencies remain |
| M1 | Program owner + release manager | Wave 10 gate | Start-gate checklist and signoff record | T13b and T15 complete | Migration execution blocked until start gate is signed off |
| T16b | Program owner + architecture lead | Wave 11, final integration pass | Final integrated execution board for both tracks | T7, T9, T13b, and T15 complete | End-to-end board includes schedule, owners, gates, and evidence expectations |

### M1: Track B Execution Start Gate
- **depends_on**: [T13b, T15]
- **location**: `docs/retrieval-slowness-final-plan.md`
- **description**: Hard gate that prevents migration execution before finalized waves and rollback criteria exist.
- **validation**: Gate checklist complete and signed off.
- **status**: Completed
- **log**: Added the Track B execution start gate so migration cannot start until the final wave order, rollback criteria, and signoff are all present.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

### T16b: Final Integrated Execution Board
- **depends_on**: [T7, T9, T13b, T15]
- **location**: `docs/retrieval-slowness-final-plan.md`
- **description**: Publish final end-to-end execution board for both tracks.
- **validation**: Final board includes schedule, owners, gates, and evidence expectations.
- **status**: Completed
- **log**: The initial execution board is now the canonical final board for both tracks, with the Track B wave order frozen and the execution start gate in place.
- **files edited/created**: `docs/retrieval-slowness-final-plan.md`

### TE1: Telemetry Data-Quality Gates
- **depends_on**: [T3, T5]
- **location**: `docs/BENCHMARKING.md`
- **description**: Add checks for missing/duplicate/out-of-order events and cardinality limits.
- **validation**: Data-quality gate definition and pass criteria documented.
- **status**: Completed
- **log**: Added telemetry data-quality gate guidance for missing, duplicate, out-of-order, and high-cardinality signals, with the metrics drop counter called out as a hard investigation trigger.
- **files edited/created**: `docs/BENCHMARKING.md`

### TE2: Queue Stress Edge-Case Suite
- **depends_on**: [T6, T8]
- **location**: `src/mcp/serviceClient.ts`
- **description**: Define stress scenarios for starvation, retry storms, cancellation propagation, and reject hint behavior.
- **validation**: Edge-case scenario set and expected outcomes documented.
- **status**: Completed
- **log**: Added a queue-pressure timeout-budget edge case that rejects too-small request budgets before provider execution and keeps the retry-storm path deterministic.
- **files edited/created**: `tests/serviceClient.test.ts`

### TE3: Compatibility Negative Tests Plan
- **depends_on**: [T1, T8]
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`
- **description**: Define negative compatibility scenarios for stale clients and unknown fields.
- **validation**: Negative test matrix documented and mapped to contract gate.
- **status**: Completed
- **log**: Existing compatibility tests already cover unknown legacy fields for `semantic_search` and unknown `response_version` fallback for `codebase_retrieval`, so no new runtime changes were needed.
- **files edited/created**: `tests/tools/search.test.ts`, `tests/tools/codebaseRetrieval.test.ts`

### TE4: Migration Failure-Mode Rehearsal Plan
- **depends_on**: [T14, T15]
- **location**: `docs/context-engine-improvement-plan.md`
- **description**: Define rehearsal scenarios for partial rollback, dual-read mismatch, replay, and downgrade.
- **validation**: Failure rehearsal checklist and pass criteria documented.
- **status**: Completed
- **log**: Added a failure-mode rehearsal plan that covers partial rollback, dual-read mismatch, replay, and downgrade scenarios before any default flip.
- **files edited/created**: `docs/context-engine-improvement-plan.md`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1, T2, T3, T4 | Immediately |
| 2 | T5, T6 | Wave 1 complete |
| 3 | T8, T7, TE1 | Wave 2 complete |
| 4 | T9, TE2, TE3 | T8 and T7 complete |
| 5 | T10 | T5 and T6 and governance complete |
| 6 | T11 | T10 complete |
| 7 | T12 | T11 complete |
| 8 | T13a, T14 | T12 complete |
| 9 | T15 | T14 and T9 complete |
| 10 | T13b, TE4, M1 | T13a and T15 complete |
| 11 | T16b | T7 and T9 and T13b and T15 complete |

## Test Plan and Scenarios
- Contract parity scenarios for `semantic_search` and `codebase_retrieval`, including empty-result and overload-envelope behavior.
- Benchmark scenarios sliced by tool/profile/state/query-family/repo-size with reproducibility metadata.
- Reliability scenarios covering timeout/error deltas, queue fairness, and saturation behavior.
- Rollout safety scenarios for shadow overlap, canary promotion windows, kill-switch activation, and rollback drills.
- Migration safety scenarios for fallback-domain separation, parity mismatch handling, mixed-version downgrade, and replay idempotency.

## Assumptions and Defaults
- `LanceDB-first` selected as MVP vector backend.
- Track A uses `no-regression + reliability`, not hard p95 improvement mandate.
- `p99` remains diagnostic until sample stability supports hard gating.
- No default flag flips before baseline, telemetry completeness, and gate evidence are satisfied.
- Full gap matrix is mandatory before migration build, but stabilization work is not blocked by migration implementation details.
