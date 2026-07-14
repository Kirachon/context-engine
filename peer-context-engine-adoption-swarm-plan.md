# Plan: Peer Context-Engine Handoff Swarm Plan

**Generated**: 2026-04-19

## Overview
The retrieval-side adoption work from peer context-engine projects is already largely implemented in this repo. The remaining gap is continuation context: enabling agents to pick up active work without re-learning the plan, constraints, and recent durable findings.

This tranche delivers a bounded handoff layer on top of the existing context engine. It adds additive `get_context_for_prompt` inputs for handoff mode, composes a fixed continuation bundle from durable records, keeps retrieval internals reusable, and preserves current behavior when handoff mode is off.

## Scope Lock
- In scope:
  - additive `handoff_mode` and `plan_id` support on `get_context_for_prompt`
  - bounded handoff bundle assembly above `ContextServiceClient`
  - durable-source composition using persisted plan state, all persisted `.memories` entries, and the subset of those entries tagged `subtype=review_finding`
  - deterministic failure semantics, cache identity updates, dedupe rules, and contract/snapshot coverage
  - HTTP parity for `/api/v1/context` in the same tranche unless blocked by existing route constraints
- Out of scope:
  - retrieval routing changes
  - symbol or search tool renames
  - new retrieval diagnostics contracts
  - new review-findings storage subsystem
  - use of draft memory suggestions in handoff bundles
