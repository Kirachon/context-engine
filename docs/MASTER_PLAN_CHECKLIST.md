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
- [ ] Assign an owner for each WS13-WS21 stream.
- [ ] Record assignment date and approver next to each WS heading.
- [ ] Do not start batch execution until all owners are assigned.

## B1) Shared Foundations (Cross-Tool Standardization)

### WS13 - Shared Validation Library
Owner: _TBD_ (blocker until assigned in B0)
Files:
- `src/mcp/tooling/validation.ts` (new)
- consumers in `src/mcp/tools/*`

Checklist:
- [x] Introduce reusable validators (`requiredString`, bounded numbers, enum checks, JSON string parsing).
- [ ] Replace duplicated per-tool validation blocks in remaining tools.
- [ ] Preserve current external error shape/semantics (no silent contract breaks).
- [x] Add unit tests for validator edge cases.

Progress notes:
- 2026-02-28: Shared validation module created at `src/mcp/tooling/validation.ts`.
- 2026-02-28: First migration slice complete for `semantic_search`, `get_file`, and `enhance_prompt`.
- 2026-02-28: Validator edge-case tests added at `tests/tooling/validation.test.ts`.
- 2026-02-28: Second migration slice complete for `check_invariants`, `review_diff`, and `review_changes`.
- 2026-02-28: Added focused validation tests for review tool diff/file-context/category paths.

### WS14 - Shared Tool Runtime Wrapper
Owner: _TBD_ (blocker until assigned in B0)
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
Owner: _TBD_ (blocker until assigned in B0)
Files:
- `src/mcp/tooling/diffInput.ts` (new)
- `src/mcp/tools/reviewAuto.ts`
- `src/mcp/tools/codeReview.ts`
- `src/mcp/tools/reviewDiff.ts`
- `src/mcp/tools/checkInvariants.ts`

Checklist:
- [ ] Normalize unified diff parsing and validation in one shared module.
- [ ] Enforce no-op/empty-scope protection consistently across review tools.
- [ ] Keep existing tool outputs stable while improving determinism.
- [ ] Add tests for malformed/empty/partial diff scenarios.

### WS16 - Shared Service Factory Pattern
Owner: _TBD_ (blocker until assigned in B0)
Files:
- `src/mcp/tooling/serviceFactory.ts` (new)
- planning/reactive tool modules

Checklist:
- [ ] Consolidate lazy singleton/cache lifecycle for MCP services.
- [ ] Remove duplicated weak-ref/service bootstrap patterns.
- [ ] Verify no stale-session regressions in reactive flows.
- [ ] Add targeted tests for service reuse and re-init paths.

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
- [ ] Align all input validation style and bounds.
- [ ] Align error messages and retry guidance consistency.
- [ ] Ensure telemetry parity fields exist across handlers.
- [ ] Expand contract tests/snapshots for full plan lifecycle.

### Batch B - Review Pipeline Family
Prerequisites:
- WS13 complete
- WS14 complete
- WS15 complete

Scope:
- `review_changes`, `review_git_diff`, `review_diff`, `review_auto`, `check_invariants`, `run_static_analysis`

Checklist:
- [ ] Shared diff validation integrated across all review entry points.
- [ ] Analyzer metadata consistency between standalone and review-driven static analysis.
- [ ] No-op review scope blocked with clear operator feedback.
- [ ] Failure-injection tests for invalid diff and empty scopes.

### Batch C - Index/Search Lifecycle Family
Prerequisites:
- WS13 complete
- WS14 complete

Scope:
- `index_workspace`, `reindex_workspace`, `clear_index`, `index_status`
- `codebase_retrieval`, `semantic_search`, `get_file`, `get_context_for_prompt`, `enhance_prompt`, `tool_manifest`

Checklist:
- [ ] Standardize input guards and size limits across lifecycle/search tools.
- [ ] Add index freshness sanity guards for perf claims.
- [ ] Verify parity script robustness against formatting/refactor drift.
- [ ] Add focused regression tests for unhealthy index and stale status paths.

### Batch D - Memory + Reactive Utility Family
Prerequisites:
- WS13 complete
- WS14 complete
- WS16 complete

Scope:
- `add_memory`, `list_memories`
- `reactive_review_pr`, `get_review_status`, `pause_review`, `resume_review`, `get_review_telemetry`, `scrub_secrets`, `validate_content`

Checklist:
- [ ] Complete shared validation/runtime migration.
- [ ] Harden partial-failure/idempotency behavior for sessioned operations.
- [ ] Ensure background execution failures are observable via status/telemetry.
- [ ] Add integration tests for pause/resume/fail/recover sequences.

---

## B3) Compatibility + Contract Assurance

### WS17 - Old-Client Replay Compatibility Suite
Checklist:
- [ ] Create/expand old-client fixture set for all tool families.
- [ ] Run replay suite against updated server.
- [ ] Confirm no unintended response-shape drift.
- [ ] Document any intentional deltas with migration notes.

### WS18 - Versioning and Contract Policy
Checklist:
- [ ] Document canonical version source and update policy.
- [ ] Define deprecation path and no-silent-break rule in docs.
- [ ] Add CI check preventing inconsistent version literals.

---

## B4) Performance, Safety, and Rollout Governance

### WS19 - Quantitative SLO Gate Pack
Checklist:
- [ ] Define per-family p95/error/timeout/throughput thresholds.
  - Review tools: p95 <= 500ms, error rate < 1.0%, timeout < 30s.
  - Index/search tools: p95 <= 2s, error rate < 0.5%, timeout < 60s.
  - Planning/lifecycle tools: p95 <= 1s, error rate < 1.0%, timeout < 45s.
- [ ] Add CI fail gates tied to thresholds.
- [ ] Add stale-cache correctness guard checks.

### WS20 - Rollout Stage Gates (Numeric)
Checklist:
- [ ] Pre-rollout checklist with baseline snapshot.
- [ ] Canary gate (1-5%) with 24h soak and strict exit criteria.
- [ ] Controlled ramp gate (10->25->50%) with signed checkpoints and soak windows.
  - 10%: 24h, 25%: 48h, 50%: 72h.
- [ ] GA hardening gate (24h stability + closeout evidence).

### WS21 - Rollback Drill + Evidence Completeness
Checklist:
- [ ] Execute and record rollback drill for remaining roadmap batches.
- [ ] Capture command path, owner, timestamps, recovery evidence.
- [ ] Confirm no unresolved blockers before freeze lift.

---

## C) Global Validation Gates (Must Pass Before “All Done”)
- [ ] Owner assignment lock passed (B0 complete)
- [ ] `npx tsc --noEmit`
- [ ] Full targeted test matrix for all migrated families
- [ ] `node --import tsx scripts/ci/check-tool-manifest-parity.ts`
- [ ] `node --import tsx scripts/ci/check-rollout-readiness.ts`
- [ ] `node --import tsx scripts/ci/validate-master-plan.ts` (checklist/evidence validator)
- [ ] Compatibility replay suite pass
- [ ] Benchmark/regression gate suite pass

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
- [ ] 2026-02-28: Added governance rules, owner lock, batch prerequisites, quantitative SLO/soak thresholds, and rollback triggers.
- [x] 2026-02-28: Implemented WS13 first migration slice (shared validators + 3 tools + validator tests).
- [x] 2026-02-28: Implemented WS13 second migration slice (review tool validation migration + new validation tests).
- [x] 2026-02-28: Completed WS14 shared runtime wrapper with server integration (`src/mcp/server.ts`) and regression tests (`tests/tooling/runtime.test.ts`).
