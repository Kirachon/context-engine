# Plan: Vibe-Coder Memory Mode

**Generated**: 2026-04-11

## Overview
Add a low-interruption memory suggestion system that notices likely-important decisions during work, stores them as isolated drafts, and promotes approved suggestions into the existing durable memory path. The implementation must preserve current memory contracts, keep drafts out of default retrieval, and prove usefulness through explicit trust and retrieval gates before any auto-save behavior is considered.

## Scope Lock
- In scope:
  - draft-first memory suggestion pipeline
  - isolated suggestion storage outside `.memories/`
  - checkpoint-based review flow with quiet defaults
  - promotion through the existing `add_memory` durable path only
  - contracts, metrics, suppression rules, and rollout gates
  - optional explicit draft retrieval hooks only if session-scoped and default-off
- Out of scope:
  - changing `add_memory` / `list_memories` public names
  - changing existing memory categories (`preferences`, `decisions`, `facts`)
  - indexing draft suggestions into normal retrieval
  - fully automatic save in the first release
  - free-form log/chat capture in Phase 1
- Likely file surfaces:
  - `src/mcp/tools/memory.ts`
  - `src/mcp/serviceClient.ts`
  - `src/mcp/tools/context.ts`
  - `src/mcp/tooling/discoverability.ts`
  - `src/mcp/server.ts`
  - `src/mcp/services/approvalWorkflowService.ts`
  - `config/ci/*`
  - `tests/tools/*`
  - `tests/serviceClient.test.ts`
  - `tests/ci/*`
  - `docs/*`

## Prerequisites
- Current durable memory contracts remain the source of truth:
  - `add_memory`
  - `list_memories`
  - `.memories/` markdown storage
- Existing retrieval and calibration contracts remain active:
  - `config/ci/retrieval-calibration-contract.json`
  - `config/ci/retrieval-decision-thresholds.json`
  - `config/ci/retrieval-rollback-evidence-contract.json`
- Existing memory ranking and startup-pack behavior must remain backward compatible until explicitly extended.

## Dependency Graph

```text
T0 -> T1 -> T4 -> T7 -> T9 -> T11 -> T12
T0 -> T2 -> T5 -> T6 -> T9
T0 -> T3 -> T6
T4 -> T6 -> T9
T4 -> T8 -> T9 -> T10 -> T11
T4 -> T6a -> T9
T10 -> T11
```

## Tasks

### T0: Freeze Current Memory Contracts and Rollout Boundaries
- **depends_on**: []
- **location**: `src/mcp/tools/memory.ts`, `src/mcp/serviceClient.ts`, `config/ci/*.json`, `ARCHITECTURE.md`
- **description**: Document and test the baseline durable memory contract, current retrieval behavior, and draft-isolation requirement so the new feature cannot silently drift into a second durable write path or default retrieval path.
- **validation**: Existing `add_memory` / `list_memories` / memory retrieval tests pass unchanged; active contracts explicitly state that approved memories remain the only default retrieval source.
- **status**: Completed
- **log**: Verified the existing durable memory path remains `add_memory`/`.memories/`, confirmed current retrieval behavior and active CI contracts, and used that frozen baseline to constrain T1-T3 without altering live retrieval behavior.
- **files edited/created**: (none)

### T1: Add Memory-Mode Governance and Feature-Flag Contracts
- **depends_on**: [T0]
- **location**: `config/ci/`, `tests/ci/`, `ARCHITECTURE.md`, `src/config/features.ts`, `tests/config/features.test.ts`
- **description**: Create a dedicated memory-mode CI contract covering feature flags, rollout gates, source allowlist, durable-writer rule, draft isolation, and auto-save prohibition in initial phases.
- **validation**: New contract tests fail if draft storage, source allowlist, or rollout gates drift; feature flags default to safe/off behavior.
- **status**: Completed
- **log**: Added safe-off memory-mode feature flags, introduced a dedicated `config/ci/memory-mode-contract.json`, and registered it in governance so drift is caught by CI before later implementation waves widen behavior.
- **files edited/created**: `config/ci/memory-mode-contract.json`, `config/ci/governance-contract.json`, `src/config/features.ts`, `tests/config/features.test.ts`, `tests/ci/memoryModeContract.test.ts`

