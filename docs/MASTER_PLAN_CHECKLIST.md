# Master Plan Checklist

Purpose: one complete execution checklist to finish all remaining roadmap work end-to-end.

How to use:
- Keep this as the single source of truth for rollout progress.
- Mark each item only after evidence is linked and review-approved.
- Do not advance rollout stage if any blocking gate item is unchecked.

Evidence minimums:
- CI/test evidence: link to a passing run that includes the scoped suite.
- Gate evidence: link or paste pass output from named gate script.
- Code evidence: merged PR/commit reference with reviewer approval.

Document governance:
- All edits to this file must land via reviewed PR/commit.
- Only designated rollout owners can mark `[x]` for WS and batch items.
- Keep a short changelog entry whenever scope, thresholds, or gates change.

---

## A) Completed Foundation Waves (Already Implemented)

### Wave 1 - Bench + Gate Foundations
- [x] Benchmark provenance validation added.
- [x] Mode/dataset parity checks enforced.
- [x] Release gate mode/artifact alignment completed.
- [x] Tool inventory parity checker added.
- [x] Readiness quality checks added.

### Wave 2 - Tooling Hardening
- [x] Unified registry for tool listing + dispatch.
- [x] Cross-tool input guards strengthened.
- [x] Reactive argument validation hardened.
- [x] Wave 2 validation gates passed.

### Wave 3 - Resilience + Coverage
- [x] Benchmark edge-case math hardening.
- [x] Release benchmark memory footprint reduced.
- [x] Service indexing resilience and timestamp safety improved.
- [x] Focused regression tests added for key guard paths.
- [x] Wave 3 validation gates passed.

### Wave 4 - Contract/Runtime Alignment
- [x] `resume_review` now performs true resume execution path.
- [x] Reactive schema parity updated (`max_workers` surfaced).
- [x] Version metadata unified across server/manifest/log banner.
- [x] Runtime tool count logging derived from live registry.
- [x] Static analyzer total runtime budget guard added.
- [x] Semgrep empty/large changed-files behavior clarified and tested.
- [x] Wave 4 validation gates passed.

---

## B) Remaining Master Roadmap (Implement All)

### B0) Prerequisite Ownership Lock
- [x] Assign an owner for each WS13-WS21 stream.
- [x] Record assignment date and approver next to each WS heading.
- [x] Do not start batch execution until all owners are assigned.

Lock artifact:
- `docs/WS_OWNER_ASSIGNMENT_LOCK.md`

## B1) Shared Foundations (Cross-Tool Standardization)

### WS13 - Shared Validation Library
Owner: validation-library-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver
Files:
- `src/mcp/tooling/validation.ts` (new)
- consumers in `src/mcp/tools/*`

Checklist:
- [x] Introduce reusable validators (`requiredString`, bounded numbers, enum checks, JSON string parsing).
- [x] Replace duplicated per-tool validation blocks in remaining tools.
- [x] Preserve current external error shape/semantics (no silent contract breaks).
- [x] Add unit tests for validator edge cases.

