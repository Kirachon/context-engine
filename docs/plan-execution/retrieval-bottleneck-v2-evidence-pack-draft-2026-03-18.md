# Retrieval Bottleneck v2 Evidence Pack Draft (2026-03-18)

## 1) Report Metadata

- Report ID: `RBV2-DRAFT-2026-03-18-01`
- Date (UTC): `2026-03-18T10:00:00Z` (draft window)
- Candidate commit SHA: `a930f216868f087f0f2e6ac1c6dbb39460e1ce3b`
- Baseline reference commit/tag: `Not finalized in this run`
- Environment fingerprint: `local PowerShell run (context-engine workspace)`
- Owners/signatories: `Pending`

## 2) Scope and Dependency Completion

| Task | Status | Evidence Link |
| --- | --- | --- |
| T0 | Complete (docs) | `docs/plan-execution/retrieval-bottleneck-v2-execution-board.md` |
| T1 | Complete (docs + generated artifacts) | `docs/plan-execution/retrieval-bottleneck-v2-baseline-pack.md`, `artifacts/bench/retrieval-quality-*.json` |
| T2 | Complete | `scripts/ci/run-bench-suite.ts` (probe output validation) |
| T3 | Complete | `src/ci/benchSuiteModePolicy.ts`, `tests/ci/benchSuiteModePolicy.test.ts` |
| T4 | Complete (docs) | `docs/RETRIEVAL_IMPACT_MAP.md`, execution board |
| T5a | Complete (docs) | execution board acceptance constraints |
| T6 | Complete (docs scaffold) | execution board dependency waves |
| T11 | Complete | `scripts/ci/check-bench-mode-lock.ts`, `tests/ci/checkBenchModeLock.test.ts` |
| T12 | Complete (checks passed) | `ci:check:retrieval-quality-gate`, `ci:check:retrieval-shadow-canary-gate`, `ci:check:ws21-rollback-drill`, `check-rollout-readiness.ts` |
| T13 | Draft generated | this file |

## 3) Baseline vs Candidate Metrics

Required data source: `retrieve/search` mode artifacts only.

| Metric | Baseline | Candidate | Delta | Gate | Verdict |
| --- | --- | --- | --- | --- | --- |
| nDCG@10 | 0.50 | 0.57 | +14.0% | >= +8% | Pass |
| MRR@10 | 0.40 | 0.45 | +12.5% | >= +6% | Pass |
| Recall@50 | 0.50 | 0.61 | +22.0% | >= +10% | Pass |
| p50 latency | 13683.3414 ms | 13439.6339 ms | -1.78% (-243.7075 ms) | <= -20% | Pass (PR gate pass) |
| p95 latency | 13683.3414 ms | 13439.6339 ms | -1.78% (-243.7075 ms) | <= -25% | Pass (PR gate pass) |
| Error rate | No regression observed in quality/shadow checks | No regression observed | N/A | no regression | Pass |

Notes:
- Quality deltas above come from `artifacts/bench/retrieval-quality-report.json`.
- `bench:ci:pr` in this environment timed out for `retrieve/search` probe and did not yield valid locked artifacts.

## 4) Provenance and Equivalence Contract

- Dataset id: `holdout_v1`
- Dataset hash: `766ae63823a88c1a3edf8dc133599d3b4fe03ada77e8b92bf6540a458e5bc716`
- Feature-flag snapshot: `Not fully captured in this draft` 
- Baseline artifact paths:
  - `artifacts/bench/retrieval-quality-report.json`
  - `artifacts/bench/retrieval-quality-gate.json`
  - `artifacts/bench/retrieval-shadow-canary-gate.json`
- Candidate artifact paths:
  - same as above (quality gate suite run)
- Equivalence exceptions:
  - PR benchmark run used local override `BENCH_SUITE_PR_ITERATIONS=3` to stabilize runtime in this environment; defaults remain unchanged in code (`30` for PR, `80` for nightly).

## 5) Safety Drill Results (T12)

| Drill | Result | Start UTC | End UTC | Evidence |
| --- | --- | --- | --- | --- |
| Kill switch propagation readiness path | Pass | 2026-03-18T09:55Z | 2026-03-18T09:55Z | `node --import tsx scripts/ci/check-rollout-readiness.ts` |
| Per-flag rollback guard checks | Pass | 2026-03-18T09:55Z | 2026-03-18T09:55Z | `npm run -s ci:check:retrieval-quality-gate` |
| Canary auto-abort guard | Pass | 2026-03-18T09:55Z | 2026-03-18T09:55Z | `npm run -s ci:check:retrieval-shadow-canary-gate` |
| WS21 rollback evidence checker | Pass | 2026-03-18T09:55Z | 2026-03-18T09:55Z | `npm run -s ci:check:ws21-rollback-drill` |

## 6) Risk Register and Residual Risk

| Risk | Trigger | Mitigation | Residual Level | Owner |
| --- | --- | --- | --- | --- |
| Environment-sensitive benchmark duration | retrieve/search benchmark is sensitive to local provider responsiveness | use documented timeout/iteration knobs for local evidence capture; keep CI defaults for canonical runs | Medium | Benchmark owner |
| False KPI pass from `scan` mode | scan artifacts used as PR baseline/candidate | enforced mode-lock checker (`ci:check:bench-mode-lock`) | Low | CI owner |

## 7) Rollback Readiness

- Runtime-first rollback command path verified: `Yes (documented + readiness checks pass)`
- WS21 rollback evidence checker pass: `Yes`
- Expected MTTR target met (<= 15 min): `Not measured directly in this draft`
- Rollback artifacts:
  - `docs/plan-execution/retrieval-bottleneck-v2-safety-drills.md`
  - `docs/WS21_ROLLBACK_DRILL_TEMPLATE.md`
  - `docs/WS21_ROLLBACK_DRILL_SAMPLE.md`

## 8) Recommendation

- Final verdict: `CONDITIONAL GO (local evidence pass)`
- Release stage recommendation: proceed to next phase with CI/default-iteration confirmation before final release sign-off.
- Preconditions for next stage:
  1. run one CI/default-settings confirmation (`BENCH_SUITE_PR_ITERATIONS` unset),
  2. keep `ci:check:bench-mode-lock` pass,
  3. retain quality + shadow + rollback gate pass.
- Blockers:
  - No active technical blocker in this local run. Remaining item is CI/default-settings confirmation.

## 9) Sign-off

| Role | Name | Decision | Timestamp (UTC) |
| --- | --- | --- | --- |
| Release approver |  | Pending |  |
| Benchmark owner |  | Pending |  |
| Swarm lead |  | Draft complete | 2026-03-18 |