### T2: Design the Draft Suggestion Data Model and Lifecycle
- **depends_on**: [T0]
- **location**: `src/mcp/serviceClient.ts`, new suggestion-store module under `src/mcp/`, `docs/`
- **description**: Define the draft record shape and lifecycle state machine: `detected -> drafted -> batched -> reviewed -> promoted | promoted_pending_index | dismissed | snoozed | expired`, including mandatory promotable fields `category`, `content`, optional `title`, metadata map, `promotion_payload_hash`, and control fields like `draft_id`, `session_id`, `source_type`, `source_ref`, `score_breakdown`, `confidence`, `conflict_key`, `expires_at`, and `promotion_result`.
- **validation**: Type-level and unit tests prove lifecycle transitions and required metadata are deterministic and backward compatible with current memory retrieval.
- **status**: Completed
- **log**: Added a standalone `src/mcp/memorySuggestions.ts` module that defines the draft schema, promotion payload compatibility, deterministic payload hashing, and lifecycle validation including `promoted_pending_index`.
- **files edited/created**: `src/mcp/memorySuggestions.ts`, `tests/mcp/memorySuggestions.test.ts`

### T3: Define Review UX and Suppression Rules
- **depends_on**: [T0]
- **location**: `docs/`, `src/mcp/tooling/discoverability.ts`, any new review/suggestion handler files
- **description**: Specify the user-facing workflow contract: quiet mode by default, closure/idle checkpoints only, hard batch cap `3-5`, explainability line per suggestion, `save/dismiss/inspect/snooze`, pre-promotion-only `undo last batch`, and durable `never suggest like this` suppression behavior.
- **validation**: Documentation and handler tests confirm checkpoint rules, batch cap, and suppression semantics are explicit and unambiguous.
- **status**: Completed
- **log**: Added a dedicated review contract doc that locks quiet-mode defaults, checkpoint-only surfacing, hard batch cap, explainability, pre-promotion-only undo, and durable suppression semantics, then pinned those rules with a docs contract test.
- **files edited/created**: `docs/VIBE_CODER_MEMORY_REVIEW_CONTRACT.md`, `tests/utils/docsContracts.test.ts`

### T4: Implement Separate Non-Indexed Suggestion Store
- **depends_on**: [T1]
- **location**: new suggestion-store files under `src/mcp/`, storage helpers, `src/mcp/serviceClient.ts`, `tests/`
- **description**: Create a dedicated suggestion store outside `.memories/`, for example `.context-engine-memory-suggestions/`, with TTL-backed session-scoped drafts and explicit exclusion from default indexing/retrieval. Add explicit ignore and watcher-exclusion enforcement so the draft path cannot be indexed accidentally.
- **validation**: Tests prove drafts never land under `.memories/`, never appear in normal retrieval, are ignored by indexing/watchers, and expire/clean up deterministically.
- **status**: Completed
- **log**: Added a dedicated `.context-engine-memory-suggestions/` store with session-scoped draft persistence and TTL cleanup, then enforced draft isolation in direct indexing, watcher ignore normalization, and the SQLite lexical index so drafts never leak into normal retrieval by accident.
- **files edited/created**: `src/mcp/memorySuggestionStore.ts`, `src/mcp/serviceClient.ts`, `src/internal/retrieval/sqliteLexicalIndex.ts`, `tests/mcp/memorySuggestionStore.test.ts`, `tests/serviceClient.test.ts`, `tests/watcher/ignoreRules.test.ts`

