# CI thresholds

This repo tracks the Appendix E § E.6 rollback thresholds in `config/ci/ci-thresholds.json`.

## Thresholds

- `mcpInitializeP95RegressionPct` — fail or roll back if `/mcp` initialize p95 regresses by more than 20% versus the approved baseline (across at least 50 samples) unless the change is tied to a critical CVE mitigation.
- `enhancementMrr10RegressionPct` — fail or roll back if enhancement-pack MRR@10 regresses by more than 3%.
- `enhancementEmptyContextRiseRatePct` — fail or roll back if user-visible empty-context rate rises by more than 5%.
- `providerFailureRatePct` — fail or roll back if provider-initiated failures exceed 1%.
- `providerFailureWindow` — evaluate provider failures over a rolling 500-request window at or below default concurrency.
- `requiredLaneCatchRateMinPct` — fail or roll back if required-lane catch rate on the canary failure corpus drops below 95% of the approved pre-consolidation baseline.
- `timeToFirstToolCallRegressionPct` — fail or roll back if time-to-first-successful-tool-call in fresh-clone smoke drills regresses by more than 25%.

## Update process

1. Propose threshold changes in a pull request that updates `config/ci/ci-thresholds.json`.
2. Link the supporting benchmark, smoke, or telemetry evidence in that PR.
3. Get explicit sign-off from the owning CI/evals maintainers before merge.
4. Update any workflow comments or downstream guard scripts that encode the old value so the machine-readable config and enforcement stay aligned.
