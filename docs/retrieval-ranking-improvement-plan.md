# Plan: Improve Retrieval Ranking Quality and Diagnostics

**Generated**: 2026-03-22

## Summary
The current retrieval stack is already benchmark-gated and reasonably strong, so this is an incremental quality pass, not a rewrite. The plan is to:
1. freeze a benchmark-backed baseline and calibrate the v3 heuristic weights offline,
2. add a gated transformer rerank path for genuinely hard queries,
3. surface shared ranking/fallback diagnostics without breaking existing outputs.

Calibration stays offline and benchmark-driven. Runtime behavior stays fail-open and backward compatible.

## Dependency Graph
```text
T1 ──┬── T2 ──┐
     └── T3 ──┼── T4 ──> T5
              └─────────┘
```

## Tasks

### T1: Freeze the calibration baseline and holdout split
- **depends_on**: []
- **location**: `docs/BENCHMARKING_GATES.md`, `config/ci/retrieval-quality-fixture-pack.json`, `artifacts/bench/retrieval-quality-report.json`
- **description**: Define the offline calibration workflow, including a frozen tuning slice and a separate holdout slice, and record the current approved baseline, fixture hashes, and weight snapshot before changing any ranking constants.
- **validation**: Baseline and holdout slices are explicit, reproducible, and documented; the current report remains the comparison point, not the tuning target.

### T2: Calibrate the v3 heuristic weights offline
- **depends_on**: [T1]
- **location**: `src/internal/retrieval/fusion.ts`, `src/internal/retrieval/rerank.ts`, `tests/internal/retrieval/fusion.test.ts`, `tests/internal/retrieval/rerank.test.ts`
- **description**: Replace ad hoc v3 constants with a benchmark-tuned weight table derived from the frozen calibration slice, while keeping v1/v2 behavior unchanged and avoiding any runtime-adaptive tuning.
- **validation**: Candidate weights improve or at least hold quality on the holdout slice, preserve deterministic ordering on easy queries, and do not regress the existing quality gate or latency thresholds.

### T3: Add a shared ranking diagnostics payload
- **depends_on**: [T1]
- **location**: `src/internal/retrieval/retrieve.ts`, `src/internal/handlers/retrieval.ts`
- **description**: Compute a shared, additive diagnostics payload in the retrieval layer with ranking mode, score spread, source consensus, and a fallback reason enum so downstream tools do not rebuild gate logic independently.
- **validation**: Diagnostics are backward compatible, optional, and populated from the retrieval layer rather than duplicated in MCP formatting code.

### T4: Gate transformer rerank for hard queries
- **depends_on**: [T2, T3]
- **location**: `src/internal/retrieval/retrieve.ts`, `src/internal/retrieval/rerank.ts`
- **description**: Invoke transformer rerank only when explicit hard-query signals are present, using a deterministic gate built from top1/top2 gap, topK score spread, source consensus, candidate count, and query profile. Keep it limited to balanced/rich paths and fail open on timeout or error.
- **validation**: Hard queries trigger rerank only when intended; fast/easy queries stay on the heuristic path; rerank timeout and fail-open behavior are covered.

### T5: Surface diagnostics and lock the regression gates
- **depends_on**: [T4]
- **location**: `src/mcp/tools/search.ts`, `src/mcp/tools/codebaseRetrieval.ts`, `tests/tools/search.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/ci/checkRetrievalQualityGate.test.ts`
- **description**: Expose the shared diagnostics payload in tool output as additive metadata, keep default output readable, and add regression gates for ranking quality, rerank latency, rerank invocation rate, and fail-open behavior.
- **validation**: Output schema stays backward compatible; diagnostics fields are populated when expected; benchmark gates cover `nDCG@10`, `MRR@10`, `Recall@50`, `unique_files@k`, easy-query overlap, rerank timeout rate, and p95 latency.

## Parallel Execution Groups
| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1 | Immediately |
| 2 | T2, T3 | T1 complete |
| 3 | T4 | T2 and T3 complete |
| 4 | T5 | T4 complete |

## Test Plan
- Run the frozen calibration slice against the current baseline and a candidate weight table.
- Validate the holdout slice with ranking metrics and easy-query no-regression checks.
- Verify transformer rerank gates on hard-query fixtures and does not trigger for easy queries.
- Verify fail-open on rerank timeout and rerank error.
- Verify tool outputs remain additive and readable.
- Gate on:
  - `nDCG@10`
  - `MRR@10`
  - `Recall@50`
  - `unique_files@k`
  - easy-query top-k overlap
  - rerank invocation rate
  - rerank timeout/fail-open rate
  - fast/balanced/rich p95 latency

## Assumptions
- Calibration is offline and benchmark-driven, not runtime-adaptive.
- Diagnostics are additive and must not break existing `semantic_search` or `codebase_retrieval` contracts.
- The hard-query gate is only for balanced/rich retrieval paths, not the fast path.
- The existing passing quality gate is the baseline to beat, not evidence that ranking is perfect.
