# Plan: Context Engine Enhancement (R4-R10)

**Generated**: 2026-03-12

## Overview
Implement the remaining recommendations (R4-R10) from `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md` with dependency-aware execution, deterministic CI gates, and evidence-backed closeout.

## Prerequisites
- Existing R1/R2/R3/R8 implementation artifacts remain available and verifiable.
- CI and scripts can write to `artifacts/`.
- No new external runtime dependencies required.

## Dependency Graph

```text
T0 -> T1,T3,T5,T7,T9,T11
T1 -> T2
T3 -> T4
T5 -> T6
T7 -> T8
T5 -> T9
T9 -> T10
T11 -> T12
T2,T4,T6,T8,T10,T12 -> T13a -> T13b -> T14 -> T15 -> T16
```

## Tasks

### T0: Prereq Evidence Freeze
- **depends_on**: []
- **location**: `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`, `artifacts/bench/*`, current CI gate outputs
- **description**: Freeze baseline references and current-status mapping so scoring cannot drift during execution.
- **validation**: Baseline manifest/checklist includes fixed commit/timestamp references for R1/R2/R3/R8 state.
- **status**: Completed (2026-03-12)
- **log**:
  - Added deterministic freeze manifest with fixed repo snapshot (`95ede57bd2197818255aa4ecebb9930fd09cdef8`) and freeze timestamp (`2026-03-12T01:41:19.8535289Z`).
  - Locked R1/R2/R3/R8 state references and benchmark/CI gate baseline artifacts with SHA-256 digests.
  - Added explicit execution-freeze note in the decision package to prevent scoring drift until T16.
- **files edited/created**:
  - `artifacts/governance/t0-prereq-evidence-freeze-manifest-2026-03-12.json` (created)
  - `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md` (edited)
  - `docs/archive/context-engine-enhancement-r4-r10-plan.md` (edited)

### T1: R4 Trend Contract Design
- **depends_on**: [T0]
- **location**: `scripts/ci/`, `docs/`
- **description**: Define weekly quality/parity trend artifact schema, period-key rules, retention policy, and fail/skip behavior.
- **validation**: Contract covers missing artifacts, duplicate periods, schema drift, and archive-write failures.
- **status**: Completed (2026-03-12)
- **log**:
  - Added weekly trend contract with schema, period-key rules, retention, and deterministic fail/skip policy.
  - Included explicit handling for missing artifact, duplicate period keys, schema drift, and archive-write failures.
- **files edited/created**:
  - `docs/R4_WEEKLY_TREND_CONTRACT.md` (created)

### T2: R4 Trend Automation
- **depends_on**: [T1]
- **location**: `.github/workflows/`, `scripts/ci/`, `artifacts/bench/`, `docs/`
- **description**: Implement scheduled/automated trend generation + archive flow with deterministic validation gate.
- **validation**: Weekly run produces valid trend artifact; invalid/missing artifact fails gate.
- **status**: Completed (2026-03-12)
- **log**:
  - Added weekly trend generator/checker scripts with deterministic schema validation and failure modes.
  - Wired weekly trend generation/check into `.github/workflows/perf_gates.yml` and npm scripts.
  - Local validation passed for generate/check commands.
- **files edited/created**:
  - `scripts/ci/generate-weekly-retrieval-trend-report.ts` (created)
  - `scripts/ci/check-weekly-retrieval-trend-report.ts` (created)
  - `.github/workflows/perf_gates.yml` (edited)
  - `package.json` (edited)

### T3: R5 Error Taxonomy Contract Design
- **depends_on**: [T0]
- **location**: `docs/`, release checklist documents
- **description**: Define enhancement error taxonomy fields (`TRANSIENT_UPSTREAM`, auth/config, quota, unknown), reporting window, and threshold semantics.
- **validation**: Contract includes unknown code accounting, malformed input behavior, and zero-event windows.
- **status**: Completed (2026-03-12)
- **log**:
  - Added taxonomy contract for `TRANSIENT_UPSTREAM`, `AUTH_CONFIG`, `QUOTA`, `UNKNOWN`.
  - Defined machine-readable envelope (`status`, `summary`, `counts_by_error_code`, `unknown_code_count`) and threshold semantics.
  - Added malformed input handling and zero-event window behavior.
