# R10 Pilot-Lane KPI + Abort Contract

Date: 2026-03-12  
Owner: Eng Lead  
Applies to: Recommendation `R10` in `docs/CONTEXT_ENGINE_ENHANCEMENT_DECISION_PACKAGE_2026-03-12.md`

## 1. Purpose

Define the minimum deterministic contract for running an R10 pilot lane:
- KPI baseline capture rules
- minimum sample window before any continue/defer/stop decision
- no-signal timeout and explicit abort conditions
- required decision outputs and evidence

This contract is fail-closed: missing required evidence is treated as pilot `STOP`.

## 2. Required Data Sources (R4/R5/R6/R7/R8/R9)

All sources below are required for a valid pilot decision.

| Recommendation | Required source(s) | Required fields/signals |
|---|---|---|
| R4 | `artifacts/bench/r4-weekly-trend.json`, `artifacts/bench/archive/r4-weekly/r4-weekly-trend-<period>.json` | `status`, `period.key`, `metrics.strict_parity_score`, `metrics.quality_pass_rate`, `metrics.ndcg_delta_pct`, `metrics.mrr_delta_pct`, `metrics.recall_delta_pct`, archive uniqueness for `period.key` |
| R5 | `artifacts/bench/enhancement-error-taxonomy-report.json` | `status`, `summary.threshold_result`, `summary.malformed_event_count`, `counts_by_error_code.*`, `unknown_code_count`, `violations[]` |
| R6 | `docs/templates/r6-execution-board.template.json` + checker result from `scripts/ci/check-r6-execution-board.ts` | Board validation pass/fail, dependency validity, WIP/capacity violations, override-reason validity |
| R7 | `docs/templates/r7-delivery-risk-register.template.json`, `docs/templates/r7-runtime-risk-register.template.json` + checker result from `scripts/ci/check-r7-split-risk-registers.ts` | Register pass/fail, risk ID uniqueness, owner presence, review-date cadence validity |
| R8 | Drill artifact supplied to `scripts/ci/check-r8-fallback-free-runbook-drill.ts` (recommended path: `docs/rollout-evidence/<YYYY-MM-DD>/r8-fallback-free-drill.json`) | Checker `status`, `incident_class`, `outcome`, blocker resolution, required evidence fields completeness |
| R9 | `docs/templates/r9-recommendation-import.template.csv`, `docs/templates/r9-recommendation-import.template.md` + checker result from `scripts/ci/check-r9-recommendation-import.ts` | Header/schema validity, duplicate ID check, dependency-ref validity, final pass/fail |

## 3. KPI Definitions and Thresholds

`baseline_id` for this contract is mandatory and must be set in `CE_ROLLOUT_BASELINE_ID`.

Primary KPIs:

1. `KPI-R4-QUALITY-STABILITY`
- Source: R4 weekly trend artifact.
- Pass threshold:
  - `status=PASS`
  - At least 2 distinct `period.key` artifacts in archive during pilot window.
  - No week breaches PR/nightly gate fail thresholds from `docs/BENCHMARKING_GATES.md`:
    - p95 latency regression `<= +15%`
    - deterministic `review_diff` latency regression `<= +20%`
    - error rate increase `<= +0.5pp`
    - retrieval overlap `>= 0.85`
    - `unique_files@k` drop `<= 10%`

2. `KPI-R5-ERROR-BUDGET-HYGIENE`
- Source: R5 taxonomy artifact.
- Pass threshold:
  - `status=PASS`
  - `summary.threshold_result=PASS`
  - `unknown_code_count=0`
  - `summary.malformed_event_count=0`
  - No `violations` with `id` prefixed by `threshold.`

3. `KPI-R8-INCIDENT-READINESS`
- Source: R8 checker output and drill artifact.
- Pass threshold:
  - Checker `status=PASS`
  - `outcome=PASS`
  - No unresolved blockers
  - `duration_minutes <= 15`

4. `KPI-R6-R7-R9-GOVERNANCE-INTEGRITY`
- Source: R6/R7/R9 checker results.
- Pass threshold:
  - All three checks pass in the same decision window.
  - Any single fail means this KPI fails.

