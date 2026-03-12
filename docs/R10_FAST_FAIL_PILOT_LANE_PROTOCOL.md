# R10 Final Fast-Fail Pilot Lane Protocol

Date: 2026-03-12  
Owner: Eng Lead  
Depends on: `docs/R10_PILOT_LANE_KPI_ABORT_CONTRACT.md` (T13a)

## 1. Purpose and Scope

This protocol defines the final operating procedure for running the R10 fast-fail pilot lane from entry through closure.

It is fail-closed and governed by T13a:
- If required evidence is missing, stale, or invalid, treat as `STOP`.
- KPI/abort semantics must match T13a exactly.

## 2. Entry Criteria (Required Before Pilot Start)

Pilot entry is allowed only when all checks below pass:

1. Baseline captured per T13a Section 4:
- `baseline_id` is set and exported in `CE_ROLLOUT_BASELINE_ID`.
- Baseline capture includes R4, R5, R6, R7, R8, R9 required sources and checker outputs.
- Baseline capture includes rollout config snapshot:
  - `CE_ROLLOUT_STAGE`
  - `CE_ROLLOUT_CANARY_PERCENT`
  - `CE_ROLLOUT_ENFORCE_GATES`
  - `CE_ROLLOUT_KILL_SWITCH`

2. Required source validity:
- Every required artifact/check from T13a Section 2 exists and parses.
- No source is in `FAIL` state at pilot entry.

3. Operational readiness:
- Pilot owner, on-call, and rollback owner are explicitly assigned.
- Rollback command path and evidence destination are pre-declared.

## 3. Execution Procedure

1. Preflight checkpoint:
- Re-validate entry criteria and record `pilot_start_time_utc`.
- Record commit SHA and rollout ID in pilot log.

2. Pilot launch:
- Enable lane at approved canary settings.
- Confirm `CE_ROLLOUT_KILL_SWITCH=false` at launch.

3. Evidence cadence during pilot:
- Collect R4 weekly trend artifacts continuously; archive each new `period.key`.
- Generate/collect R5 taxonomy report for decision windows.
- Run/collect R6/R7/R9 governance checker outputs for the current window.
- Execute at least one R8 drill inside the pilot window.

4. Decision checkpoints:
- Perform formal decision review at least weekly and on any incident.
- Evaluate KPI state and abort triggers using the rubric in Section 4.
- Emit decision payload (Section 5) on every checkpoint.

5. Fast-fail enforcement:
- On any immediate abort trigger, do not defer.
- Switch directly to `STOP` and execute rollback handoff (Section 6).

## 4. Continue/Defer/Stop Decision Rubric

All decisions must follow T13a Section 5, 6, and 7.

| Decision | Required conditions | Action |
|---|---|---|
| `CONTINUE` | Minimum sample window complete (>=14 days, required R4/R5/R8/R6-R7-R9 coverage); all KPIs `PASS`; no abort triggers | Continue pilot lane |
| `DEFER` | No abort trigger; no-signal timeout not yet reached (within 10 days from pilot start); one or more KPIs `NO_SIGNAL` due temporary freshness/evidence gap | Hold decision, remediate evidence gap, re-check before timeout |
| `STOP` | Any immediate abort trigger; or no-signal timeout reached with unresolved no-signal state; or fail-closed missing/invalid required evidence | Abort pilot and execute rollback handoff |

Immediate abort trigger set (deterministic):
1. Any release-gate fail in `docs/BENCHMARKING_GATES.md` or freeze/rollback trigger in `config/rollout-go-no-go-thresholds.json`.
2. R4 `status=FAIL` in current decision cycle.
3. R5 `status=FAIL` or `summary.threshold_result=FAIL`.
4. R5 `unknown_code_count > 0` or `summary.malformed_event_count > 0`.
5. R8 checker `status=FAIL`, drill `outcome=FAIL`, or unresolved blocker.
6. Any fail in R6/R7/R9 checker outputs.
7. `CE_ROLLOUT_KILL_SWITCH=true` due runtime incident.

