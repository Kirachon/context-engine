# Context-Engine Enhancement Decision Package

Date: 2026-03-12
Branch: feat/local-native-legacy-provider-exit
Commit: 6780cb3
Decision target: Approve/defer/reject next enhancement backlog for the next 90 days.
Decision owners: Engineering Lead (DRI), Product Lead (backup)
Decision SLA: 3 business days after package review

## Executive Snapshot
Top priorities for the next cycle:
1. Stabilize enhance_prompt runtime behavior and observability in production-like flows.
2. Add process guardrails to prevent MCP runtime drift and stale process conflicts.
3. Tighten docs + contract governance to prevent argument/schema drift.
4. Raise retrieval quality governance from one-time pass to rolling monitored signal.
5. Improve roadmap execution realism with owner capacity and dependency gates.

Expected outcomes (90-day):
- Lower transient enhancement failures and faster triage.
- Fewer runtime mismatch incidents between source and active MCP process.
- Consistent docs/contracts with reduced onboarding confusion.
- Sustained retrieval quality and parity signal confidence.

## Method and Scope
In scope:
- Repository-level reliability, retrieval quality governance, performance, DX, review/governance, docs/ops.
- Evidence from current repo state, test runs, and benchmark artifacts.

Out of scope:
- Cross-repo product feature redesign.
- Infrastructure changes outside this repository.

Evidence freshness rule:
- Evidence must come from current branch/commit snapshot or explicitly timestamped runtime observation.

Unknowns policy:
- Any unproven assumption is marked `Not specified in codebase`.

Execution baseline freeze (T0):
- Baseline references for R1/R2/R3/R8 state, benchmark artifacts, and CI gate outputs are frozen for this execution in `artifacts/governance/t0-prereq-evidence-freeze-manifest-2026-03-12.json`.
- Until T16 closeout, scoring and status reconciliation must use the frozen references in that manifest to prevent drift.

## Evidence Summary
- `artifacts/bench/legacy-capability-parity-gate.json` -> strict parity score 100, gate pass.
- `artifacts/bench/retrieval-quality-report.json` -> pass rate 1.0; nDCG +14, MRR +12.5, Recall +22.
- `tests/tools/enhance.test.ts` -> 38/38 pass (latest local run).
- `src/internal/handlers/enhancement.ts` -> enhanced contract and typed transient errors are implemented.
- `src/mcp/tools/enhance.ts` -> JSON envelope + structured text handling implemented.
- Runtime observation (2026-03-12): prior stale MCP processes caused behavior mismatch; restart resolved runtime sync issue.
- `docs/R4_WEEKLY_TREND_CONTRACT.md`, `scripts/ci/generate-weekly-retrieval-trend-report.ts`, `scripts/ci/check-weekly-retrieval-trend-report.ts`, `.github/workflows/perf_gates.yml` -> weekly R4 trend contract + automation/check path implemented.
- `docs/R5_ENHANCEMENT_ERROR_TAXONOMY_CONTRACT.md`, `scripts/ci/generate-enhancement-error-taxonomy-report.ts`, `scripts/ci/check-enhancement-error-taxonomy-report.ts` -> deterministic R5 taxonomy/report contract + checker implemented.
- `docs/R6_EXECUTION_BOARD_MODEL.md`, `docs/templates/r6-execution-board.template.json`, `scripts/ci/check-r6-execution-board.ts` -> R6 board schema + validator implemented.
- `docs/R7_SPLIT_RISK_REGISTER_CONTRACT.md`, `docs/templates/r7-delivery-risk-register.template.json`, `docs/templates/r7-runtime-risk-register.template.json`, `scripts/ci/check-r7-split-risk-registers.ts` -> R7 split-register contracts/templates/checker implemented.
- `docs/R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT.md`, `scripts/ci/check-r8-fallback-free-runbook-drill.ts`, `scripts/ci/check-rollout-readiness.ts`, `docs/ROLLOUT_RUNBOOK.md` -> R8 fallback-free drill contract and readiness-gate integration implemented.
- `docs/R9_RECOMMENDATION_IMPORT_SCHEMA.md`, `docs/templates/r9-recommendation-import.template.csv`, `docs/templates/r9-recommendation-import.template.md`, `scripts/ci/check-r9-recommendation-import.ts` -> R9 import schema/templates/checker implemented.
- `docs/R10_PILOT_LANE_KPI_ABORT_CONTRACT.md`, `docs/R10_FAST_FAIL_PILOT_LANE_PROTOCOL.md` -> R10 KPI/abort contract and final pilot protocol implemented.

## Locked Scoring Rubric
Scales (1-5):
- Impact: user/business value if solved
- Urgency: time sensitivity
- Confidence: evidence confidence
- Effort: delivery complexity
- Risk: delivery/runtime risk