Progress notes:
- 2026-02-28: Shared validation module created at `src/mcp/tooling/validation.ts`.
- 2026-02-28: First migration slice complete for `semantic_search`, `get_file`, and `enhance_prompt`.
- 2026-02-28: Validator edge-case tests added at `tests/tooling/validation.test.ts`.
- 2026-02-28: Second migration slice complete for `check_invariants`, `review_diff`, and `review_changes`.
- 2026-02-28: Added focused validation tests for review tool diff/file-context/category paths.
- 2026-02-28: Third migration slice applied shared finite-range validation to `codebase_retrieval`, `semantic_search`, and `get_context_for_prompt`; added memory validation coverage in `tests/tools/memory.test.ts`.
- 2026-02-28: Fourth migration slice applied shared validation helpers in `create_plan` / `refine_plan` / `visualize_plan` and `planManagement` handlers (save/delete/request/respond/fail paths), with focused regression coverage in `tests/tools/plan.test.ts` and `tests/tools/planManagement.test.ts`.
- 2026-02-28: Fifth migration slice introduced shared `validateRequiredNumber` helper and adopted it in `planManagement` step/version handlers (`start/complete/fail/compare/rollback`) with expanded regression checks in `tests/tools/planManagement.test.ts`.
- 2026-02-28: Sixth migration slice introduced shared `validateTrimmedNonEmptyString` and adopted it in `semantic_search`, `codebase_retrieval`, `get_context_for_prompt`, and `create_plan` task validation; added helper coverage in `tests/tooling/validation.test.ts` and revalidated affected tool suites.
- 2026-02-28: Batch A slice 1 finished remaining planning-family shared-validation migration by removing custom string-like validation in `src/mcp/tools/planManagement.ts`, routing required field checks through shared helpers, and deduplicating `single_step` validation in `src/mcp/tools/plan.ts`; evidence: `npm test -- tests/tools/plan.test.ts tests/tools/planManagement.test.ts` and `npx tsc --noEmit` (both pass).
- 2026-02-28: Final WS13 dedup slice migrated remaining inline optional-string and bounded-integer validation paths in `src/mcp/tools/codeReview.ts` and `src/mcp/tools/reactiveReview.ts` to shared helpers (`validateOptionalString`, `validateTrimmedRequiredStringWithMaxLength`, `validateOptionalNonNegativeIntegerWithMax`) with helper coverage in `tests/tooling/validation.test.ts`; evidence: `npm test -- tests/tooling/validation.test.ts tests/tools/reviewChanges.validation.test.ts tests/tools/reactiveReview.test.ts`.
- 2026-02-28: Added contract-level error-shape safeguards for planning and plan-management failure envelopes (`tests/tools/planLifecycle.contract.test.ts`, `tests/tools/planManagement.contract.test.ts`) to prevent silent external error semantic drift while retaining existing message text.

### WS14 - Shared Tool Runtime Wrapper
Owner: runtime-wrapper-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver
Files:
- `src/mcp/tooling/runtime.ts` (new)
- `src/mcp/server.ts` and tool handlers using wrapper

Checklist:
- [x] Centralize consistent timing/error wrapping for tool handlers.
- [x] Preserve existing MCP success/error envelope behavior.
- [x] Ensure telemetry labels remain stable.
- [x] Add regression tests for wrapper error-path behavior.

Progress notes:
- 2026-02-28: Server integration is present in `src/mcp/server.ts` via shared runtime execution for `CallToolRequestSchema`.
- 2026-02-28: MCP response envelope behavior remains aligned (`content[].text` on success; `isError: true` + `Error: ...` on failures).
- 2026-02-28: Telemetry emission remains consistent using `context_engine_mcp_tool_calls_total` and `context_engine_mcp_tool_call_duration_seconds` with `{ tool, result }` labels.
- 2026-02-28: Dedicated wrapper module added at `src/mcp/tooling/runtime.ts` with explicit error/success path regression tests in `tests/tooling/runtime.test.ts`.

### WS15 - Shared Diff Input Parser
Owner: diff-input-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver
Files:
- `src/mcp/tooling/diffInput.ts` (new)
- `src/mcp/tools/reviewAuto.ts`
- `src/mcp/tools/codeReview.ts`
- `src/mcp/tools/reviewDiff.ts`
- `src/mcp/tools/checkInvariants.ts`

Checklist:
- [x] Normalize unified diff parsing and validation in one shared module.
- [x] Enforce no-op/empty-scope protection consistently across review tools.
- [x] Keep existing tool outputs stable while improving determinism.
- [x] Add tests for malformed/empty/partial diff scenarios.

