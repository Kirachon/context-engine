# Auggie Adoption and Removal Execution Tracker

Last updated: 2026-03-11  
Program owner: Context Engine team  
Execution status: In progress  
Plan version: Finalized v2

## Objective
Execute a controlled adoption of practical Auggie-style capabilities into `local_native`, then remove legacy dependency/runtime paths with measurable parity and hard go/no-go gates.

## Tracker Metadata
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `Not started | In progress | Blocked | Done`
- Scope lock approved by: `____________________`

## Phase 0: Scope Lock and Weighted Parity Baseline

### 0.1 Scope Lock Checklist
- [ ] Confirm in-scope domains: search behavior, vector/embedding path, reliability patterns, tool integration, observability.
- [ ] Confirm out-of-scope domains and legacy allowlist boundaries.
- [ ] Freeze metrics source list and receipt paths for auditability.
- [ ] Lock parity model to [`config/ci/auggie-capability-matrix.json`](/D:/GitProjects/context-engine/config/ci/auggie-capability-matrix.json).

### 0.2 Weighted Parity Matrix (Gate Input)
| Domain | Weight |
|---|---:|
| retrieval_quality | 40 |
| tool_behavior | 20 |
| reliability_recovery | 20 |
| performance | 10 |
| ops_evidence | 10 |
| **Total** | **100** |

### 0.3 Critical Journeys (Must Reach 100%)
- [ ] `search-core-relevance` = 100%
- [ ] `tool-invoke-contracts` = 100%
- [ ] `recovery-after-provider-failure` = 100%

Receipt fields:
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `Pass | Fail | Blocked`
- Evidence links: `____________________`

## Phase 1: Adopt/Borrow Capabilities

### 1.1 Search Behavior
- [ ] Align query handling behavior and ranking expectations to parity metrics.
- [ ] Capture before/after receipts for relevance and deterministic outputs.

### 1.2 Vector/Embedding Path
- [ ] Standardize embedding/vector path behavior for parity journeys.
- [ ] Record ingestion/retrieval parity receipts.

### 1.3 Reliability Patterns
- [ ] Adopt retry/backoff and recovery handling patterns where approved.
- [ ] Validate failure-mode receipts and deterministic recovery outcomes.

### 1.4 Tool Integration
- [ ] Align tool invocation behavior/contracts and error surfaces.
- [ ] Record contract and schema compliance receipts.

### 1.5 Observability
- [ ] Ensure parity-level request tracing and operational evidence outputs.
- [ ] Capture logs/metrics receipts required by gates.

Receipt fields:
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `Pass | Fail | Blocked`
- Evidence links: `____________________`

## Phase 2: Shadow, Canary, Soak Gates (Go/No-Go)

### 2.1 Shadow Gate
- [ ] Run shadow traffic comparison.
- [ ] Confirm overall weighted parity score meets threshold.
- [ ] Confirm all critical journeys are 100%.
- [ ] Record regression deltas and operator sign-off.

Go/No-Go:
- [ ] GO to canary
- [ ] NO-GO hold with remediation ticket

### 2.2 Canary Gate
- [ ] Execute controlled canary rollout and monitor alerts.
- [ ] Validate tool behavior and reliability under live load.
- [ ] Confirm no critical regressions.
- [ ] Record operator and owner approvals.

Go/No-Go:
- [ ] GO to soak
- [ ] NO-GO rollback to prior stable state

### 2.3 Soak Gate
- [ ] Complete soak duration with stable SLO/SLA indicators.
- [ ] Verify parity score retention over soak window.
- [ ] Verify critical journeys remain 100%.
- [ ] Produce final soak receipt package.

Go/No-Go:
- [ ] GO to Phase 3 removal
- [ ] NO-GO remediation and repeat soak

Gate receipt fields:
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `GO | NO-GO`
- Evidence links: `____________________`

## Phase 3: Rollback Drill and Removal Sequencing

### 3.1 Rollback Drill
- [ ] Run rollback drill from canary/soak state.
- [ ] Confirm recovery time and integrity checks meet targets.
- [ ] Record drill evidence and lessons learned.

### 3.2 Removal Sequencing
- [ ] Remove legacy runtime path in approved order.
- [ ] Remove legacy dependency references and stale integration hooks.
- [ ] Verify no hidden coupling remains after each removal step.
- [ ] Record stepwise receipts for each removal action.

### 3.3 Active Deletion Wave Tracker
Wave owner: `Codex / subagents`  
Wave date: `2026-03-11`  
Wave status: `Completed`

Scope for this wave:
- [x] Freeze the safe-cut order before deletion.
- [x] Keep `local_native` semantic retrieval behavior working while removing Auggie ownership.
- [x] Extract reusable semantic formatting/search helpers out of legacy-named runtime ownership.
- [x] Rewire [`src/mcp/serviceClient.ts`](/D:/GitProjects/context-engine/src/mcp/serviceClient.ts) to the non-legacy helper path.
- [x] Remove legacy provider wrapper/runtime files that still imply active Auggie ownership.
- [x] Remove `@augmentcode/auggie-sdk` from active package/runtime setup.
- [x] Remove Auggie provider lanes from benchmark and workflow gates.
- [x] Shrink [`config/ci/auggie-no-legacy-allowlist.txt`](/D:/GitProjects/context-engine/config/ci/auggie-no-legacy-allowlist.txt) to the remaining archival and compatibility-proof surfaces only.
- [x] Re-run build, targeted tests, and no-legacy gates.

