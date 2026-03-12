# Benchmarking Gates

This document defines operator pass/fail rules for rollout decisions.

For deterministic WS19 quantitative SLO threshold enforcement from existing CI artifacts, see `docs/WS19_SLO_GATE.md`.

Baseline rules:
- Compare candidate vs approved baseline for the same query set and environment class.
- Latency deltas use percent change from baseline.
- Error rate deltas use percentage points (pp), not percent.

## PR Gates (must pass)

Fail the PR if any condition is true:
- p95 latency regression > +15%.
- `review_diff` deterministic latency regression > +20%.
- Error rate increase > +0.5pp.
- Retrieval quality overlap < 0.85.
- `unique_files@k` drop > 10%.
- Holdout quality checks fail required IDs (`nDCG@10`, `MRR@10`, `Recall@50`).

## Nightly Gates (must pass)

Fail the nightly run if any condition is true:
- Any PR gate condition fails.
- Deep retrieval p95 regression > +20%.
- Cache hit rate drop > 10pp.
- Shadow/canary artifact indicates abort threshold breach.

## Release Gates (must pass)

Fail release promotion if:
- Nightly failures are persistent.
- Variance is unstable across recent runs.

Recommended operator interpretation:
- Persistent nightly failures: 3 consecutive nightly failures, or 5 failures in the last 7 nights.
- Unstable variance: metric volatility prevents confident trend direction (for example, alternating pass/fail without remediation).

## Decision outputs

For each gate run, record:
- Timestamp and environment.
- Baseline id and candidate id.
- Gate verdict: PASS or FAIL.
- Triggered fail conditions (if any).
- Next action: proceed, hold, or rollback.

Additional required fields for retrieval speed/quality promotions:
- dataset id + dataset hash
- commit SHA + environment fingerprint
- feature-flag state snapshot
