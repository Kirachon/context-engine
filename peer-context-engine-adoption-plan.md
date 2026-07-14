# Plan: Finish Peer Context-Engine Adoption by Closing the Handoff Gap

## Summary
The retrieval-side adoption work is now mostly implemented in the repo: declaration-aware lookup intent routing, additive chunk metadata/provenance, shadow routing receipts, compact routing diagnostics, and lazy declaration-body hydration already exist. The remaining adoption gap is the agent handoff layer.

This updated plan keeps the completed retrieval work as accepted foundation and refocuses the remaining implementation on:
- `handoff_mode`
- `plan_id`-driven context handoff
- durable plan/review/memory bundle assembly

This plan still avoids:
- MCP tool renames or breaking schema changes
- a new top-level search route
- indexing full declaration bodies as primary artifacts
- coupling plan/review state directly into `ContextServiceClient`

## Current Status
### Already Implemented
- Declaration-aware local retrieval behind `retrieval_declaration_routing_v1`
- Internal `lookupIntent = discovery | definition | references | body`
- Additive chunk metadata and provenance on `ChunkRecord`
- Parser-aware declaration chunking with heuristic and Tree-sitter provenance
- Lazy declaration-body hydration instead of indexing full bodies as primary artifacts
- Compact routing diagnostics including selected route, parser provenance, fallback/downgrade reason, and oversized-file outcome
- Shadow compare receipts for declaration-aware routing
- Existing oversized-file outcomes such as `metadata_only`, `size_skip`, and `binary_skip`

### Still Missing
- `handoff_mode` on `get_context_for_prompt`
- `plan_id`-driven continuation context on `get_context_for_prompt`
- a bounded handoff bundle assembled from durable plan state, approved memories, and durable review findings
- a shared context-assembly path that keeps MCP and HTTP handoff behavior aligned
- durable review-findings integration into continuation context

## Implementation Changes
### Phase 0: Freeze the New Baseline
- Treat the shipped retrieval work as the new baseline rather than planned future work.
- Freeze the current retrieval contract and artifacts for the already-implemented declaration-routing path so the remaining handoff work cannot accidentally regress it.
- Keep `retrieval_declaration_routing_v1` and the existing shadow compare posture unchanged during this plan unless a handoff change requires additive cache-key updates.

### Phase 1: Add Bounded Handoff Inputs
- Extend `get_context_for_prompt` with one additive continuation entry point only:
  - `handoff_mode: "none" | "active_plan"`
  - `plan_id` required when `handoff_mode` is `"active_plan"`
- Keep the default behavior unchanged when `handoff_mode` is omitted or `"none"`.
- Add the same validation and schema updates across the MCP tool layer, discoverability metadata, manifest snapshots, and any HTTP surface that is intended to stay in parity.
- If HTTP parity cannot land cleanly in the same slice, explicitly scope handoff to MCP first and document HTTP as not yet supported instead of silently diverging.

### Phase 2: Assemble a Durable Handoff Bundle
- Build handoff composition above `ContextServiceClient`, in the context/tool assembly layer, not inside retrieval internals.
- Emit one fixed compact handoff payload shape when `handoff_mode="active_plan"`:
  - `objective`
  - `scope_in`
  - `scope_out`
  - `constraints`
  - `current_step`
  - `completed_steps`
  - `unresolved_risks`
  - `linked_files`
  - `approved_memories`
  - `recent_review_findings`
  - `next_actions`
- Source this bundle only from durable records:
  - persisted plan state
  - approved memories
  - a named durable review-findings store
- Do not include draft suggestions or live ad hoc session state.
- If a durable review-findings store does not yet exist, ship the bundle with `recent_review_findings` as an empty array plus a reason code, and keep the field contract stable.

### Phase 3: Failure Semantics, Caching, and Limits
- Add deterministic handoff failure behavior:
  - missing or deleted `plan_id` returns structured `plan_not_found` handoff diagnostics, not a thrown error
  - missing durable review findings return an empty list plus a reason code
- Hard-cap bundle size, included files, included findings, and included memories so continuation context stays compact.
- Extend cache identity for handoff mode with plan version/revision, memory revision, and findings revision so stale continuation bundles are never reused across plan changes.
- Keep current retrieval/routing diagnostics intact and additive to handoff mode instead of inventing a second diagnostic system.

## Public Interfaces and Type Changes
- `get_context_for_prompt`
  - add `handoff_mode?: "none" | "active_plan"`
  - add `plan_id?: string` with validation that it is required only when `handoff_mode` is `"active_plan"`
- Context bundle output
  - add an additive handoff bundle section/metadata block with the fixed payload above
- No changes to:
  - `semantic_search`
  - symbol tool names
  - retrieval routing public names

## Test Plan
- Retrieval regression safety:
  - existing declaration-aware routing tests continue to pass unchanged
  - existing routing diagnostics and shadow receipts remain intact
- Handoff input tests:
  - `handoff_mode="none"` preserves today’s behavior
  - `handoff_mode="active_plan"` requires `plan_id`
  - invalid or deleted `plan_id` returns structured handoff diagnostics
- Handoff bundle tests:
  - output matches the fixed payload shape
  - only durable records appear in the bundle
  - approved memories are included, draft suggestions are excluded
  - missing durable findings produce an empty array plus reason code
  - bundle size limits and truncation behavior are deterministic
- Cache and parity tests:
  - cache identity changes when plan/memory/findings revisions change
  - MCP and HTTP surfaces match when parity is in scope
  - manifest/discoverability/snapshot/client-compat baselines are updated for new args

## Assumptions and Defaults
- Retrieval adoption is considered implemented enough to serve as the baseline for this updated plan.
- The main remaining product value is better continuation across agents and sessions, not more retrieval cleverness.
- Handoff composition belongs above the retrieval service so retrieval remains reusable and cacheable.
- Review findings must come from a durable source before they are included in handoff context by default.
- If HTTP parity is risky in the first slice, MCP-first is acceptable as long as the scope difference is explicit.
