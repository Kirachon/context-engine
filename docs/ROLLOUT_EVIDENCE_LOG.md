# Rollout Evidence Log

Purpose: operator-facing proof log for rollout progression and rollback readiness.

How to use:
- Create one entry per stage execution window.
- Keep outputs concrete (command, timestamp, status, artifact path).
- Link incident notes and rollback drill proof before approving the next stage.

## Governance Artifact Update Path

Use these templates when adding or updating rollout governance artifacts:
- Pre-rollout baseline checklist: `docs/templates/pre-rollout-baseline-checklist.template.md`
- Freeze checklist: `docs/templates/freeze-checklist.template.md`
- Final release summary: `docs/templates/final-release-summary.template.md`
- Rollout evidence entry block: `docs/templates/rollout-evidence-entry.template.md`

Recommended update sequence:
1. Fill pre-rollout baseline checklist before stage 0->1 advancement.
2. Append rollout evidence entries for each stage transition window.
3. Complete freeze checklist before freeze lift decision.
4. Record final release summary after rollout completion and sign-off.

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

---

## Recorded Evidence - 2026-02-28 (Tooling Hardening Waves 1-3)

```text
[GA Hardening Evidence]
Rollout ID: CE-TOOLS-HARDENING-2026-02-28
Change/Release Ref: 50bd455, 5e65968
Date/Time Window (UTC): 2026-02-28
Operator: Codex + subagent swarm
Environment: local validation + CI-compatible scripts

Flag State Snapshot:
- CE_ROLLOUT_STAGE=ga_hardening (decision target for this evidence pack)
- CE_ROLLOUT_ENFORCE_GATES=true
- CE_ROLLOUT_KILL_SWITCH=false

Gate Outputs:
- PR Gate Result: pass (`npm run bench:ci:pr`)
- Nightly Gate Result: pass (`npm run bench:ci:nightly`)
- Release Gate Result: pass (`npm run bench:ci:release -- --mode scan --out-dir artifacts/bench/release --baseline artifacts/bench/nightly-baseline.json`)
- Parity Check: pass (`node --import tsx scripts/ci/check-tool-manifest-parity.ts`)
- Readiness Check: pass (`node --import tsx scripts/ci/check-rollout-readiness.ts`)
- Type/Tests:
  - `npx tsc --noEmit` pass
  - `npx jest tests/tools/context.test.ts tests/tools/reviewChanges.test.ts tests/tools/reactiveReview.test.ts` pass
  - `npm test -- tests/tools/reviewAuto.test.ts tests/tools/reactiveReview.test.ts tests/ci/benchCompare.test.ts tests/serviceClient.test.ts` pass

Rollback Drill Proof:
- Drill Date/Time: 2026-02-28
- Drill Scope: command-path verification (runtime-first order)
- Verified Commands:
  1) set CE_ROLLOUT_KILL_SWITCH=true
  2) set CE_ROLLOUT_CANARY_PERCENT=0
  3) set CE_ROLLOUT_STAGE=dark_launch
  4) keep CE_ROLLOUT_ENFORCE_GATES=true
  5) rerun readiness + gate checks
- Outcome: pass (procedural path verified)

Final Sign-off:
- Freeze Lift Approved (yes/no): yes (engineering evidence complete)
- Approver: project owner
- Release Notes Link: commits 50bd455 and 5e65968 on main
```
