# Retrieval Bottleneck v2 Safety Drills

Purpose: define `T12` drill procedures for kill switch, per-flag rollback, and canary auto-abort.

## Pre-Drill Checks

1. Confirm baseline artifacts exist (`artifacts/bench/*.json` from T1).
2. Confirm rollout thresholds exist (`config/rollout-go-no-go-thresholds.json`).
3. Confirm rollback template validation path is healthy:
```powershell
npm run -s ci:check:ws21-rollback-drill
```

## Drill A: Global Kill Switch Propagation

Objective: prove immediate containment path.

1. Apply kill switch and safe stage:
```powershell
$env:CE_ROLLOUT_KILL_SWITCH="true"
$env:CE_ROLLOUT_CANARY_PERCENT="0"
$env:CE_ROLLOUT_STAGE="dark_launch"
$env:CE_ROLLOUT_ENFORCE_GATES="true"
```
2. Re-run readiness checks:
```powershell
node --import tsx scripts/ci/check-rollout-readiness.ts
```
3. Record evidence:
- Command transcript
- Readiness output
- WS21 rollback log entry

Pass criteria:
- Readiness command completes.
- Stage remains containment-safe (`dark_launch`, `canary=0`).
- Rollback log fields pass WS21 checker.

## Drill B: Per-Flag Rollback Sequence

Objective: prove bounded rollback without full kill switch when issue is isolated.

Rollback order:
1. Relevance regression: disable `CE_RETRIEVAL_RANKING_V3`.
2. Latency regression: disable `CE_RETRIEVAL_HYBRID_V1`, then `CE_CONTEXT_PACKS_V2` if needed.
3. Context noise regression: disable `CE_CONTEXT_PACKS_V2`.
4. Severe instability: escalate to Drill A.

Procedure:
```powershell
$env:CE_RETRIEVAL_RANKING_V3="false"
$env:CE_RETRIEVAL_HYBRID_V1="false"
$env:CE_CONTEXT_PACKS_V2="false"
```
Then run:
```powershell
npm run -s ci:check:retrieval-quality-gate
npm run -s ci:check:retrieval-shadow-canary-gate
```

Pass criteria:
- Targeted flag rollback reverses failing signal.
- No additional gate regressions introduced.
- Evidence paths recorded for T13.

## Drill C: Canary Auto-Abort

Objective: validate fail-closed promotion behavior on canary breach.

1. Run canary guard:
```powershell
npm run -s ci:check:retrieval-shadow-canary-gate
```
2. If gate reports fail/breach:
- Stop progression.
- Trigger Drill A runtime-first rollback.
- Record freeze/rollback evidence.
3. Validate evidence checker:
```powershell
npm run -s ci:check:governance-artifacts
```

Pass criteria:
- Abort decision is deterministic from gate artifact.
- Rollback procedure starts immediately on breach.
- Evidence log includes trigger, command path, and recovery notes.

## Required Evidence Outputs

- `docs/rollout-evidence/<YYYY-MM-DD>/freeze-rollback-triggers.json`
- `docs/rollout-evidence/<YYYY-MM-DD>/ws21-rollback-drill-log.md`
- `docs/rollout-evidence/<YYYY-MM-DD>/readiness-check-output.log`
- `artifacts/bench/retrieval-shadow-canary-gate.json`

## MTTR Target

- Rollback containment target: within 15 minutes from abort trigger to safe stage confirmation.
