# WS21 Rollback Drill Log Template

Purpose: operator-facing template for WS21 rollback drill evidence. Keep values concrete and UTC timestamps exact.

```text
Log ID: WS21-YYYYMMDD-001
Batch/Scope: Batch D - Memory + Reactive Utility Family
Command Path: set CE_ROLLOUT_KILL_SWITCH=true -> set CE_ROLLOUT_CANARY_PERCENT=0 -> set CE_ROLLOUT_STAGE=dark_launch -> node --import tsx scripts/ci/check-rollout-readiness.ts
Owner: operations-oncall
Started At (UTC): 2026-02-28T10:00:00Z
Ended At (UTC): 2026-02-28T10:12:00Z
Recovery Evidence: artifacts/ws21/rollback-drill/recovery-evidence.log
Blocker Status: none
Blocker Resolution Evidence: n/a
Notes: Replace sample values with actual drill execution details before sign-off.
```