- **files edited/created**:
  - `docs/R5_ENHANCEMENT_ERROR_TAXONOMY_CONTRACT.md` (created)

### T4: R5 Taxonomy Extraction + Checklist Hook
- **depends_on**: [T3]
- **location**: `scripts/ci/`, `docs/`
- **description**: Implement taxonomy extraction/report script and wire deterministic release-checklist gate.
- **validation**: Artifact contains `status`, `summary`, `counts_by_error_code`, `unknown_code_count`; invalid payload fails.
- **status**: Completed (2026-03-12)
- **log**:
  - Added enhancement taxonomy generator/checker scripts aligned to T3 contract.
  - Added package scripts for generate/check hook and verified deterministic pass/fail behavior on fixtures.
- **files edited/created**:
  - `scripts/ci/generate-enhancement-error-taxonomy-report.ts` (created)
  - `scripts/ci/check-enhancement-error-taxonomy-report.ts` (created)
  - `package.json` (edited)

### T5: R6 Execution Board Model Design
- **depends_on**: [T0]
- **location**: `docs/`
- **description**: Define 30/60/90 board schema with dependency state model, owner capacity, WIP caps, and override policy.
- **validation**: Model explicitly rejects circular deps/orphan references and requires override reason.
- **status**: Completed (2026-03-12)
- **log**:
  - Added execution board model contract with dependency state model, owner capacity, WIP caps, and override policy.
  - Documented invalid cases (circular deps/orphan refs/invalid transitions) for deterministic validator implementation.
- **files edited/created**:
  - `docs/R6_EXECUTION_BOARD_MODEL.md` (created)

### T6: R6 Board Implementation + Validator
- **depends_on**: [T5]
- **location**: `docs/`, `scripts/ci/`
- **description**: Create execution board artifacts/templates and deterministic validation checks.
- **validation**: Validator fails on invalid transitions, missing owner, cap violations without waiver reason.
- **status**: Completed (2026-03-12)
- **log**:
  - Added execution board template and deterministic validator for dependency/owner/WIP cap rules.
  - Added npm command and validated both passing template and intentional failing input.
- **files edited/created**:
  - `docs/templates/r6-execution-board.template.json` (created)
  - `scripts/ci/check-r6-execution-board.ts` (created)
  - `package.json` (edited)

### T7: R7 Split Risk Register Design
- **depends_on**: [T0]
- **location**: `docs/`
- **description**: Define two-register structure (delivery/runtime), required fields, and review cadence.
- **validation**: Required fields and cadence are explicit and enforceable by checker.
- **status**: Completed (2026-03-12)
- **log**:
  - Added split-register contract (delivery/runtime), required fields, and review cadence.
  - Included required field matrix and checker-oriented pass/fail rules.
- **files edited/created**:
  - `docs/R7_SPLIT_RISK_REGISTER_CONTRACT.md` (created)

### T8: R7 Register Implementation + Validation
- **depends_on**: [T7]
- **location**: `docs/`, `scripts/ci/`
- **description**: Implement risk register artifacts and checks for ID uniqueness, owner, and review-date requirements.
- **validation**: Deterministic checker passes only when both registers satisfy schema.
- **status**: Completed (2026-03-12)
- **log**:
  - Added delivery/runtime register templates and deterministic cross-register validator.
  - Enforced owner/review date fields and risk ID uniqueness across both registers.
- **files edited/created**:
  - `docs/templates/r7-delivery-risk-register.template.json` (created)
  - `docs/templates/r7-runtime-risk-register.template.json` (created)
  - `scripts/ci/check-r7-split-risk-registers.ts` (created)
  - `package.json` (edited)

### T9: R9 Import Schema Design
- **depends_on**: [T0, T5]
- **location**: `docs/templates/`, `docs/`
- **description**: Define recommendation import schema for CSV/MD with required columns and dependency reference rules.
- **validation**: Design covers BOM, quoted commas/newlines, duplicate IDs, invalid dependency refs, idempotent re-import behavior.
- **status**: Completed (2026-03-12)
- **log**:
  - Added canonical R9 import schema doc and matching CSV/MD templates.
  - Covered BOM, quoted comma/newline behavior, duplicate IDs, invalid dependency refs, idempotency notes.