Execution notes:
- Safe-cut order: `extract helper -> rewire service client -> remove legacy wrapper/runtime -> clean scripts/workflows/package -> revalidate`.
- Critical no-break contract for this wave: `semantic_search`, `codebase_retrieval`, `get_context_for_prompt`, and index-state hydration must still work under `local_native`.
- Outcome: no live source/runtime path now requires `@augmentcode/auggie-sdk`; active provider code is `local_native`-only, and remaining mentions are archival docs plus audit/test tooling.

Evidence targets:
- Search/runtime proof: `tests/serviceClient.test.ts`, `tests/retrieval/providers/*.test.ts`
- Boundary proof: `npm run ci:check:retrieval-dependency-boundary`
- No-legacy proof: `npm run ci:check:no-legacy-auggie`
- Build proof: `npm run build`

Wave receipt:
- Owner: `Codex / subagents`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `tests/retrieval/providers/semanticRuntime.test.ts`, `tests/serviceClient.test.ts`, `npm run ci:check:retrieval-dependency-boundary`, `npm run ci:check:no-legacy-auggie`, `npm run build`

### 3.4 Zero-Compatibility Sweep
Wave owner: `Codex`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Remove the last active `augment_legacy` compatibility identifiers from provider source files.
- [x] Tighten provider env/factory behavior so only `local_native` is accepted in active runtime code.
- [x] Update tests and CI assertions to validate removed-provider rejection as invalid config.
- [x] Shrink [`config/ci/auggie-no-legacy-allowlist.txt`](/D:/GitProjects/context-engine/config/ci/auggie-no-legacy-allowlist.txt) again so active provider files are no longer allowlisted.
- [x] Re-run targeted tests, boundary gates, no-legacy scan, and build.

Execution notes:
- Active provider source is now strict `local_native`; removed-provider selection is rejected as `provider_config_invalid`.
- Remaining legacy strings are limited to docs plus audit/test tooling that proves the removal boundary.
- Memory guidance was updated in the same turn so future work does not assume the old compatibility-transition state.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/retrieval/providers/env.test.ts tests/retrieval/providers/factory.test.ts tests/ci/checkRetrievalProviderBoundary.test.ts tests/serviceClient.test.ts`, `npm run ci:check:retrieval-config-precedence`, `npm run ci:check:retrieval-dependency-boundary`, `npm run ci:check:no-legacy-auggie`, `npm run build`

Receipt fields:
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `Pass | Fail | Blocked`
- Evidence links: `____________________`

## Phase 4: No-Legacy Scan and Final Proof

### 4.1 No-Legacy Scan
- [ ] Run exact-string and semantic scans for active legacy usage.
- [ ] Validate allowlist is archival-only and explicitly documented.
- [ ] Confirm CI gate passes with no active legacy references.

### 4.2 Final Proof Package
- [ ] Attach final weighted parity report.
- [ ] Attach critical journey 100% proof.
- [ ] Attach shadow/canary/soak receipts.
- [ ] Attach rollback drill receipt.
- [ ] Attach removal completion receipt.

### 4.3 First Parity Evidence Baseline
Wave owner: `Codex`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Add a checked-in parity fixture pack at [`config/ci/auggie-parity-fixture-pack.json`](/D:/GitProjects/context-engine/config/ci/auggie-parity-fixture-pack.json).
- [x] Add a report generator at [`generate-auggie-parity-report.ts`](/D:/GitProjects/context-engine/scripts/ci/generate-auggie-parity-report.ts) that emits the checker-compatible `evaluations[]` report.
- [x] Wire package scripts so parity evidence generation runs before the Auggie capability gate.
- [x] Add generator-focused tests and an end-to-end checker handoff test.
- [x] Produce the first real parity baseline artifact pair under `artifacts/bench/`.

Execution notes:
- Current baseline artifacts:
  - [`retrieval-parity-pr.json`](/D:/GitProjects/context-engine/artifacts/bench/retrieval-parity-pr.json)
  - [`auggie-capability-parity-gate.json`](/D:/GitProjects/context-engine/artifacts/bench/auggie-capability-parity-gate.json)
- Strengthened baseline score: `100.00`
- Critical journeys: `100%` on `search-core-relevance`, `tool-invoke-contracts`, and `recovery-after-provider-failure`
- Stability journey: `100%` on `shadow-canary-soak-stability`
- History proof: latest `3` archived parity gate artifacts passed under [`artifacts/bench/auggie-parity-history`](/D:/GitProjects/context-engine/artifacts/bench/auggie-parity-history)
- Strict gate proof now uses `require_consecutive=3` and passes cleanly.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/ci/generateAuggieParityReport.test.ts tests/ci/archiveAuggieParityHistory.test.ts tests/ci/checkAuggieCapabilityParity.test.ts`, `npm run -s ci:check:auggie-capability-parity`, `npm run -s ci:archive:auggie-parity-history`, `npm run -s ci:check:auggie-capability-parity:strict`, `npm run build`

Final sign-off:
- Owner: `____________________`
- Date: `YYYY-MM-DD`
- Status: `Approved | Rejected`
- Evidence bundle: `____________________`

## Consolidated Receipts Checklist
- [ ] Phase 0 scope lock receipt
- [ ] Phase 1 capability adoption receipts (all domains)
- [ ] Phase 2 shadow gate receipt
- [ ] Phase 2 canary gate receipt
- [ ] Phase 2 soak gate receipt
- [ ] Phase 3 rollback drill receipt
- [ ] Phase 3 removal sequence receipts
- [ ] Phase 4 no-legacy scan receipt
- [ ] Phase 4 final proof package receipt
