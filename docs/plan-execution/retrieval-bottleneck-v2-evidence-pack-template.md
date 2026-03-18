# Retrieval Bottleneck v2 Final Evidence Pack Template (T13)

Use this template to produce the final go/no-go report after `T12` safety drills.

## 1) Report Metadata

- Report ID:
- Date (UTC):
- Candidate commit SHA:
- Baseline reference commit/tag:
- Environment fingerprint:
- Owners/signatories:

## 2) Scope and Dependency Completion

| Task | Status | Evidence Link |
| --- | --- | --- |
| T0 |  |  |
| T1 |  |  |
| T4 |  |  |
| T5a |  |  |
| T6 |  |  |
| T12 |  |  |
| T13 |  |  |

## 3) Baseline vs Candidate Metrics

Required data source: `retrieve/search` mode artifacts only.

| Metric | Baseline | Candidate | Delta | Gate | Verdict |
| --- | --- | --- | --- | --- | --- |
| nDCG@10 |  |  |  | >= +8% |  |
| MRR@10 |  |  |  | >= +6% |  |
| Recall@50 |  |  |  | >= +10% |  |
| p50 latency |  |  |  | <= -20% |  |
| p95 latency |  |  |  | <= -25% |  |
| Error rate |  |  |  | no regression |  |

## 4) Provenance and Equivalence Contract

- Dataset id:
- Dataset hash:
- Feature-flag snapshot:
- Baseline artifact paths:
- Candidate artifact paths:
- Notes on equivalence exceptions (if any):

## 5) Safety Drill Results (T12)

| Drill | Result | Start UTC | End UTC | Evidence |
| --- | --- | --- | --- | --- |
| Kill switch propagation |  |  |  |  |
| Per-flag rollback |  |  |  |  |
| Canary auto-abort |  |  |  |  |

## 6) Risk Register and Residual Risk

| Risk | Trigger | Mitigation | Residual Level | Owner |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 7) Rollback Readiness

- Runtime-first rollback command path verified: yes/no
- WS21 rollback evidence checker pass: yes/no
- Expected MTTR target met (<= 15 min): yes/no
- Rollback artifacts:

## 8) Recommendation

- Final verdict: `GO` / `NO-GO`
- Release stage recommendation:
- Preconditions for next stage:
- Blockers:

## 9) Sign-off

| Role | Name | Decision | Timestamp (UTC) |
| --- | --- | --- | --- |
| Release approver |  |  |  |
| Engineering owner |  |  |  |
| Ops/on-call owner |  |  |  |
| Docs/evidence owner | Worker C |  |  |

## 10) Attached Artifacts Checklist

- [ ] `artifacts/bench/pr-baseline.json`
- [ ] `artifacts/bench/pr-candidate.json`
- [ ] `artifacts/bench/retrieval-quality-report.json`
- [ ] `artifacts/bench/retrieval-quality-gate.json`
- [ ] `artifacts/bench/retrieval-shadow-canary-gate.json`
- [ ] `docs/rollout-evidence/<YYYY-MM-DD>/freeze-rollback-triggers.json`
- [ ] `docs/rollout-evidence/<YYYY-MM-DD>/ws21-rollback-drill-log.md`
- [ ] readiness command output log