- **files edited/created**:
  - `docs/R9_RECOMMENDATION_IMPORT_SCHEMA.md` (created)
  - `docs/templates/r9-recommendation-import.template.csv` (created)
  - `docs/templates/r9-recommendation-import.template.md` (created)

### T10: R9 Import Templates + Validator
- **depends_on**: [T9]
- **location**: `docs/templates/`, `scripts/ci/`, `docs/`
- **description**: Implement import templates and deterministic validator for backlog ingestion.
- **validation**: Invalid inputs fail with actionable errors; valid templates pass.
- **status**: Completed (2026-03-12)
- **log**:
  - Added deterministic R9 import validator for CSV/MD templates with BOM and RFC4180-safe parsing.
  - Enforced duplicate ID checks, dependency reference validation, malformed row detection, and self-dependency rejection.
  - Added npm command and validated both passing templates and failing fixture case.
- **files edited/created**:
  - `scripts/ci/check-r9-recommendation-import.ts` (created)
  - `package.json` (edited)
  - `docs/R9_RECOMMENDATION_IMPORT_SCHEMA.md` (edited)

### T11: R8 Fallback-Free Incident Runbook Contract
- **depends_on**: [T0]
- **location**: `docs/`
- **description**: Formalize fallback-free transient incident taxonomy and drill artifact schema for package evidence quality.
- **validation**: Contract includes decision path for transient/auth/quota/config incidents and expected drill outputs.
- **status**: Completed (2026-03-12)
- **log**:
  - Added fallback-free incident taxonomy and deterministic decision path for transient/auth/quota/config incidents.
  - Defined drill artifact schema, required evidence fields, and readiness-gate-consumable output expectations.
- **files edited/created**:
  - `docs/R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT.md` (created)

### T12: R8 Runbook + Drill Gate Integration
- **depends_on**: [T11]
- **location**: `docs/`, `scripts/ci/`
- **description**: Implement/align runbook artifact checks and readiness-gate hook.
- **validation**: Missing/invalid runbook or drill artifacts fail readiness.
- **status**: Completed (2026-03-12)
- **log**:
  - Added deterministic R8 runbook/drill checker and integrated optional hook into readiness gate.
  - Updated rollout runbook with command references and blocking semantics for failed R8 checks.
  - Confirmed backward compatibility when optional R8 path is omitted.
- **files edited/created**:
  - `scripts/ci/check-r8-fallback-free-runbook-drill.ts` (created)
  - `scripts/ci/check-rollout-readiness.ts` (edited)
  - `docs/ROLLOUT_RUNBOOK.md` (edited)

### T13a: R10 Early KPI + Abort Contract
- **depends_on**: [T2, T4, T6, T8, T10, T12]
- **location**: `docs/`
- **description**: Define pilot lane KPI baseline, minimum sample window, and no-signal abort timeout before final pilot protocol.
- **validation**: Contract has measurable thresholds and explicit abort conditions.
- **status**: Completed (2026-03-12)
- **log**:
  - Added KPI baseline/abort contract with deterministic thresholds, sample-window rules, and no-signal timeout policy.
  - Included explicit decision output schema (`CONTINUE`/`DEFER`/`STOP`) and required artifact data sources.
- **files edited/created**:
  - `docs/R10_PILOT_LANE_KPI_ABORT_CONTRACT.md` (created)

### T13b: R10 Final Pilot Lane Protocol
- **depends_on**: [T13a]
- **location**: `docs/`
- **description**: Draft final fast-fail pilot lane procedure, decision rubric, and postmortem requirements.
- **validation**: Protocol includes continue/defer/stop decision criteria and rollback handoff.
- **status**: Completed (2026-03-12)
- **log**:
  - Added fast-fail pilot protocol with entry criteria, deterministic decision rubric, rollback handoff, and postmortem requirements.
  - Explicitly aligned decision criteria and abort semantics with T13a KPI/abort contract.