Progress notes:
- 2026-02-28: Added shared diff input helper module at `src/mcp/tooling/diffInput.ts` with optional/required normalization plus unified-diff shape checks.
- 2026-02-28: Migrated `review_auto`, `review_diff`, `check_invariants`, and `review_changes` to shared diff helpers while preserving existing external error semantics.
- 2026-02-28: Added WS15 malformed/empty/partial diff coverage in `tests/tooling/diffInput.test.ts`, `tests/tools/reviewAuto.test.ts`, `tests/tools/reviewDiff.test.ts`, `tests/tools/checkInvariants.test.ts`, and `tests/tools/reviewChanges.validation.test.ts`.
- 2026-02-28: Added shared no-op scope guard (`assertNonEmptyDiffScope`) and applied it across `review_diff`, `check_invariants`, and `review_changes`, with compatibility tests for explicit `changed_files` scope overrides.

### WS16 - Shared Service Factory Pattern
Owner: service-factory-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver
Files:
- `src/mcp/tooling/serviceFactory.ts` (new)
- planning/reactive tool modules

Checklist:
- [x] Consolidate lazy singleton/cache lifecycle for MCP services.
- [x] Remove duplicated weak-ref/service bootstrap patterns.
- [x] Verify no stale-session regressions in reactive flows.
- [x] Add targeted tests for service reuse and re-init paths.

Progress notes:
- 2026-02-28: Added shared client-bound service factory at `src/mcp/tooling/serviceFactory.ts` for WeakRef-based lazy service reuse and explicit reset support, reducing duplicate lifecycle code and improving test isolation.
- 2026-02-28: Migrated duplicated service bootstrap logic in `src/mcp/tools/plan.ts`, `src/mcp/tools/reactiveReview.ts`, and `src/internal/handlers/codeReview.ts` to the shared factory.
- 2026-02-28: Added targeted reuse/re-init tests in `tests/tooling/serviceFactory.test.ts` and `tests/internal/handlers/codeReview.test.ts`; validated no reactive flow regressions with `tests/tools/reactiveReview.test.ts`.

---

## B2) Tool Family Completion Batches

### Batch A - Planning + Plan Management Family
Prerequisites:
- WS13 complete
- WS14 complete

Scope:
- `create_plan`, `refine_plan`, `visualize_plan`, `execute_plan`
- `save/load/list/delete/request/respond/start/complete/fail/view_progress/view_history/compare/rollback`

Checklist:
- [x] Align all input validation style and bounds.
- [x] Align error messages and retry guidance consistency.
- [x] Ensure telemetry parity fields exist across handlers.
- [x] Expand contract tests/snapshots for full plan lifecycle.

Progress notes:
- 2026-02-28: Added additive contract snapshot suites for full planning lifecycle and management handlers in `tests/tools/planLifecycle.contract.test.ts` and `tests/tools/planManagement.contract.test.ts`.
- 2026-02-28: Completed planning-family input validation alignment by adopting shared validation helpers for `execute_plan` (`mode`, `plan_id`, `max_steps`, boolean flags) and `planManagement` (`load_plan` non-empty ID/name checks, `list_plans` finite positive `limit`, `respond_approval` action enum guard); evidence: `npm test -- tests/tools/plan.test.ts tests/tools/planManagement.test.ts tests/tools/planLifecycle.contract.test.ts tests/tools/planManagement.contract.test.ts` and `npx tsc --noEmit`.
- 2026-02-28: Standardized operation-level failure responses in plan-management handlers with additive `retry_guidance` while preserving existing error strings (`load_plan`, `start_step`, `complete_step`, `fail_step`, `view_progress`, `view_history`, `compare_plan_versions`); evidence: `npm test -- tests/tools/planManagement.test.ts tests/tools/planManagement.contract.test.ts`.
- 2026-02-28: Added additive planning telemetry parity metadata (`_meta.tool`, `_meta.duration_ms`, `_meta.status`) across `create_plan`, `refine_plan`, `visualize_plan`, and `execute_plan` outputs, including lifecycle contract assertions; evidence: `npm test -- tests/tools/plan.test.ts tests/tools/planLifecycle.contract.test.ts`.