Formula:
Priority Score = (Impact * Urgency * Confidence) / (Effort * Risk)

Tie-breakers (in order):
1. Dependency unblock value
2. Governance/reliability criticality
3. Time-to-first-signal

## 6-Domain Audit Matrix
| Domain | Current state | Key finding | Confidence | Blast radius |
|---|---|---|---|---|
| Reliability | Good but runtime-process sensitive | Stale MCP process mismatch can surface old behavior | Medium | Medium |
| Retrieval Quality | Strong benchmark signal | Quality gates pass, needs rolling trend monitoring | High | High |
| Performance | Acceptable in current gates | No continuous SLO dashboard in package | Medium | Medium |
| DX | Improved enhancer structure | Documentation and contract drift remains risk | High | Medium |
| Governance/Review | Strong toolset | Need explicit recurring gate cadence and decision log discipline | Medium | High |
| Docs/Ops | Improved but uneven | Client setup and enhancement contract docs still need synchronized governance checks | High | Medium |

## Prioritized Recommendations
Required fields included: owner, due window, dependencies, metrics, validation, rollback.

| ID | Recommendation | Domain | Evidence | Impact | Urgency | Confidence | Effort | Risk | Score | Owner | Due window | Dependencies | Success metric (baseline -> target) | Validation | Rollback/Abort |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|---|
| R1 | Add MCP single-instance/process-health guard script and runbook | Reliability | runtime observation + MCP process drift | 5 | 5 | 3 | 2 | 2 | 18.75 | Platform Eng | 0-30 days | none | duplicate active context-engine MCP processes: unknown -> 0 recurring incidents/month | scripted process check before release + weekly run | disable guard script and revert to manual process control |
| R2 | Add CI smoke test for enhance_prompt contract (sections + typed transient error) | Governance/DX | `src/internal/handlers/enhancement.ts`, `tests/tools/enhance.test.ts` | 5 | 4 | 5 | 2 | 2 | 25.00 | QA Lead | 0-30 days | R1 recommended | contract regression escapes: unknown -> 0 on main branch | CI stage with pass/fail gates | revert smoke gate requirement if flaky, keep unit tests |
| R3 | Add docs-governance check to fail on stale enhance_prompt arguments/examples | Docs/Ops | `docs/archive/EXAMPLES.md`, `src/mcp/tools/enhance.ts` | 4 | 4 | 4 | 2 | 2 | 16.00 | DevEx | 0-30 days | none | docs/implementation drift findings per release: >0 -> 0 | check script in CI + docs diff review | disable doc gate if false positives exceed threshold |
| R4 | Establish rolling weekly quality/parity trend report (not just point-in-time) | Retrieval Quality | `docs/R4_WEEKLY_TREND_CONTRACT.md`, `scripts/ci/generate-weekly-retrieval-trend-report.ts`, `scripts/ci/check-weekly-retrieval-trend-report.ts`, `.github/workflows/perf_gates.yml` | 5 | 4 | 4 | 3 | 2 | 13.33 | Search Owner | 31-60 days (foundation complete 2026-03-12) | R2 (met) | accepted archived weekly periods in `artifacts/bench/archive/r4-weekly/`: 1 (`2026-W11`) -> >=4 PASS periods per rolling 30 days; duplicate-period conflicts: 0 maintained | `npm run -s ci:generate:weekly-retrieval-trend-report && npm run -s ci:check:weekly-retrieval-trend-report` | disable scheduled weekly run in `.github/workflows/perf_gates.yml` and run checker manually until archive stability is restored |
| R5 | Add enhancement error taxonomy dashboard counters to release review checklist | Reliability/Ops | `docs/R5_ENHANCEMENT_ERROR_TAXONOMY_CONTRACT.md`, `scripts/ci/generate-enhancement-error-taxonomy-report.ts`, `scripts/ci/check-enhancement-error-taxonomy-report.ts`, `src/internal/handlers/enhancement.ts` | 4 | 4 | 4 | 3 | 2 | 10.67 | SRE/Platform | 31-60 days (foundation complete 2026-03-12) | R2 (met) | release windows with taxonomy artifact `status=PASS` and `summary.threshold_result=PASS`: 0 -> 100%; `unknown_code_count` and `malformed_event_count`: 0 maintained | `npm run -s ci:check:enhancement-error-taxonomy-report` | run checker in advisory mode (non-blocking) and fall back to manual typed-error review until thresholds are recalibrated |
| R6 | Add dependency-aware 30/60/90 execution board with owner-capacity WIP caps | Governance | `docs/R6_EXECUTION_BOARD_MODEL.md`, `docs/templates/r6-execution-board.template.json`, `scripts/ci/check-r6-execution-board.ts` | 4 | 3 | 4 | 2 | 2 | 12.00 | Eng Lead | 0-30 days (foundation complete 2026-03-12) | none | weekly board validation passes: 0 -> 1 PASS/week; unresolved dependency/cap violations in board checks: unknown -> 0 | `npm run -s ci:check:r6-execution-board` | temporarily remove blocking enforcement and require explicit override log entries until board data quality is corrected |
| R7 | Split risk tracking into delivery-risk and runtime-risk registers | Governance/Ops | `docs/R7_SPLIT_RISK_REGISTER_CONTRACT.md`, `docs/templates/r7-delivery-risk-register.template.json`, `docs/templates/r7-runtime-risk-register.template.json`, `scripts/ci/check-r7-split-risk-registers.ts` | 4 | 3 | 4 | 2 | 2 | 12.00 | PM + Eng Lead | 0-30 days (foundation complete 2026-03-12) | R6 | weekly split-register checks with valid cadence and unique IDs: 0 -> 1 PASS/week; stale review-date violations: unknown -> 0 | `npm run -s ci:check:r7-split-risk-registers` | merge to temporary single-register operating view while keeping templates as source-of-truth and re-enable split gate after remediation |
| R8 | Add fallback-free enhancement runbook for transient upstream incidents | Reliability/DX | `docs/R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT.md`, `scripts/ci/check-r8-fallback-free-runbook-drill.ts`, `scripts/ci/check-rollout-readiness.ts`, `docs/ROLLOUT_RUNBOOK.md` | 4 | 4 | 4 | 2 | 2 | 16.00 | Support/DevEx | 0-30 days (foundation complete 2026-03-12) | R2 (met) | valid R8 drill artifacts passing checker: 0 -> >=1 PASS drill per 30 days; readiness runs with `--r8-drill-artifact` failing required-field/precedence checks: unknown -> 0 | `node --import tsx scripts/ci/check-r8-fallback-free-runbook-drill.ts --drill-artifact <path>` and `node --import tsx scripts/ci/check-rollout-readiness.ts --r8-drill-artifact <path>` | execute readiness without `--r8-drill-artifact` (optional path) during incident stabilization, while keeping direct R8 checker required for closeout evidence |
| R9 | Add recommendation import template (CSV/MD) for backlog ingestion | DX | `docs/R9_RECOMMENDATION_IMPORT_SCHEMA.md`, `docs/templates/r9-recommendation-import.template.csv`, `docs/templates/r9-recommendation-import.template.md`, `scripts/ci/check-r9-recommendation-import.ts` | 3 | 3 | 4 | 2 | 1 | 18.00 | PMO/DevEx | 31-60 days (foundation complete 2026-03-12) | R6 (met for board/dependency conventions) | planning cycles with both CSV+MD import templates passing schema/dependency checks: 0 -> 100%; duplicate/self/unknown dependency rows accepted: unknown -> 0 | `npm run -s ci:check:r9-recommendation-import` | fall back to markdown-only intake and run import checker as advisory until registry/dependency mapping is clean |
| R10 | Introduce fast-fail pilot lane for top 1-2 strategic items before broad rollout | Governance/Delivery | `docs/R10_PILOT_LANE_KPI_ABORT_CONTRACT.md`, `docs/R10_FAST_FAIL_PILOT_LANE_PROTOCOL.md` | 4 | 3 | 3 | 3 | 2 | 6.00 | Eng Lead | 61-90 days | R4,R5,R6,R7,R8,R9 | decision checkpoints with complete payload (`decision`, `kpi_results`, `abort_trigger_ids`, `evidence_refs`): 0 -> 100%; no-signal timeout abort at day 10 when evidence is incomplete: not exercised -> enforced in first pilot | weekly pilot checkpoint audit against `docs/R10_FAST_FAIL_PILOT_LANE_PROTOCOL.md` Sections 4-6 with evidence refs from R4/R5/R6/R7/R8/R9 artifacts/checkers | on any abort trigger, execute `STOP` handoff per protocol Section 6 (set `CE_ROLLOUT_KILL_SWITCH=true`, freeze promotion, produce rollback packet) |