### T6a: Add Concurrency and Idempotency Guardrails
- **depends_on**: [T2, T4]
- **location**: suggestion-store and promoter modules under `src/mcp/`, `tests/`
- **description**: Add atomic state-transition protection for parallel execution, including per-draft monotonic versioning or CAS semantics, a promotion idempotency key, and duplicate-write guards so multiple workers cannot promote the same draft twice.
- **validation**: Parallel-safety tests prove duplicate approvals do not create duplicate durable memories and state transitions remain atomic.
- **status**: Completed
- **log**: Added atomic draft-store guardrails using lock-backed compare-and-set transitions, monotonic `store_version`, and idempotent promotion protection so duplicate approvals cannot double-write the same draft.
- **files edited/created**: `src/mcp/memorySuggestions.ts`, `src/mcp/memorySuggestionStore.ts`, `tests/mcp/memorySuggestionStore.test.ts`

### T5: Implement Detector Input Policy and Scoring
- **depends_on**: [T2]
- **location**: new detector/policy files under `src/mcp/`, `src/mcp/serviceClient.ts`, `tests/`
- **description**: Build the high-signal detection policy using a Phase 1 source allowlist and deterministic scoring dimensions: repetition, directive strength, source reliability, traceability, and stability penalty. Reject fluff, secrets, raw logs, one-off implementation noise, and unstable statements.
- **validation**: Policy matrix tests prove inclusion/exclusion behavior and score explainability for accepted drafts.
- **status**: Completed
- **log**: Added a deterministic Phase 1 detector module with the source allowlist, explainable scoring dimensions, secret rejection using the existing scrubber path, and hard rejection of fluff/log/noise inputs before any draft record is created.
- **files edited/created**: `src/mcp/memorySuggestionDetector.ts`, `tests/mcp/memorySuggestionDetector.test.ts`

