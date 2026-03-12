# Context-Engine Enhancement Decision Package

Date: 2026-03-12
Branch: feat/local-native-auggie-exit
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

## Evidence Summary
- `artifacts/bench/auggie-capability-parity-gate.json` -> strict parity score 100, gate pass.
- `artifacts/bench/retrieval-quality-report.json` -> pass rate 1.0; nDCG +14, MRR +12.5, Recall +22.
- `tests/tools/enhance.test.ts` -> 38/38 pass (latest local run).
- `src/internal/handlers/enhancement.ts` -> enhanced contract and typed transient errors are implemented.
- `src/mcp/tools/enhance.ts` -> JSON envelope + structured text handling implemented.
- Runtime observation (2026-03-12): prior stale MCP processes caused behavior mismatch; restart resolved runtime sync issue.

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
| R3 | Add docs-governance check to fail on stale enhance_prompt arguments/examples | Docs/Ops | `EXAMPLES.md`, `src/mcp/tools/enhance.ts` | 4 | 4 | 4 | 2 | 2 | 16.00 | DevEx | 0-30 days | none | docs/implementation drift findings per release: >0 -> 0 | check script in CI + docs diff review | disable doc gate if false positives exceed threshold |
| R4 | Establish rolling weekly quality/parity trend report (not just point-in-time) | Retrieval Quality | `artifacts/bench/*` parity + quality reports | 5 | 4 | 4 | 3 | 2 | 13.33 | Search Owner | 31-60 days | R2 | trend snapshots published weekly: 0 -> 4 per month | scheduled CI + artifact archive check | revert schedule to biweekly if CI cost too high |
| R5 | Add enhancement error taxonomy dashboard counters to release review checklist | Reliability/Ops | typed errors in enhancement handler | 4 | 4 | 4 | 3 | 2 | 10.67 | SRE/Platform | 31-60 days | R1 | transient/auth/quota breakdown visibility: none -> release checklist coverage 100% | telemetry extraction + release signoff | revert to manual log review if instrumentation blocked |
| R6 | Add dependency-aware 30/60/90 execution board with owner-capacity WIP caps | Governance | roadmap risk from prior waves | 4 | 3 | 4 | 2 | 2 | 12.00 | Eng Lead | 0-30 days | none | roadmap slippage: unknown -> <20% slip | weekly board review with WIP cap | drop WIP cap if it blocks critical incidents |
| R7 | Split risk tracking into delivery-risk and runtime-risk registers | Governance/Ops | current combined risk narrative | 4 | 3 | 4 | 2 | 2 | 12.00 | PM + Eng Lead | 0-30 days | none | high-risk items with owner+trigger+contingency: partial -> 100% | weekly risk review | merge registers if overhead outweighs value |
| R8 | Add fallback-free enhancement runbook for transient upstream incidents | Reliability/DX | transient behavior now explicit | 4 | 4 | 4 | 2 | 2 | 16.00 | Support/DevEx | 0-30 days | R2 | mean time to identify incident class: unknown -> <15 min | tabletop scenario + incident drill | revert to generic runbook if adoption low |
| R9 | Add recommendation import template (CSV/MD) for backlog ingestion | DX | current manual translation burden | 3 | 3 | 4 | 2 | 1 | 18.00 | PMO/DevEx | 31-60 days | R6 | backlog import cycle time: unknown -> -30% | trial with one planning cycle | revert to markdown-only if tool friction high |
| R10 | Introduce fast-fail pilot lane for top 1-2 strategic items before broad rollout | Governance/Delivery | risk of large bets without early signal | 4 | 3 | 3 | 3 | 2 | 6.00 | Eng Lead | 61-90 days | R4,R6 | strategic initiative rework rate: unknown -> reduced by 20% | pilot postmortem + KPI review | abort pilot if no measurable signal after window |

## Prioritization View
Top 5 by score and tie-breakers:
1. R2 (contract smoke gate)
2. R1 (single-instance/process health guard)
3. R9 (backlog import template)
4. R3 (docs governance check)
5. R8 (fallback-free incident runbook)

## Dependency Map
- R2 depends on reliable runtime assumption (R1 recommended first, not hard blocker).
- R4 depends on stable contract/governance signals (R2).
- R9 depends on roadmap board conventions (R6).
- R10 depends on trend and execution discipline (R4 + R6).

## 30/60/90 Roadmap (Dependency-Aware)
### Wave 1 (0-30 days)
- R1, R2, R3, R6, R7, R8
Entry criteria:
- Owners assigned
- Baseline metrics recorded (or explicitly marked unknown)
Exit gate:
- Evidence Gate pass + all Wave 1 items have validation and rollback fields complete

### Wave 2 (31-60 days)
- R4, R5, R9
Entry criteria:
- Wave 1 gate pass
- telemetry and archive workflow available
Exit gate:
- Prioritization Gate pass (reproducible scoring and feasibility check)

### Wave 3 (61-90 days)
- R10 (pilot lane)
Entry criteria:
- Wave 2 outcomes reviewed
- pilot success criteria and abort criteria approved
Exit gate:
- decision log updated with continue/defer/stop outcome

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

## Gate Results (Current Draft)
- Evidence Gate: PASS (with medium confidence on runtime incident baseline unknowns)
- Prioritization Gate: PASS (formula + tie-breakers locked; feasibility assumptions documented)

## Decision Log
| Date | Item | Decision | Decider | Rationale |
|---|---|---|---|---|
| 2026-03-12 | Enhancement decision package v1 | Proposed for approval | Engineering Lead (pending) | Meets schema, scoring, gates, and roadmap requirements |
| 2026-03-12 | Optional sensitivity analysis dashboarding | Deferred | Engineering Lead (pending) | nice-to-have after core wave stabilization |
