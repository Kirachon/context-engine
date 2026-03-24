# Legacy Provider Adoption and Removal Execution Tracker

Last updated: 2026-03-11  
Program owner: Context Engine team  
Execution status: In progress  
Plan version: Finalized v2

## Objective
Execute a controlled adoption of practical legacy-provider-style capabilities into `local_native`, then remove legacy dependency/runtime paths with measurable parity and hard go/no-go gates.

## Next Wave Pointer
- Active follow-up implementation plan: [`docs/archive/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md`](/D:/GitProjects/context-engine/docs/archive/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md)
- Current focus: Phase 0 and Phase 1 foundations (quality gate scaffolding, lexical/fusion retrieval upgrades).

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
- [ ] Lock parity model to [`config/ci/legacy-capability-matrix.json`](/D:/GitProjects/context-engine/config/ci/legacy-capability-matrix.json).

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
- [x] Keep `local_native` semantic retrieval behavior working while removing legacy provider ownership.
- [x] Extract reusable semantic formatting/search helpers out of legacy-named runtime ownership.
- [x] Rewire [`src/mcp/serviceClient.ts`](/D:/GitProjects/context-engine/src/mcp/serviceClient.ts) to the non-legacy helper path.
- [x] Remove legacy provider wrapper/runtime files that still imply active legacy provider ownership.
- [x] Remove legacy SDK package/runtime dependency from active package/runtime setup.
- [x] Remove legacy provider provider lanes from benchmark and workflow gates.
- [x] Shrink [`config/ci/legacy-provider-no-legacy-allowlist.txt`](/D:/GitProjects/context-engine/config/ci/legacy-provider-no-legacy-allowlist.txt) to the remaining archival and compatibility-proof surfaces only.
- [x] Re-run build, targeted tests, and no-legacy gates.

Execution notes:
- Safe-cut order: `extract helper -> rewire service client -> remove legacy wrapper/runtime -> clean scripts/workflows/package -> revalidate`.
- Critical no-break contract for this wave: `semantic_search`, `codebase_retrieval`, `get_context_for_prompt`, and index-state hydration must still work under `local_native`.
- Outcome: no live source/runtime path now requires legacy SDK runtime ownership; active provider code is `local_native`-only, and remaining mentions are archival docs plus audit/test tooling.

Evidence targets:
- Search/runtime proof: `tests/serviceClient.test.ts`, `tests/retrieval/providers/*.test.ts`
- Boundary proof: `npm run ci:check:retrieval-dependency-boundary`
- No-legacy proof: `npm run ci:check:no-legacy-provider`
- Build proof: `npm run build`

Wave receipt:
- Owner: `Codex / subagents`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `tests/retrieval/providers/semanticRuntime.test.ts`, `tests/serviceClient.test.ts`, `npm run ci:check:retrieval-dependency-boundary`, `npm run ci:check:no-legacy-provider`, `npm run build`

### 3.4 Zero-Compatibility Sweep
Wave owner: `Codex`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Remove the last active legacy-provider compatibility identifiers from provider source files.
- [x] Tighten provider env/factory behavior so only `local_native` is accepted in active runtime code.
- [x] Update tests and CI assertions to validate removed-provider rejection as invalid config.
- [x] Shrink [`config/ci/legacy-provider-no-legacy-allowlist.txt`](/D:/GitProjects/context-engine/config/ci/legacy-provider-no-legacy-allowlist.txt) again so active provider files are no longer allowlisted.
- [x] Re-run targeted tests, boundary gates, no-legacy scan, and build.

Execution notes:
- Active provider source is now strict `local_native`; removed-provider selection is rejected as `provider_config_invalid`.
- Remaining legacy strings are limited to docs plus audit/test tooling that proves the removal boundary.
- Memory guidance was updated in the same turn so future work does not assume the old compatibility-transition state.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/retrieval/providers/env.test.ts tests/retrieval/providers/factory.test.ts tests/ci/checkRetrievalProviderBoundary.test.ts tests/serviceClient.test.ts`, `npm run ci:check:retrieval-config-precedence`, `npm run ci:check:retrieval-dependency-boundary`, `npm run ci:check:no-legacy-provider`, `npm run build`

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
- [x] Add a checked-in parity fixture pack at [`config/ci/legacy-capability-parity-fixture-pack.json`](/D:/GitProjects/context-engine/config/ci/legacy-capability-parity-fixture-pack.json).
- [x] Add a report generator at [`generate-legacy-capability-parity-report.ts`](/D:/GitProjects/context-engine/scripts/ci/generate-legacy-capability-parity-report.ts) that emits the checker-compatible `evaluations[]` report.
- [x] Wire package scripts so parity evidence generation runs before the legacy provider capability gate.
- [x] Add generator-focused tests and an end-to-end checker handoff test.
- [x] Produce the first real parity baseline artifact pair under `artifacts/bench/`.

Execution notes:
- Current baseline artifacts:
  - [`retrieval-parity-pr.json`](/D:/GitProjects/context-engine/artifacts/bench/retrieval-parity-pr.json)
  - [`legacy-capability-parity-gate.json`](/D:/GitProjects/context-engine/artifacts/bench/legacy-capability-parity-gate.json)
- Strengthened baseline score: `100.00`
- Critical journeys: `100%` on `search-core-relevance`, `tool-invoke-contracts`, and `recovery-after-provider-failure`
- Stability journey: `100%` on `shadow-canary-soak-stability`
- History proof: latest `3` archived parity gate artifacts passed under [`artifacts/bench/legacy-capability-parity-history`](/D:/GitProjects/context-engine/artifacts/bench/legacy-capability-parity-history)
- Strict gate proof now uses `require_consecutive=3` and passes cleanly.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/ci/generateLegacyCapabilityParityReport.test.ts tests/ci/archiveLegacyCapabilityParityHistory.test.ts tests/ci/checkLegacyCapabilityParity.test.ts`, `npm run -s ci:check:legacy-capability-parity`, `npm run -s ci:archive:legacy-capability-parity-history`, `npm run -s ci:check:legacy-capability-parity:strict`, `npm run build`

