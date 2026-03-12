# Local-Native Search Quality Upgrade Plan

Last updated: 2026-03-11  
Owner: Context Engine team  
Status: Complete

## Summary
Upgrade Context Engine search quality without reintroducing legacy provider dependency by evolving the current `local_native` pipeline into a staged retrieval system:

1. candidate generation
2. score fusion
3. reranking

This plan keeps current parity/reliability protections while adding judged quality evaluation, explicit rollout gates, and rollback safety.

## Scope and Defaults
- Keep `local_native` as the only active runtime path.
- Keep existing profiles: `fast`, `balanced`, `rich`.
- New quality features must be additive and feature-flagged.
- Preserve external MCP contracts unless optional diagnostics are added.

## Phase Plan

### Phase 0: Baseline and Quality Gate Setup
- Freeze a judged retrieval dataset across core journeys.
- Add quality metrics artifacts (`nDCG@10`, `MRR@10`, `Recall@50`, latency/resource).
- Archive baseline results for before/after comparisons.

### Phase 1: Local Lexical + Fusion Upgrade
- Add BM25-like lexical retrieval candidate generation.
- Normalize and fuse semantic + lexical scores.
- Improve snippet/chunk boundaries for stable ranking inputs.
- Keep deterministic ordering and tie-break behavior.

### Phase 2: Dense Retrieval Index (Pluggable)
- Add embeddings-backed dense retrieval behind an interface.
- Persist index artifacts and support incremental refresh.
- Fuse dense + lexical candidates under profile controls.

### Phase 3: Optional Reranker
- Add top-N reranker with strict latency budget and fail-open fallback.
- Keep `fast` profile conservative by default.

### Phase 4: Rollout and Enforcement
- Stage progression: `baseline -> observe -> shadow -> enforce -> default-on`.
- Maintain kill switches and rollback drill proof before default-on.

## Acceptance Gates
- Quality:
  - `nDCG@10` >= +12% vs baseline
  - `MRR@10` >= +10% vs baseline
  - `Recall@50` >= +20% vs baseline
- Parity safety:
  - existing parity suite >= 99.5%
  - no P0/P1 regressions
- Latency:
  - `fast` p95 <= 350ms
  - `balanced` p95 <= 700ms
  - `rich` p95 <= 1200ms
- Resources:
  - dense index size <= 2.5x source text bytes
  - query-time RSS growth <= 25%
- Stability:
  - soak error rate <= 0.5%
  - rollback drill <= 15 minutes

## Progress Tracker

### Phase 0
- [x] Add judged retrieval fixture pack.
- [x] Add quality report generator and gate checker.
- [x] Generate frozen baseline artifacts.
- [x] Record baseline receipts in tracker docs.

### Phase 1
- [x] Implement lexical candidate generator.
- [x] Implement score normalization + fusion.
- [x] Integrate fusion path into retrieval pipeline.
- [x] Add and pass unit/integration tests for fusion ordering.

### Phase 2
- [x] Define dense index and embedding provider interfaces.
- [x] Implement local persisted dense index path.
- [x] Add incremental refresh/version linkage to index state.
- [x] Add dense + lexical hybrid candidate fusion tests.

### Phase 3
- [x] Implement optional top-N reranker path.
- [x] Add timeout/fail-open fallback behavior.
- [x] Add profile-based reranker controls and tests.

### Phase 4
- [x] Run observe stage with evidence receipts.
- [x] Run shadow stage and verify gate thresholds.
- [x] Run enforce stage and rollback drill.
- [x] Approve default-on rollout after gate pass.

Latest stage receipt: [`docs/rollout-evidence/2026-03-11/observe-shadow-enforce-default-on-receipt.md`](./rollout-evidence/2026-03-11/observe-shadow-enforce-default-on-receipt.md)
Current status: observe/shadow/enforce/default-on all passed on 2026-03-11 (`overall_score=100.00` on strict parity gate).

## Final Outcomes (2026-03-11)
- Strict parity gate: `artifacts/bench/legacy-capability-parity-gate.json` -> `status=pass`, `overall_score=100.00`.
- Parity report: `artifacts/bench/retrieval-parity-pr.json` -> all listed evaluations passed.
- Quality report: `artifacts/bench/retrieval-quality-report.json` -> pass rate `100%` (10/10).
- Quality uplift vs baseline:
  - `nDCG@10`: `+14.0%`
  - `MRR@10`: `+12.5%`
  - `Recall@50`: `+22.0%`

## Plain-Language Meaning
- Users see useful results higher in the list more often.
- The first "good answer" appears sooner.
- More relevant matches are captured in the top results window.

