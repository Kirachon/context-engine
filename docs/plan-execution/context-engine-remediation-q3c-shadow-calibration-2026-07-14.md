# Context Engine Remediation Q3c Shadow Calibration Receipt

| Field | Value |
| --- | --- |
| Task | `Q3c` |
| Disposition | `implemented` |
| Promoted tier | `calibrated` (not `pr_blocker`) |
| Harness | `scripts/ci/lib/shadowRequiredCalibration.ts` |
| CLI | `npm run ci:check:shadow-required-calibration` |
| Contract | `config/ci/q3c-shadow-calibration-contract.json` |
| Calibration receipt | `artifacts/bench/shadow-calibration-receipt.json` |

## Evidence

Local dual-commit simulation produced three consecutive non-waived receipts across commits `b4aeb16…` and `06ff69f…` with identical corpus/config identity hashes, promoting shadow retrieval gates to `calibrated` in `config/ci/gate-tier-contract.json`.

External GitHub Actions consecutive workflow history and branch-protection wiring remain out of scope for Q3c and are deferred to Q3d.
