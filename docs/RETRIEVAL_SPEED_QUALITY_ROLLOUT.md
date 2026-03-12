# Retrieval Speed + Quality Rollout

This runbook covers safe rollout for retrieval rewrite/ranking/memoization upgrades.

## Defaults
- `CE_RETRIEVAL_REWRITE_V2=false`
- `CE_RETRIEVAL_RANKING_V2=false`
- `CE_RETRIEVAL_REQUEST_MEMO_V2=false`

## Enable Sequence
1. Enable telemetry and run baseline benchmarks/quality gates.
2. Enable `CE_RETRIEVAL_REWRITE_V2=true` only; run test + gate suite.
3. Enable `CE_RETRIEVAL_RANKING_V2=true`; rerun gates.
4. Enable `CE_RETRIEVAL_REQUEST_MEMO_V2=true`; rerun cold/warm checks.
5. Run shadow/canary check before broad rollout.

## Rollback
If any required gate fails, set all three flags to `false` and rerun:

```bash
npm run -s ci:generate:retrieval-quality-report
npm run -s ci:check:retrieval-quality-gate
```

## Required Evidence
- Baseline/candidate benchmark artifacts.
- Retrieval quality report + gate artifact.
- Holdout fixture/hash check artifact.
- Shadow/canary gate artifact.
- Feature-flag snapshot used in the run.