### 4.4 Local-Native Search Quality Kickoff (Phase 0 + Phase 1)
Wave owner: `Codex / multi-agent wave`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Save and publish the implementation plan at [`docs/archive/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md`](/D:/GitProjects/context-engine/docs/archive/LOCAL_NATIVE_SEARCH_QUALITY_UPGRADE_PLAN.md).
- [x] Add retrieval quality fixture pack at [`config/ci/retrieval-quality-fixture-pack.json`](/D:/GitProjects/context-engine/config/ci/retrieval-quality-fixture-pack.json).
- [x] Add deterministic quality report and gate scripts.
- [x] Add `npm` script wiring for quality report/gate execution.
- [x] Implement lexical retrieval scoring and weighted fusion in the internal retrieval pipeline.
- [x] Add unit tests for lexical scoring, fusion, and updated retrieval pipeline behavior.
- [x] Add CI tests for retrieval quality report/gate scripts.
- [x] Produce first retrieval-quality report/gate artifacts under `artifacts/bench/`.

Wave receipt:
- Owner: `Codex / multi-agent wave`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/internal/retrieval/lexical.test.ts tests/internal/retrieval/fusion.test.ts tests/internal/retrieval/retrieve.test.ts tests/ci/generateRetrievalQualityReport.test.ts tests/ci/checkRetrievalQualityGate.test.ts`, `npm run -s ci:check:retrieval-quality-gate`, `npm run build`

### 4.5 Local-Native Dense Scaffolding (Phase 2 start)
Wave owner: `Codex`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Add embedding and dense index scaffolding interfaces.
- [x] Add optional dense retrieval candidate scoring path behind `enableDense`.
- [x] Add persisted workspace dense index file path (`.context-engine-dense-index.json`).
- [x] Link dense index incremental refresh to index-state hashes (`.context-engine-index-state.json`).
- [x] Add dense refresh performance hardening (refresh-doc cap + embed batch sizing).
- [x] Add dense refresh telemetry counters/duration metrics.
- [x] Extend fusion to handle semantic + lexical + dense weighting.
- [x] Add and pass dense retrieval unit tests without changing default runtime behavior.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/internal/retrieval/dense.test.ts tests/internal/retrieval/denseIndex.test.ts tests/internal/retrieval/fusion.test.ts tests/internal/retrieval/retrieve.test.ts`, `npm run build`

### 4.6 Quality Telemetry Assertions + Phase 3 Rerank Guardrails
Wave owner: `Codex`
Wave date: `2026-03-11`
Wave status: `Completed`

Scope for this wave:
- [x] Add retrieval quality telemetry artifact generation.
- [x] Add JSON-path telemetry threshold checks to retrieval quality report generation.
- [x] Wire telemetry artifact generation into quality gate script chain.
- [x] Add optional reranker stage controls (`rerankTopN`, `rerankTimeoutMs`, provider hook).
- [x] Enforce reranker fail-open behavior on timeout/error.
- [x] Add tests for telemetry checks and reranker fail-open semantics.

Wave receipt:
- Owner: `Codex`
- Date: `2026-03-11`
- Status: `Pass`
- Evidence links: `npm test -- --runInBand tests/ci/generateRetrievalQualityTelemetry.test.ts tests/ci/generateRetrievalQualityReport.test.ts tests/ci/checkRetrievalQualityGate.test.ts tests/internal/retrieval/retrieve.test.ts tests/internal/retrieval/denseIndex.test.ts`, `npm run -s ci:check:retrieval-quality-gate`, `npm run build`, `npm run -s ci:check:no-legacy-provider`

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