- Files or surfaces likely to change:
  - `src/mcp/tools/context.ts`, `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, `src/http/routes/tools.ts`
  - `src/mcp/tooling/discoverability.ts`, manifest/snapshot baselines, context-related tests
  - plan/memory access surfaces under `src/mcp/tools/planManagement.ts`, existing memory tooling, and HTTP compatibility tests

## Prerequisites
- Existing declaration-routing retrieval remains the baseline and must not be changed by this tranche.
- Plan persistence services are already initialized and available to the MCP server and HTTP server.
- In this tranche, `approved_memories` means all persisted `.memories` entries. `recent_review_findings` is the subset of persisted memories tagged `subtype=review_finding`.
- MCP `get_context_for_prompt` currently accepts flat snake_case args and returns formatted markdown, while `/api/v1/context` currently accepts `{ query, options }` and returns raw JSON. The exact parity contract must be frozen before schema work.

## Dependency Graph

```text
T0 -> T1 -> T5 -> T7 -> T8 -> T9
T0 -> T2 -> T6 -> T8
T0 -> T3 -> T5
T0 -> T4 -> T5
T4 -> T6
T4 -> T7
```

## Tasks

### T0: Freeze handoff scope, source contracts, and HTTP parity
- **depends_on**: []
- **location**: `peer-context-engine-adoption-plan.md`, `src/mcp/tools/context.ts`, `src/http/routes/tools.ts`, `src/mcp/tools/planManagement.ts`
- **description**: Freeze the implementation contract for this tranche: `handoff_mode` is additive only, `plan_id` is required only for active handoff mode, review findings come from persisted memory entries with `subtype=review_finding`, retrieval behavior stays unchanged, and `approved_memories` means all persisted `.memories` entries. Lock the exact HTTP parity contract against the current `/api/v1/context` shape: either HTTP accepts `options.handoff_mode` and `options.plan_id` and returns a raw `handoff` JSON field, or it returns a deterministic unsupported response. Record the fixed handoff payload shape and failure semantics before touching tool schemas.
- **validation**: Finalized contract is reflected in the swarm plan and no task below depends on inventing a new review-findings store, changing retrieval routing, or guessing the HTTP request/response shape.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T1: Add MCP handoff inputs and schema parity
- **depends_on**: [T0]
- **location**: `src/mcp/tools/context.ts`, `src/mcp/tooling/discoverability.ts`, manifest/snapshot surfaces
- **description**: Add `handoff_mode?: "none" | "active_plan"` and `plan_id?: string` to the MCP `get_context_for_prompt` tool contract. Enforce that `plan_id` is required only when `handoff_mode` is `"active_plan"`. Update discoverability metadata and any manifest/client-compat baselines that expose tool inputs.
- **validation**: Tool schema validation passes; discoverability and manifest snapshots reflect the additive inputs; default behavior remains unchanged when `handoff_mode` is omitted.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T2: Add HTTP handoff inputs and route validation
- **depends_on**: [T0]
- **location**: `src/http/routes/tools.ts`
- **description**: Extend `/api/v1/context` request validation to match the frozen HTTP parity contract from `T0`. Because HTTP currently accepts `{ query, options }`, wire handoff inputs through `options.handoff_mode` and `options.plan_id` if parity ships. If parity cannot land safely, return the explicit deterministic unsupported behavior chosen in `T0` instead of silently diverging.
- **validation**: HTTP route either matches the frozen handoff input semantics or returns a documented, deterministic unsupported behavior that is covered by tests.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T3: Create shared handoff assembly layer
- **depends_on**: [T0]
- **location**: context assembly path shared by MCP/HTTP, plus `src/mcp/tools/context.ts`
- **description**: Introduce a shared handoff composer above `ContextServiceClient` that builds one fixed payload shape: `objective`, `scope_in`, `scope_out`, `constraints`, `current_step`, `completed_steps`, `unresolved_risks`, `linked_files`, `approved_memories`, `recent_review_findings`, `next_actions`. Keep this composition separate from retrieval internals.
- **validation**: Shared composer returns the fixed payload shape from supplied durable inputs and can be consumed by both MCP and HTTP without changing retrieval results.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T4: Build durable source adapters and error mapping
- **depends_on**: [T0]
- **location**: plan-management access surfaces, memory tooling, context assembly layer
- **description**: Add read-only adapters that fetch active plan state, persisted memories, and durable review findings. In this tranche, `approved_memories` is all persisted `.memories` entries, while durable review findings are the subset with `subtype=review_finding`, filtered by recency and plan/file linkage where available. Exclude draft suggestions entirely. Add adapter-level error mapping for `plan_not_found`, `plan_unavailable`, and `plan_services_uninitialized` so callers never depend on raw persistence behavior.
- **validation**: Each adapter returns deterministic data or an empty result with reason metadata; no live reactive review session state is required; plan-loading failure modes are normalized into structured adapter results.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T5: Integrate handoff mode into MCP context output
- **depends_on**: [T1, T3, T4]
- **location**: `src/mcp/tools/context.ts`, any helper used to render context bundle output
- **description**: Wire `handoff_mode="active_plan"` into the MCP context tool so it appends/adds the bounded handoff bundle while preserving today’s normal context output. Default `handoff_mode="none"` must produce current behavior. Missing or deleted `plan_id` must yield structured `plan_not_found` handoff diagnostics instead of throwing. Active handoff mode must either disable generic memory inclusion or dedupe handoff memories/findings against the normal `contextBundle.memories` path so the same persisted content is not counted twice.
- **validation**: MCP `get_context_for_prompt` returns unchanged output in normal mode and deterministic handoff payloads plus failure diagnostics in active mode.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T6: Integrate handoff mode into HTTP context output
- **depends_on**: [T2, T3, T4]
- **location**: `src/http/routes/tools.ts`
- **description**: Wire the same shared handoff assembly into `/api/v1/context` when parity is in scope. Preserve existing timeout and abort behavior, and explicitly decide whether the route stays on current timeout handling or moves to the abortable helper for handoff mode.
- **validation**: HTTP handoff responses are deterministic, timeout behavior is documented, and parity with MCP is either achieved or intentionally deferred with explicit coverage.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T7: Add cache identity, size limits, and failure reason handling
- **depends_on**: [T4, T5]
- **location**: `src/mcp/serviceClient.ts`, `src/internal/handlers/context.ts`, shared handoff assembly layer
- **description**: Extend cache identity and metadata for handoff mode using plan revision/version, memory revision, and review-findings revision so stale continuation bundles are never reused across plan changes. Because MCP context flows through `internalContextBundle()`, update the internal context-cache identity or move handoff composition outside that cache boundary so stale handoff bundles cannot survive behind the old `query + options` cache key. Add hard caps for included files, memories, findings, and payload size. Return deterministic reasons for `plan_not_found`, `plan_unavailable`, `plan_services_uninitialized`, `findings_unavailable`, and truncation.
- **validation**: Cache keys differ across plan/memory/findings revisions, and oversized handoff bundles truncate deterministically with explicit reason codes.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T8: Update tests, discoverability baselines, and compatibility artifacts
- **depends_on**: [T5, T6, T7]
- **location**: `tests/tools/context.test.ts`, `tests/integration/httpCompatibility.test.ts`, `tests/snapshots/oldClientFixtures.test.ts`, manifest/discoverability snapshots, client-compat tests
- **description**: Add regression and contract tests for MCP and HTTP handoff behavior, snapshot updates for the additive tool schema changes, and compatibility checks so old clients continue to work when `handoff_mode` is absent. Explicitly update the HTTP response-shape tests, context formatter tests, and old-client manifest/fixture parity tests that will catch regressions in this repo.
- **validation**: Focused context/HTTP/manifest/client-compat tests pass and prove additive-only behavior.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T9: Final readiness gate
- **depends_on**: [T6, T7, T8]
- **location**: focused test suite, build/smoke verification surfaces, plan artifact
- **description**: Run the evidence-oriented readiness gate for the tranche: default behavior unchanged, active handoff behavior deterministic, MCP/HTTP parity decision honored, retrieval routing untouched, and compatibility artifacts updated. Include at least one direct HTTP context smoke in addition to MCP smoke so the parity tranche is not signed off using MCP-only evidence.
- **validation**: Focused tests, build, MCP smoke, and direct HTTP context smoke all pass; readiness notes identify whether HTTP parity shipped or was explicitly deferred.
- **status**: Not Completed
- **log**:
- **files edited/created**:

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T0 | Immediately |
| 2 | T1, T2, T3, T4 | T0 complete |
| 3 | T5, T6 | T1+T3+T4 complete for T5; T2+T3+T4 complete for T6 |
| 4 | T7 | T4+T5 complete |
| 5 | T8 | T5+T6+T7 complete |
| 6 | T9 | T6+T7+T8 complete |

## Testing Strategy
- MCP contract tests for additive `get_context_for_prompt` inputs and default behavior preservation.
- HTTP route tests for parity or explicit unsupported behavior, including timeout/abort semantics.
- Context output tests covering:
  - `handoff_mode="none"` unchanged output
  - `handoff_mode="active_plan"` fixed payload shape
  - `plan_not_found` structured diagnostics
  - `plan_unavailable` and `plan_services_uninitialized` structured diagnostics
  - empty review findings with explicit reason code
  - exclusion of draft suggestions
  - dedupe or suppression of duplicate memory content between normal memory retrieval and handoff bundle
  - deterministic truncation/size limits
- Cache tests proving plan/memory/findings revision changes invalidate handoff bundles, including the internal context-cache path.
- Snapshot and manifest tests proving discoverability and compatibility artifacts are updated, including `tests/snapshots/oldClientFixtures.test.ts`.
- Final readiness evidence:
  - focused `tests/tools/context.test.ts` + `tests/integration/httpCompatibility.test.ts` + snapshot tests
  - `npm run build`
  - `npm run ci:check:mcp-smoke`
  - one direct HTTP context smoke

## Risks & Mitigations
- Risk: Handoff composition leaks into retrieval internals and makes cache behavior brittle.
  - Mitigation: Keep assembly above `ContextServiceClient` and treat retrieval as an input, not the composition owner.
- Risk: “Durable review findings” becomes an open-ended storage project.
  - Mitigation: In this tranche, use persisted memories tagged `subtype=review_finding` as the source of truth.
- Risk: MCP and HTTP drift.
  - Mitigation: Shared composer first; if parity cannot ship cleanly, explicitly document HTTP as deferred instead of silently differing.
- Risk: Large bundles become noisy and defeat the purpose.
  - Mitigation: Hard caps, deterministic truncation, explicit reason codes, and duplicate-memory suppression.
- Stop/replan triggers:
  - The existing plan/memory services cannot provide the required data without introducing a new persistence layer.
  - HTTP route constraints make parity unsafe and the fallback behavior cannot be expressed deterministically.
  - Cache identity cannot be extended without touching unrelated retrieval contracts in a risky way.
