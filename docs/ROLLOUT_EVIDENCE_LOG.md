# Rollout Evidence Log

Purpose: operator-facing proof log for rollout progression and rollback readiness.

How to use:
- Create one entry per stage execution window.
- Keep outputs concrete (command, timestamp, status, artifact path).
- Link incident notes and rollback drill proof before approving the next stage.

---

## Shared Header (copy for each stage entry)

```text
Rollout ID:
Change/Release Ref:
Stage:
Date/Time Window (UTC):
Operator:
Reviewer/Approver:
Environment:
Baseline ID (if applicable):
Notes:
```

## Stage 1: Dark Launch Evidence Template

```text
[Dark Launch Evidence]
Rollout ID:
Change/Release Ref:
Date/Time Window (UTC):
Operator:
Environment:

Flag State Snapshot:
- CE_ROLLOUT_STAGE=dark_launch
- CE_ROLLOUT_CANARY_PERCENT=0
- CE_ROLLOUT_ENFORCE_GATES=true
- CE_ROLLOUT_KILL_SWITCH=false

Readiness Check:
- Command: node --import tsx scripts/ci/check-rollout-readiness.ts
- Exit Code:
- Output Summary:

Gate Outputs:
- PR Gate Run ID / Link:
- PR Gate Result (pass/fail):
- Nightly Gate Run ID / Link:
- Nightly Gate Result (pass/fail):
- Baseline Delta Summary (p95 / error / overlap / unique_files@k):

Rollback Drill Proof:
- Drill Date/Time:
- Drill Steps Executed: kill switch -> canary 0 -> stage dark_launch -> gate re-run
- Proof Artifact (log/screenshot/path):
- Drill Outcome (pass/fail):

Decision:
- Exit Approved (yes/no):
- Approver:
- Reason:
```

## Stage 2: Canary Evidence Template

```text
[Canary Evidence]
Rollout ID:
Change/Release Ref:
Date/Time Window (UTC):
Operator:
Environment:

Flag State Snapshot:
- CE_ROLLOUT_STAGE=canary
- CE_ROLLOUT_CANARY_PERCENT=<approved value>
- CE_ROLLOUT_ENFORCE_GATES=true
- CE_ROLLOUT_KILL_SWITCH=false

Traffic Scope:
- Canary Percent:
- Target Segment:

Gate Outputs:
- PR Gate Run ID / Link:
- PR Gate Result (pass/fail):
- Nightly Gate Run ID / Link:
- Nightly Gate Result (pass/fail):
- Metrics Summary (p95 / review_diff latency / error / overlap / unique_files@k):

Rollback Drill Proof:
- Drill Date/Time:
- Kill Switch Validation Result:
- Exposure Reset Validation Result:
- Proof Artifact (log/screenshot/path):

Decision:
- Exit Approved (yes/no):
- Approver:
- Reason:
```

## Stage 3: Controlled Ramp Evidence Template

```text
[Controlled Ramp Evidence]
Rollout ID:
Change/Release Ref:
Date/Time Window (UTC):
Operator:
Environment:

Flag State Snapshot:
- CE_ROLLOUT_STAGE=controlled_ramp
- CE_ROLLOUT_ENFORCE_GATES=true
- CE_ROLLOUT_KILL_SWITCH=false

Ramp Steps:
- Step 1 Percent / Result:
- Step 2 Percent / Result:
- Step 3 Percent / Result:
- Hold/Stop Events:

Gate Outputs per Step:
- PR/Nightly Gate Runs:
- Fail Signals:
- Remediation Evidence Links:

Rollback Drill Proof:
- Drill Date/Time:
- Highest Percent Tested:
- Mean Time to Safe Baseline:
- Proof Artifact (log/screenshot/path):

Decision:
- Exit Approved (yes/no):
- Approver:
- Reason:
```

## Stage 4: GA Hardening Evidence Template

```text
[GA Hardening Evidence]
Rollout ID:
Change/Release Ref:
Date/Time Window (UTC):
Operator:
Environment:

Flag State Snapshot:
- CE_ROLLOUT_STAGE=ga_hardening
- CE_ROLLOUT_ENFORCE_GATES=true
- CE_ROLLOUT_KILL_SWITCH=false

Gate Outputs:
- PR Gate Run ID / Link:
- Nightly Gate Run IDs / Links:
- Release Gate Run ID / Link:
- Final Stability Summary (nightly pass streak, variance, incidents):

Rollback Drill Proof:
- Drill Date/Time:
- Drill Scope:
- Proof Artifact (log/screenshot/path):
- Outcome:

Final Sign-off:
- Freeze Lift Approved (yes/no):
- Approver:
- Release Notes Link:
```