## 5. Required Decision Record Payload

Each decision checkpoint must produce this payload:

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

## 6. Rollback Handoff Rules (When Decision = STOP)

Rollback handoff is mandatory and starts immediately once `STOP` is declared.

1. Trigger and control:
- Set/confirm `CE_ROLLOUT_KILL_SWITCH=true`.
- Freeze further pilot expansion or config promotion.

2. Ownership transfer:
- Pilot owner hands control to rollback owner and on-call incident lead.
- Handoff must occur in the same incident thread and be timestamped.

3. Required rollback handoff packet:
- `decision` payload from Section 5 (with `STOP`).
- Trigger reason(s) mapped to abort trigger IDs.
- Active rollout config snapshot at stop time.
- Last known-good commit/tag and target rollback commit/tag.
- Command log or automation reference used for rollback.
- Evidence refs for failing KPI/check artifacts.
- Verification checklist confirming rollback completion.

4. Completion criteria:
- Rollback state validated by responsible owner.
- Governance artifacts updated with rollback outcome and evidence path.
- Postmortem owner assigned and due date committed.

## 7. Governance Signoff Checklist

All signoffs below are required before marking pilot closed.

- [ ] Decision payload generated and stored for final checkpoint.
- [ ] T13a KPI/abort contract evidence attached (R4/R5/R6/R7/R8/R9).
- [ ] Governance artifact tokens complete where applicable:
  - `Artifact Type: pre_rollout_baseline_checklist`
  - `Artifact Type: freeze_checklist`
  - `Artifact Type: final_release_summary`
- [ ] Rollout evidence log updated with governance artifact update path.
- [ ] If `STOP`, rollback handoff packet is complete and linked.
- [ ] Approvals recorded from:
  - Pilot owner
  - Eng lead
  - On-call/incident owner
  - Governance/release approver

## 8. Required Postmortem Template (Pilot Closeout)

Use this schema for pilot postmortem entries (required fields):

```markdown
# R10 Pilot Postmortem

1. Metadata
- rollout_id:
- baseline_id:
- pilot_start_time_utc:
- pilot_end_time_utc:
- decision: CONTINUE|DEFER|STOP
- owners: pilot_owner, rollback_owner, incident_owner

2. Outcome Summary
- summary:
- user_impact:
- business_impact:

3. KPI and Abort Assessment
- KPI-R4-QUALITY-STABILITY: PASS|FAIL|NO_SIGNAL + evidence_ref
- KPI-R5-ERROR-BUDGET-HYGIENE: PASS|FAIL|NO_SIGNAL + evidence_ref
- KPI-R8-INCIDENT-READINESS: PASS|FAIL|NO_SIGNAL + evidence_ref
- KPI-R6-R7-R9-GOVERNANCE-INTEGRITY: PASS|FAIL|NO_SIGNAL + evidence_ref
- abort_trigger_ids:
- no_signal_timeout_hit: true|false

4. Timeline (UTC)
- detection_time:
- decision_time:
- rollback_start_time:
- rollback_end_time:
- service_stabilized_time:

5. Root Cause and Contributing Factors
- primary_root_cause:
- contributing_factors:
- why_not_caught_earlier:

6. Rollback Handoff and Verification
- handoff_timestamp_utc:
- handoff_from:
- handoff_to:
- rollback_target:
- rollback_verification_evidence_refs:

7. Corrective Actions
- immediate_actions:
- preventive_actions:
- owners_and_due_dates:

8. Governance Signoff
- pilot_owner_signoff:
- eng_lead_signoff:
- governance_signoff:
- final_status: closed|follow_up_required
```

## 9. Validation Checklist (T13b Completion)

This protocol is complete only if it includes:
- Entry criteria
- Execution steps
- Continue/defer/stop decision rubric
- Rollback handoff rules
- Required postmortem fields/template
- Explicit alignment with T13a KPI/abort contract