## Prioritization View
Top 5 by score and tie-breakers:
1. R2 (contract smoke gate)
2. R1 (single-instance/process health guard)
3. R9 (backlog import template)
4. R3 (docs governance check)
5. R8 (fallback-free incident runbook)

## Dependency Map
- R4 foundation (T2) is complete and now depends operationally on recurring weekly archive/check cadence; upstream dependency R2 is met.
- R5 foundation (T4) is complete and depends operationally on release-window taxonomy report generation/check execution; upstream dependency R2 is met.
- R6 (T6) and R7 (T8) foundations are complete; R7 operational cadence remains linked to R6 board governance and owner review rhythm.
- R8 foundation (T12) is complete; ongoing readiness evidence depends on periodic drill artifacts and optional readiness-gate invocation with `--r8-drill-artifact`.
- R9 foundation (T10) is complete and depends on R6 conventions for dependency references and weekly planning ingestion.
- R10 protocol (T13b) is complete but execution remains blocked until operational evidence accumulates from R4/R5/R6/R7/R8/R9 checks, then T15 verification matrix and T16 decision closeout.

## 30/60/90 Roadmap (Dependency-Aware)
### Wave 1 (0-30 days)
- R1, R2, R3 plus completed foundations for R6 (T6), R7 (T8), R8 (T12)
Entry criteria:
- Owners assigned
- Baseline metrics recorded (or explicitly marked unknown)
Exit gate:
- Evidence Gate pass + Wave 1 recommendation rows contain complete validation/rollback fields and checker entrypoints

