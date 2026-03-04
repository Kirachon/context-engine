# WS21 Rollback Drill Log Sample

```text
Log ID: WS21-20260228-001
Batch/Scope: Batch B + Batch C rollback rehearsal
rollback_event: canary_slo_breach
Runbook Checklist:
- [x] Set CE_ROLLOUT_KILL_SWITCH=true
- [x] Set CE_ROLLOUT_CANARY_PERCENT=0
- [x] Set CE_ROLLOUT_STAGE=dark_launch
- [x] Keep CE_ROLLOUT_ENFORCE_GATES=true
- [x] Re-run readiness/stage gates
Command Path: set CE_ROLLOUT_KILL_SWITCH=true -> set CE_ROLLOUT_CANARY_PERCENT=0 -> set CE_ROLLOUT_STAGE=dark_launch -> node --import tsx scripts/ci/check-rollout-readiness.ts -> node --import tsx scripts/ci/ws19-slo-gate.ts --family review --artifact artifacts/review_diff_result.json
Owner: platform-release-owner
Started At (UTC): 2026-02-28T14:20:00Z
Ended At (UTC): 2026-02-28T14:36:00Z
RTO Target Minutes: 20
RTO Actual Minutes: 16
RTO Evidence: artifacts/ws21/rto-evidence.log
Recovery Evidence: docs/ROLLOUT_EVIDENCE_LOG.md#recorded-evidence---2026-02-28-tooling-hardening-waves-1-3
Blocker Status: none
Blocker Resolution Evidence: n/a
Notes: Drill confirmed recovery path and gate rerun path for freeze-lift readiness.
```