- **files edited/created**:
  - `docs/R10_FAST_FAIL_PILOT_LANE_PROTOCOL.md` (created)

### T14: Decision Package Draft Integration
- **depends_on**: [T2, T4, T6, T8, T10, T12, T13b]
- **location**: `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`
- **description**: Update R4-R10 recommendation rows, dependency map, wave sections, and provisional gate outcomes using produced artifacts.
- **validation**: All R4-R10 rows include owner, due window, baseline->target metric, validation, rollback/abort fields.
- **status**: Completed (2026-03-12)
- **log**:
  - Integrated R4-R10 rows with concrete owner/due/dependencies/metrics/validation/rollback fields.
  - Updated dependency map and roadmap sequencing with implemented artifact/checker references.
  - Linked decision package evidence section to concrete files produced in T2/T4/T6/T8/T10/T12/T13.
- **files edited/created**:
  - `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md` (edited)

### T15: Quality/Safety Verification Matrix
- **depends_on**: [T14]
- **location**: CI scripts + artifacts + docs verification sections
- **description**: Run full relevant checks and produce pass/fail matrix linking each recommendation to concrete evidence artifacts.
- **validation**: Every required check has explicit PASS/FAIL and path reference.
- **status**: Completed (2026-03-12)
- **log**:
  - Executed full R4-R10 validation matrix and baseline safety checks; all required commands passed.
  - Captured evidence-command mapping and artifact references in a dedicated verification matrix document.
  - Resolved prior blockers by adding required taxonomy event input and a checker-compliant R8 drill artifact.
- **files edited/created**:
  - `artifacts/governance/r4-r10-verification-matrix-2026-03-12.md` (created)
  - `artifacts/bench/enhancement-error-events.json` (created)
  - `artifacts/governance/r8-fallback-free-drill-sample.json` (edited)

### T16: Final Recalibration + Decision Log Closeout
- **depends_on**: [T15]
- **location**: `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`
- **description**: Finalize scoring, gate outcomes, unknowns register, and decision log from verified evidence only.
- **validation**: Evidence Gate and Prioritization Gate are reproducible from committed artifacts/check outputs.
- **status**: Completed (2026-03-12)
- **log**:
  - Recalibrated package gate section from draft to final-closeout wording using T15 evidence outputs only.
  - Updated decision log to reflect execution closeout readiness with explicit note on formal approver handoff.
  - Preserved unknowns register items that remain not specified in codebase.
- **files edited/created**:
  - `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md` (edited)
  - `docs/archive/context-engine-enhancement-r4-r10-plan.md` (edited)

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T0 | Immediately |
| 2 | T1, T3, T5, T7, T11 | T0 complete |
| 3 | T2, T4, T6, T8 | Wave 2 dependencies complete |
| 4 | T9 | T0 + T5 complete |
| 5 | T10 | T9 complete |
| 6 | T12 | T11 complete |
| 7 | T13a | T2, T4, T6, T8, T10, T12 complete |
| 8 | T13b | T13a complete |
| 9 | T14 | T2, T4, T6, T8, T10, T12, T13b complete |
| 10 | T15 | T14 complete |
| 11 | T16 | T15 complete |

## Testing Strategy
- Build/type safety: `npm run -s build`
- Existing reliability/review gates as applicable:
  - `npm run -s ci:check:review-timeout-contract`
  - `npm run -s ci:check:review-auto-timeout-smoke`
  - `node --import tsx scripts/ci/check-rollout-readiness.ts [artifact paths]`
- New validators introduced by T2/T4/T6/T8/T10/T12 must each have deterministic pass/fail behavior and CI entrypoints.
- Final acceptance requires end-to-end evidence matrix covering R4-R10 recommendations.

## Risks & Mitigations
- Risk: drift between provisional scores and final evidence.
  - Mitigation: freeze baseline in T0; only recalculate in T16 using T15 outputs.
- Risk: merge conflicts in decision package during parallel work.
  - Mitigation: defer single-file integration to T14 after subsystem tasks complete.
- Risk: weak validation for new templates/docs.
  - Mitigation: add deterministic validators for every new governance artifact.