### Wave 2 (31-60 days)
- R4, R5, R9 operational cadence (automation/checker foundations completed via T2/T4/T10)
Entry criteria:
- Wave 1 gate pass
- recurring artifact generation and checker cadence running for R4/R5/R9
Exit gate:
- Prioritization Gate pass + evidence accumulation sufficient for R10 pilot entry (at least two weekly R4 periods, fresh R5 report, current R6/R7/R9 passes, and one valid R8 drill)

### Wave 3 (61-90 days)
- R10 pilot execution and closeout
Entry criteria:
- Wave 2 outcomes reviewed with required R4/R5/R6/R7/R8/R9 evidence pack
- pilot success criteria and abort criteria approved in `docs/R10_PILOT_LANE_KPI_ABORT_CONTRACT.md`
Exit gate:
- decision log updated with continue/defer/stop outcome after T15 verification matrix and T16 recalibration closeout

WIP/capacity defaults:
- Max 3 parallel recommendation implementations per wave unless incident priority overrides.

De-scope triggers:
- Missing owner for >5 days
- No measurable baseline available by midpoint
- dependency blocker unresolved for one full sprint

## Risk Registers
### Delivery Risk Register
| Risk | Likelihood | Impact | Trigger | Mitigation | Contingency owner | Review date |
|---|---|---|---|---|---|---|
| Overloaded roadmap execution | Medium | High | >3 active items stalled | enforce WIP cap + dependency-first sequencing | Eng Lead | weekly |
| Scoring inconsistency | Medium | Medium | top-5 varies materially across reviewers | calibration pass + locked rubric | PM/Eng Lead | per wave |
| Documentation governance fatigue | Low | Medium | repeated false positives in doc gate | tune rules and allow temporary bypass with expiry | DevEx | biweekly |

### Runtime/Operational Risk Register
| Risk | Likelihood | Impact | Trigger | Mitigation | Contingency owner | Review date |
|---|---|---|---|---|---|---|
| MCP stale process mismatch | Medium | High | behavior differs from source/tested contract | process-health guard + restart runbook | Platform Eng | weekly |
| Transient upstream enhancement failures | Medium | Medium | surge in TRANSIENT_UPSTREAM errors | retry guidance + incident runbook + telemetry review | SRE | weekly |
| Quality signal drift | Low | High | parity/quality trend regresses over 2 snapshots | weekly trend gate + investigation ticket | Search Owner | weekly |

## Verification Checklist
Per recommendation, verify:
- evidence reference present
- owner + due window assigned
- baseline and target metric defined
- validation command/process defined
- rollback/abort plan defined
- dependency and risk entries recorded

Global verification:
- Gate A (Evidence Gate): PASS/FAIL
- Gate B (Prioritization Gate): PASS/FAIL
- Unknowns register reviewed by decision owners

## Unknowns Register
- Current monthly incident baseline for MCP stale-process mismatch: Not specified in codebase.
- Current backlog import cycle-time baseline: Not specified in codebase.
- Team parallel capacity by role for next 90 days: Not specified in codebase.

## Gate Results (Final Closeout)
- Evidence Gate: PASS (validated by `artifacts/governance/r4-r10-verification-matrix-2026-03-12.md`)
- Prioritization Gate: PASS (formula + tie-breakers locked; feasibility assumptions documented)

## Decision Log
| Date | Item | Decision | Decider | Rationale |
|---|---|---|---|---|
| 2026-03-12 | Enhancement decision package v1 | Execution closeout complete, pending formal approver sign-off | Engineering Lead (pending) | R4-R10 artifacts/checkers implemented and T15 verification matrix passed without blocking failures |
| 2026-03-12 | Optional sensitivity analysis dashboarding | Deferred | Engineering Lead (pending) | nice-to-have after core wave stabilization |