## 4. Baseline Capture Rules

Before pilot entry, capture a baseline bundle with timestamp and commit reference:

1. `baseline_id` and capture time (UTC).
2. Latest R4 artifact (`artifacts/bench/r4-weekly-trend.json`) and most recent archived period artifact.
3. Latest R5 taxonomy artifact.
4. Latest pass outputs for R6, R7, R8, R9 checkers.
5. Active rollout config snapshot:
- `CE_ROLLOUT_STAGE`
- `CE_ROLLOUT_CANARY_PERCENT`
- `CE_ROLLOUT_ENFORCE_GATES`
- `CE_ROLLOUT_KILL_SWITCH`

Baseline validity rules:
- Every source in Section 2 must exist and parse.
- Any missing/invalid source invalidates baseline capture and blocks pilot start.

## 5. Minimum Sample Window

Minimum sample window is satisfied only when all are true:

1. Duration: at least 14 calendar days from pilot start.
2. R4 coverage: at least 2 accepted weekly periods (`period.key`) captured during the pilot window.
3. R5 coverage: at least 1 valid taxonomy report covering the pilot window end boundary.
4. R8 coverage: at least 1 valid drill artifact executed within the pilot window.
5. R6/R7/R9 governance checks: all pass at least once within the last 7 days of the sample window.

No continue/defer decision is allowed before this window is complete unless abort conditions trigger.

## 6. No-Signal Timeout and Abort Contract

No-signal timeout:
- `10` calendar days after pilot start.

Definition of no-signal at timeout:
- We cannot establish measurable KPI movement because required sources are missing, stale, or invalid; or
- Fewer than required window artifacts exist (`<2` R4 period artifacts, missing R5 window report, or missing R8 drill evidence).

No-signal action:
- Mandatory `STOP` decision (pilot abort), with rollback handoff.

Immediate abort conditions (any one triggers `STOP`):

1. Any release-gate fail condition in `docs/BENCHMARKING_GATES.md` or rollout freeze/rollback trigger in `config/rollout-go-no-go-thresholds.json`.
2. R4 artifact/check status `FAIL` for the current decision cycle.
3. R5 artifact `status=FAIL` or `summary.threshold_result=FAIL`.
4. `unknown_code_count > 0` or `summary.malformed_event_count > 0` in R5 report.
5. R8 checker `status=FAIL`, drill `outcome=FAIL`, or unresolved blocker.
6. Any fail in R6/R7/R9 checker outputs.
7. Activation of `CE_ROLLOUT_KILL_SWITCH=true` due runtime incident.

## 7. Decision Outputs (Required)

Each pilot decision must emit one of:
- `CONTINUE`
- `DEFER`
- `STOP`

Required decision payload fields:

```json
{
  "decision": "CONTINUE|DEFER|STOP",
  "decision_time_utc": "ISO-8601 UTC",
  "baseline_id": "string",
  "sample_window_days": 0,
  "kpi_results": {
    "KPI-R4-QUALITY-STABILITY": "PASS|FAIL|NO_SIGNAL",
    "KPI-R5-ERROR-BUDGET-HYGIENE": "PASS|FAIL|NO_SIGNAL",
    "KPI-R8-INCIDENT-READINESS": "PASS|FAIL|NO_SIGNAL",
    "KPI-R6-R7-R9-GOVERNANCE-INTEGRITY": "PASS|FAIL|NO_SIGNAL"
  },
  "abort_trigger_ids": [],
  "no_signal_detected": false,
  "next_action": "proceed|hold|rollback",
  "evidence_refs": []
}
```

Decision rules:
- `CONTINUE`: all KPIs `PASS`, minimum sample window complete, no abort triggers.
- `DEFER`: no abort trigger, but one or more KPIs `NO_SIGNAL` before timeout or temporary evidence freshness gap.
- `STOP`: any immediate abort condition, or no-signal timeout reached.

## 8. Validation Checklist

This contract is valid for T13a only when the document includes:
- KPI definitions with measurable numeric/boolean thresholds.
- Baseline capture requirements with required sources.
- Minimum sample window rules.
- No-signal timeout and explicit abort conditions.
- Required decision outputs with deterministic semantics.