### Batch B - Review Pipeline Family
Prerequisites:
- WS13 complete
- WS14 complete
- WS15 complete

Scope:
- `review_changes`, `review_git_diff`, `review_diff`, `review_auto`, `check_invariants`, `run_static_analysis`

Checklist:
- [x] Shared diff validation integrated across all review entry points.
- [x] Analyzer metadata consistency between standalone and review-driven static analysis.
- [x] No-op review scope blocked with clear operator feedback.
- [x] Failure-injection tests for invalid diff and empty scopes.

Progress notes:
- 2026-02-28: Added `review_diff` static-analysis metadata parity block (`static_analysis`) including requested/executed analyzers, per-analyzer results, and scoped warnings.
- 2026-02-28: Switched `review_git_diff` empty-scope behavior from silent empty-success payload to explicit blocking error with operator guidance; `review_auto` inherits this when routing to git review.
- 2026-02-28: Expanded failure-injection coverage for malformed diff inputs and empty-scope review paths across `review_diff`, `check_invariants`, `review_changes`, `review_git_diff`, and `review_auto`.

### Batch C - Index/Search Lifecycle Family
Prerequisites:
- WS13 complete
- WS14 complete

Scope:
- `index_workspace`, `reindex_workspace`, `clear_index`, `index_status`
- `codebase_retrieval`, `semantic_search`, `get_file`, `get_context_for_prompt`, `enhance_prompt`, `tool_manifest`

Checklist:
- [x] Standardize input guards and size limits across lifecycle/search tools.
- [x] Add index freshness sanity guards for perf claims.
- [x] Verify parity script robustness against formatting/refactor drift.
- [x] Add focused regression tests for unhealthy index and stale status paths.

Progress notes:
- 2026-02-28: Added additive freshness classification/metadata in `index_workspace`, `reindex_workspace`, and `clear_index` outputs, and expanded `index_status` with explicit freshness guidance for stale/unindexed/error states.
- 2026-02-28: Added index health signaling in `codebase_retrieval`, `semantic_search`, and `get_context_for_prompt` so stale/unhealthy index states are visible alongside retrieval/performance output.
- 2026-02-28: Standardized lifecycle/search input normalization and guard behavior (trimmed query handling, finite numeric range enforcement) with backward-compatible output contracts.
- 2026-02-28: Added targeted stale/unhealthy regression tests in `tests/tools/lifecycle.test.ts`, `tests/tools/status.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/tools/search.test.ts`, and `tests/tools/context.test.ts`.
- 2026-02-28: Hardened `scripts/ci/check-tool-manifest-parity.ts` against formatting/refactor drift by deriving runtime inventory from both `findToolByName(...)` calls and direct `{ tool: ... }` registrations resolved via exported tool constants; coverage/evidence is the parity gate execution path (`node --import tsx scripts/ci/check-tool-manifest-parity.ts`) recorded in `docs/ROLLOUT_EVIDENCE_LOG.md`.

### Batch D - Memory + Reactive Utility Family
Prerequisites:
- WS13 complete
- WS14 complete
- WS16 complete

Scope:
- `add_memory`, `list_memories`
- `reactive_review_pr`, `get_review_status`, `pause_review`, `resume_review`, `get_review_telemetry`, `scrub_secrets`, `validate_content`

Checklist:
- [x] Complete shared validation/runtime migration.
- [x] Harden partial-failure/idempotency behavior for sessioned operations.
- [x] Ensure background execution failures are observable via status/telemetry.
- [x] Add integration tests for pause/resume/fail/recover sequences.