### T6: Implement Review Batch API and Idempotent Actions
- **depends_on**: [T2, T3, T4, T5]
- **location**: new review/handler files under `src/mcp/tools/` or `src/mcp/services/`, `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `tests/`, `tests/snapshots/*`
- **description**: Add the review-facing API for listing draft batches and performing idempotent actions (`approve`, `dismiss`, `edit`, `snooze`, `undo_last_batch`, `suppress_pattern`) without changing existing durable memory tools. Keep `undo_last_batch` pre-promotion only in Phase 1 unless a separate durable rollback contract is added later.
- **validation**: Tests prove batch cap enforcement, idempotent actions, undo behavior, and suppression persistence.
- **status**: Completed
- **log**: Salvaged and completed the draft review tool, wired it into the MCP server/manifest/discoverability surface, enforced feature-flag gating, and added idempotent batch review actions with suppression and pre-promotion undo behavior.
- **files edited/created**: `src/mcp/tools/memoryReview.ts`, `src/mcp/server.ts`, `src/mcp/tools/manifest.ts`, `src/mcp/tooling/discoverability.ts`, `tests/mcp/memoryReview.test.ts`, `tests/mcp/discoverability.test.ts`, `tests/snapshots/snapshot-harness.ts`, `tests/snapshots/phase2/fixtures/old-client-tool-families.json`, `tests/snapshots/oldClientFixtures.test.ts`, `tests/snapshots/phase2/baseline/tool_manifest_basic.baseline.txt`

### T7: Add Pre-Persist Safety Pipeline
- **depends_on**: [T4]
- **location**: suggestion builder/promoter files, existing secret-scrub/validation helpers, `tests/`
- **description**: Reuse secret scrub and validation before draft persist and promotion. Hard-block drafts or promotions containing secrets or disallowed content unless explicitly edited into a safe form.
- **validation**: Seeded secret corpus tests prove no secret reaches draft persistence or durable memory.
- **status**: Completed
- **log**: Added a shared safety helper that blocks secrets, raw logs, brainstorming fluff, implementation noise, and unstable statements before draft persistence or later promotion, then reused it in both detector and store layers.
- **files edited/created**: `src/mcp/memorySuggestionSafety.ts`, `src/mcp/memorySuggestionDetector.ts`, `src/mcp/memorySuggestionStore.ts`, `tests/mcp/memorySuggestionSafety.test.ts`

### T8: Add Conflict Detection and Promotion Gate
- **depends_on**: [T4, T5]
- **location**: `src/mcp/serviceClient.ts`, promoter/reviewer modules, `tests/serviceClient.test.ts`, `tests/`
- **description**: Compare candidate drafts against approved memories using a deterministic conflict key and top-N relevant memory comparison. Promotion must stop on contradiction until the reviewer resolves it explicitly.
- **validation**: Tests prove contradiction blocks promotion, override reasons are required, and bulk-save respects the same gate.
- **status**: Completed
- **log**: Added deterministic conflict-key and contradiction-gate helpers for single and bulk promotion flows, including required override reasons when a contradiction must be bypassed.
- **files edited/created**: `src/mcp/memorySuggestionConflicts.ts`, `tests/mcp/memorySuggestionConflicts.test.ts`

### T9: Implement Promotion Through Existing Durable Memory Path
- **depends_on**: [T4, T6, T6a, T7, T8]
- **location**: `src/mcp/tools/memory.ts`, promoter module, `tests/tools/memory.test.ts`, `tests/`
- **description**: Wire approved draft promotion through the same validation/formatting path as `add_memory`, so there is still only one durable writer. Preserve existing categories and metadata extensions, and explicitly track partial promotion outcomes such as `promoted_pending_index` when durable write succeeds but indexing follow-up does not.
- **validation**: Regression tests prove promoted memories land in the same durable format as manual memories, existing tools remain compatible, and partial-failure states are visible and recoverable.
- **status**: Completed
- **log**: Refactored the durable memory writer into a reusable persistence seam, then routed approved draft promotions through that exact path so promoted memories land in the same markdown format as manual `add_memory` writes and expose `promoted_pending_index` when indexing follow-up needs retry.
- **files edited/created**: `src/mcp/tools/memory.ts`, `src/mcp/memorySuggestionStore.ts`, `src/mcp/tools/memoryReview.ts`, `tests/tools/memory.test.ts`, `tests/mcp/memoryReview.test.ts`

### T10: Add Explicit Optional Draft Retrieval Hooks
- **depends_on**: [T4, T8]
- **location**: `src/mcp/serviceClient.ts`, `src/mcp/tools/context.ts`, `tests/serviceClient.test.ts`
- **description**: Add explicit session-scoped draft retrieval options such as `include_draft_memories` and `draft_session_id`, defaulting to off. Update cache-key composition and context rendering so drafts can never leak into normal retrieval by accident.
- **validation**: Tests prove default retrieval excludes drafts, explicit session-scoped retrieval includes only the intended drafts, and tool-boundary naming stays consistent with existing snake_case MCP schemas.
- **status**: Completed
- **log**: Added explicit session-scoped draft retrieval controls to `get_context_for_prompt`, kept them default-off behind `memory_draft_retrieval_v1`, and updated context metadata/output so draft suggestions only appear when both the flag and `draft_session_id` are provided.
- **files edited/created**: `src/mcp/serviceClient.ts`, `src/mcp/tools/context.ts`, `tests/serviceClient.test.ts`

### T11: Add Metrics, Contracts, and Rollback Evidence
- **depends_on**: [T7, T8, T9, T10]
- **location**: `config/ci/`, `scripts/ci/`, `tests/ci/`, `artifacts/bench/`
- **description**: Add memory-mode metrics and rollout gates: approval precision, dismiss/edit/revert rate, contradiction rate, suppression repeat violations, missed-opportunity rate, memory token overhead, retrieval deltas, and secret-block counters. Add rollback-evidence requirements for behavior-changing slices.
- **validation**: CI contracts and report generation prove memory-mode metrics are available, thresholded, and tied to rollback/readiness gates.
- **status**: Completed
- **log**: Added memory-mode threshold and rollback-evidence contracts, registered them in governance, and pinned the expected receipts for draft counts, promotion states, and rollback readiness with dedicated CI tests.
- **files edited/created**: `config/ci/memory-mode-thresholds.json`, `config/ci/memory-mode-rollback-evidence-contract.json`, `config/ci/governance-contract.json`, `tests/ci/memoryModeThresholdsContract.test.ts`, `tests/ci/memoryModeRollbackEvidenceContract.test.ts`, `tests/ci/governanceContract.test.ts`

### T12: Canary Readiness and Phase Gate Assembly
- **depends_on**: [T10, T11]
- **location**: `docs/`, `config/ci/`, rollout/runbook docs, tests/ci
- **description**: Assemble the release posture for Phase 1 canary: quiet assisted mode only, feature flag default-off, source allowlist active, no auto-save, and explicit success criteria for progression to later phases.
- **validation**: Readiness checklist, CI contract checks, and rollout docs all agree on the same gates; Phase 3 auto-save remains blocked by evidence.
- **status**: Completed
- **log**: Wrote the Phase 1 canary runbook, codified the default-off/quiet-assisted posture, and verified the rollout story stays aligned across docs, contracts, old-client fixtures, build, and MCP smoke validation.
- **files edited/created**: `docs/VIBE_CODER_MEMORY_CANARY_RUNBOOK.md`, `tests/utils/docsContracts.test.ts`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 0 | T0 | Immediately |
| 1 | T1, T2, T3 | T0 complete |
| 2 | T4, T5 | T1 complete for T4; T2 complete for T5 |
| 3 | T6a, T6, T7, T8 | T2+T4 complete for T6a; T2+T3+T4+T5 complete for T6; T4 complete for T7; T4+T5 complete for T8 |
| 4 | T9, T10 | T4+T6+T6a+T7+T8 complete for T9; T4+T8 complete for T10 |
| 5 | T11 | T7+T8+T9+T10 complete |
| 5 | T12 | T10+T11 complete |

## Testing Strategy
- Keep all existing `add_memory`, `list_memories`, and memory retrieval tests green.
- Add contract tests for:
  - draft isolation
  - source allowlist
  - durable-writer rule
  - feature-flag defaults
- Add policy matrix tests for what may and may not become a draft.
- Add lifecycle tests for TTL expiry, batching, snooze, dismissal, and undo.
- Add concurrency/idempotency tests for duplicate approvals and atomic promotion transitions.
- Add security tests proving secrets are blocked before draft persist and before promotion.
- Add contradiction tests and suppression tests.
- Add retrieval tests proving drafts stay out of default context and only appear via explicit session-scoped flags.
- Add metrics/report tests for trust, quality, retrieval impact, and rollback evidence.

## Risks & Mitigations
- Risk: Drafts pollute normal retrieval.
  - Mitigation: separate non-indexed store + explicit retrieval flag + invariant tests.
- Risk: Suggestion prompts become annoying.
  - Mitigation: quiet mode, closure/idle checkpoints only, hard batch cap `3-5`, prompt-frequency metrics.
- Risk: Low-quality sources create junk memory.
  - Mitigation: Phase 1 source allowlist + per-source precision tracking + auto-disable underperforming sources.
- Risk: Approved drafts degrade startup-pack quality.
  - Mitigation: contradiction gate, revert/edit-rate thresholds, retrieval non-regression gates.
- Risk: Secrets leak into drafts or durable memory.
  - Mitigation: pre-persist scrub + seeded secret corpus tests + release blocker on any violation.
- Risk: Auto-save ships too early.
  - Mitigation: not in Phase 1; gated by canary evidence, revert/edit rate, precision SLOs, and rollback readiness.
- Stop / replan triggers:
  - any plan that introduces a second durable memory write path
  - any design that stores drafts under `.memories/`
  - any evidence that drafts appear in default retrieval
  - any unresolved contradiction policy for bulk-save
  - any rollout proposal that enables auto-save without canary-quality evidence

## Final Readiness Gate
- Existing durable memory and retrieval behavior remains backward compatible.
- Drafts are isolated, non-indexed by default, and governed by explicit flags.
- Secret handling, contradiction blocking, suppression, undo, and TTL lifecycle are tested.
- Memory-mode metrics and rollback evidence are emitted and thresholded in CI.
- Phase 1 canary can run with feature flag default-off and no auto-save path enabled.