Progress notes:
- 2026-02-28: Reactive utility validation paths were consolidated in `src/mcp/tools/reactiveReview.ts` by removing duplicated pre-check branches and routing required-string/length enforcement through shared helpers while preserving existing operator-facing error text; validated by `tests/tools/reactiveReview.test.ts`.
- 2026-02-28: Expanded `tests/tools/reactiveReview.test.ts` with failure-observability coverage (`get_review_status`/`get_review_telemetry` on errored sessions) and pause/resume lifecycle assertions to support Batch D reliability gates.
- 2026-02-28: Hardened pause/resume idempotency in `src/mcp/tools/reactiveReview.ts` (`already paused`/`already executing` no-op success paths), added telemetry exposure fields (`session_status`, `session_error`) for failed sessions, and expanded pause/resume/fail/recover integration coverage in `tests/tools/reactiveReview.test.ts`.

---

## B3) Compatibility + Contract Assurance

### WS17 - Old-Client Replay Compatibility Suite
Owner: compatibility-suite-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver

Checklist:
- [x] Create/expand old-client fixture set for all tool families.
- [x] Run replay suite against updated server.
- [x] Confirm no unintended response-shape drift.
- [x] Document any intentional deltas with migration notes.

Progress notes:
- 2026-02-28: Executed snapshot replay harness and updated compatibility baselines for additive/index-health/tool-manifest deltas; reran replay to pass. Migration notes captured in `docs/COMPATIBILITY_REPLAY_NOTES_2026-02-28.md`.
- 2026-02-28: Added `tests/snapshots/phase2/fixtures/old-client-tool-families.json` with coverage for all currently registered tool families/tools; wired fixture validation into `tests/snapshots/snapshot-harness.ts`; verified with `npm test -- tests/snapshots/oldClientFixtures.test.ts` and `node --import tsx tests/snapshots/snapshot-harness.ts`.

### WS18 - Versioning and Contract Policy
Owner: versioning-policy-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver

Checklist:
- [x] Document canonical version source and update policy.
- [x] Define deprecation path and no-silent-break rule in docs.
- [x] Add CI check preventing inconsistent version literals.

Progress notes:
- 2026-02-28: Added WS18 policy doc `docs/VERSIONING_CONTRACT_POLICY.md` defining canonical version source (`package.json`), release update policy, deprecation flow, and no-silent-break contract rule.
- 2026-02-28: Added deterministic CI gate `scripts/ci/check-version-literals.ts` to enforce `package.json` parity for `MCP_SERVER_VERSION` and review-diff `TOOL_VERSION`.
- 2026-02-28: Wired the gate into GitHub Actions by adding a `Check version literal consistency` step in `.github/workflows/review_diff.yml`.
- 2026-02-28: Added focused CI script regression coverage in `tests/ci/checkVersionLiterals.test.ts` and passed evidence commands:
  - `node --import tsx scripts/ci/check-version-literals.ts`
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/ci/checkVersionLiterals.test.ts`

---

## B4) Performance, Safety, and Rollout Governance

### WS19 - Quantitative SLO Gate Pack
Owner: slo-gate-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver

Checklist:
- [x] Define per-family p95/error/timeout/throughput thresholds.
  - Review tools: p95 <= 500ms, error rate < 1.0%, timeout < 30s.
  - Index/search tools: p95 <= 2s, error rate < 0.5%, timeout < 60s.
  - Planning/lifecycle tools: p95 <= 1s, error rate < 1.0%, timeout < 45s.
- [x] Add CI fail gates tied to thresholds.
- [x] Add stale-cache correctness guard checks.

Progress notes:
- 2026-02-28: Added deterministic CI guard script `scripts/ci/check-stale-cache-guards.ts` that enforces stale/unhealthy index coverage anchors and cache safeguard anchors in concrete test files (`tests/tools/status.test.ts`, `tests/tools/search.test.ts`, `tests/tools/context.test.ts`, `tests/tools/codebaseRetrieval.test.ts`, `tests/serviceClient.test.ts`).
- 2026-02-28: Added focused regression tests for the guard in `tests/ci/checkStaleCacheGuards.test.ts` (pass/fail fixture cases), wired guard to CI via `.github/workflows/review_diff.yml`, and added `npm run ci:check:stale-cache-guards`.
- 2026-02-28: Validation evidence:
  - `npm run ci:check:stale-cache-guards`
  - `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/ci/checkStaleCacheGuards.test.ts tests/tools/status.test.ts tests/tools/search.test.ts tests/tools/context.test.ts tests/tools/codebaseRetrieval.test.ts tests/serviceClient.test.ts`
  - `npx tsc --noEmit`
- 2026-02-28: Added WS19 deterministic threshold gate `scripts/ci/ws19-slo-gate.ts` with explicit per-family p95/error/timeout/throughput policy and deterministic artifact extraction from existing benchmark/review outputs.
- 2026-02-28: Wired WS19 fail gates into `.github/workflows/perf_gates.yml`, `.github/workflows/release_perf_gate.yml`, and `.github/workflows/review_diff.yml`.
- 2026-02-28: Added WS19 gate policy/mapping doc at `docs/WS19_SLO_GATE.md` and linked from `docs/BENCHMARKING_GATES.md`.
- 2026-02-28: Added focused WS19 gate regression tests in `tests/ci/ws19SloGate.test.ts`.
- 2026-02-28: Validation evidence (WS19 thresholds):
  - `npm test -- tests/ci/ws19SloGate.test.ts`
  - `node --import tsx scripts/ci/ws19-slo-gate.ts --family index_search --artifact artifacts/bench/pr-candidate.json`
  - `node --import tsx scripts/ci/ws19-slo-gate.ts --family index_search --artifact artifacts/bench/nightly-candidate.json`
  - `node --import tsx scripts/ci/ws19-slo-gate.ts --family index_search --artifact artifacts/bench/release/release-candidate-median.json`
  - `npx tsc --noEmit`

### WS20 - Rollout Stage Gates (Numeric)
Owner: stage-gate-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver

Checklist:
- [x] Deterministic WS20 evidence gate script added (`scripts/ci/ws20-stage-gate.ts`) for numeric stages 0-3.
- [x] Structured operator artifacts added (`docs/templates/ws20-stage-evidence.template.yaml`, `docs/examples/ws20-stage-evidence.sample.yaml`).
- [x] Focused WS20 gate regression tests added (`tests/ci/ws20StageGate.test.ts`).
- [x] Non-destructive CI hook added in `.github/workflows/review_diff.yml` (runs only when `artifacts/ws20-stage-evidence.*` exists).
- [x] Pre-rollout checklist template with baseline snapshot fields added (`docs/templates/pre-rollout-baseline-checklist.template.md`).
- [ ] Canary gate (1-5%) with 24h soak and strict exit criteria.
- [ ] Controlled ramp gate (10->25->50%) with signed checkpoints and soak windows.
  - 10%: 24h, 25%: 48h, 50%: 72h.
- [ ] GA hardening gate (24h stability + closeout evidence).

Progress notes:
- 2026-02-28: Added deterministic WS20 stage gate validator `scripts/ci/ws20-stage-gate.ts` with structured artifact parsing (JSON/YAML/Markdown) and explicit numeric gate checks for pre-rollout, canary, controlled ramp, and GA hardening.
- 2026-02-28: Added operator template/sample artifacts at `docs/templates/ws20-stage-evidence.template.yaml` and `docs/examples/ws20-stage-evidence.sample.yaml`.
- 2026-02-28: Added focused regression coverage in `tests/ci/ws20StageGate.test.ts` and wired optional CI enforcement in `.github/workflows/review_diff.yml`.
- 2026-02-28: Validation evidence (WS20 stage gates):
  - `npm test -- tests/ci/ws20StageGate.test.ts`
  - `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact docs/examples/ws20-stage-evidence.sample.yaml`
  - `npx tsc --noEmit`
  - `node --import tsx scripts/ci/validate-master-plan.ts`
- 2026-02-28: Added pre-rollout baseline operator checklist template (`docs/templates/pre-rollout-baseline-checklist.template.md`) for stage 0 readiness evidence.
- 2026-02-28: Single-user dry-run evidence artifacts generated under `artifacts/ws20/` (`stage-0-pre-rollout.yaml`, `stage-1-canary.yaml`, `stage-2-controlled-ramp.yaml`, `stage-3-ga-hardening.yaml`) and validated with:
  - `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact artifacts/ws20/stage-0-pre-rollout.yaml --stage 0`
  - `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact artifacts/ws20/stage-1-canary.yaml --stage 1`
  - `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact artifacts/ws20/stage-2-controlled-ramp.yaml --stage 2`
  - `node --import tsx scripts/ci/ws20-stage-gate.ts --artifact artifacts/ws20/stage-3-ga-hardening.yaml --stage 3`

### WS21 - Rollback Drill + Evidence Completeness
Owner: rollback-drill-owner
Assignment Date: 2026-02-28
Approver: release-governance-approver

Checklist:
- [ ] Execute and record rollback drill for remaining roadmap batches.
- [ ] Capture command path, owner, timestamps, recovery evidence.
- [ ] Confirm no unresolved blockers before freeze lift.
- [x] Add deterministic WS21 evidence completeness checker for required rollback drill fields.
- [x] Add operator-facing WS21 rollback drill template + sample evidence and validate both via CI script.
- [x] Add deterministic governance artifact checker for pre-rollout/freeze/final-summary/rollout-log completeness fields.
- [x] Add operator templates for freeze checklist and final release summary, plus rollout evidence update path/template.

Progress notes:
- 2026-02-28: Added deterministic evidence checker `scripts/ci/check-ws21-rollback-drill.ts` to enforce required fields (`Command Path`, `Owner`, `Started At (UTC)`, `Ended At (UTC)`, `Recovery Evidence`, `Blocker Status`) plus unresolved-blocker rejection.
- 2026-02-28: Added operator artifacts `docs/WS21_ROLLBACK_DRILL_TEMPLATE.md` and `docs/WS21_ROLLBACK_DRILL_SAMPLE.md`; wired CI script `npm run ci:check:ws21-rollback-drill`.
- 2026-02-28: Added governance artifact templates (`docs/templates/freeze-checklist.template.md`, `docs/templates/final-release-summary.template.md`, `docs/templates/rollout-evidence-entry.template.md`) and rollout evidence update path section in `docs/ROLLOUT_EVIDENCE_LOG.md`.
- 2026-02-28: Added deterministic checker `scripts/ci/check-governance-artifacts.ts` with focused tests in `tests/ci/checkGovernanceArtifacts.test.ts`, package script `npm run ci:check:governance-artifacts`, and non-destructive workflow wiring in `.github/workflows/review_diff.yml` (optional runtime-artifact validation step).
- 2026-02-28: Single-user dry-run rollback drill evidence created at `artifacts/governance/ws21-rollback-drill-single-user.md` (with recovery pointer `artifacts/governance/ws21-recovery-evidence.txt`) and validated with `node --import tsx scripts/ci/check-ws21-rollback-drill.ts artifacts/governance/ws21-rollback-drill-single-user.md`.

---

## C) Global Validation Gates (Must Pass Before “All Done”)
- [x] Owner assignment lock passed (B0 complete)
- [x] `npx tsc --noEmit`
- [x] Full targeted test matrix for all migrated families (`npm run ci:matrix:migrated-families`)
- [x] `node --import tsx scripts/ci/check-tool-manifest-parity.ts`
- [x] `node --import tsx scripts/ci/check-version-literals.ts`
- [x] `node --import tsx scripts/ci/check-rollout-readiness.ts`
- [x] `node --import tsx scripts/ci/validate-master-plan.ts` (checklist/evidence validator)
- [x] Compatibility replay suite pass
- [x] Benchmark/regression gate suite pass

## E) Rollback Triggers
- [ ] Any gate in Section C fails after rollout stage advancement.
- [ ] Any P0/P1 finding appears in post-change auto review.
- [ ] Canary/ramp SLO breaches threshold for more than one soak checkpoint.
- [ ] Execute WS21 rollback drill procedure and log evidence immediately.

---

## D) Definition of Done (Master)
- [ ] All WS13-WS21 checklist items complete.
- [ ] No P0/P1 unresolved findings from latest auto review.
- [ ] Rollout evidence log updated for final stage.
- [ ] Freeze checklist fully checked.
- [ ] Final release summary recorded with commit references.

---

## Changelog
- [x] 2026-02-28: Added governance rules, owner lock, batch prerequisites, quantitative SLO/soak thresholds, and rollback triggers.
- [x] 2026-02-28: Implemented WS20 deterministic stage evidence gates by adding `scripts/ci/ws20-stage-gate.ts`, operator artifacts (`docs/templates/ws20-stage-evidence.template.yaml`, `docs/examples/ws20-stage-evidence.sample.yaml`), focused tests (`tests/ci/ws20StageGate.test.ts`), and optional CI wiring in `.github/workflows/review_diff.yml`.
- [x] 2026-02-28: Implemented WS19 deterministic threshold gates by adding `scripts/ci/ws19-slo-gate.ts`, documenting per-family artifact mapping and fail/skip handling in `docs/WS19_SLO_GATE.md`, wiring enforcement in performance/review CI workflows, and adding `tests/ci/ws19SloGate.test.ts`.
- [x] 2026-02-28: Implemented WS13 first migration slice (shared validators + 3 tools + validator tests).
- [x] 2026-02-28: Implemented WS13 second migration slice (review tool validation migration + new validation tests).
- [x] 2026-02-28: Completed WS14 shared runtime wrapper with server integration (`src/mcp/server.ts`) and regression tests (`tests/tooling/runtime.test.ts`).
- [x] 2026-02-28: WS15 major migration completed: shared `diffInput` module adopted by review entry tools with malformed/empty/partial diff regression coverage; no-op/empty-scope policy item remains open.
- [x] 2026-02-28: Completed WS18 policy + parity gate by adding `docs/VERSIONING_CONTRACT_POLICY.md`, `scripts/ci/check-version-literals.ts`, `tests/ci/checkVersionLiterals.test.ts`, and CI workflow enforcement in `.github/workflows/review_diff.yml` with passing evidence commands.
- [x] 2026-02-28: Batch A slice 1 completed planning-family shared-validation migration follow-up in `src/mcp/tools/planManagement.ts` and `src/mcp/tools/plan.ts` with focused regression coverage in `tests/tools/planManagement.test.ts` and `tests/tools/plan.test.ts`; validation evidence: `npm test -- tests/tools/plan.test.ts tests/tools/planManagement.test.ts`, `npx tsc --noEmit`.
- [x] 2026-02-28: Implemented B0 owner-assignment lock by adding `docs/WS_OWNER_ASSIGNMENT_LOCK.md`, `scripts/ci/check-ws-owner-assignment-lock.ts`, focused tests (`tests/ci/checkWsOwnerAssignmentLock.test.ts`), CI wiring in `.github/workflows/review_diff.yml`, and package script `ci:check:ws-owner-assignment-lock`; WS13-WS21 headings now include owner, assignment date, and approver.
- [x] 2026-02-28: Implemented deterministic migrated-family targeted matrix gate via `scripts/ci/run-migrated-family-matrix.ts`, wired npm command `ci:matrix:migrated-families` in `package.json`, added CI enforcement step in `.github/workflows/review_diff.yml`, and validated with `npm run ci:matrix:migrated-families`, `npx tsc --noEmit`, and `node --import tsx scripts/ci/validate-master-plan.ts`.
