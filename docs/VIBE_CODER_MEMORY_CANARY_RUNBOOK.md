# Vibe-Coder Memory Mode Canary Runbook

`review_memory_suggestions` is Phase 1 canary-only until the memory-mode gates stay healthy.

## Phase 1 Posture
- quiet assisted mode only
- `CE_MEMORY_SUGGESTIONS_V1` remains default-off
- `CE_MEMORY_DRAFT_RETRIEVAL_V1` remains default-off
- `CE_MEMORY_AUTOSAVE_V1` remains disabled
- source allowlist stays limited to `plan_outputs`, `review_outputs`, and `explicit_user_directives`

## Required Gates
- contract gate: memory-mode contracts and paired tests must pass
- safety gate: secrets blocked before draft persist and before promotion
- quality gate: approval precision, dismiss rate, and contradiction rate remain within thresholds
- retrieval gate: explicit draft retrieval does not change default retrieval behavior
- rollback gate: rollback evidence exists before widening write behavior

## Canary Checklist
- confirm `review_memory_suggestions` is enabled only in the canary environment
- confirm normal `get_context_for_prompt` still excludes drafts by default
- confirm explicit `include_draft_memories` requires `draft_session_id`
- confirm approved drafts promote through `add_memory` formatting/writer behavior
- confirm `promoted_pending_index` is visible when durable write succeeds but indexing follow-up fails
- confirm `undo last batch` is used only before promotion and must not imply rollback of already promoted durable memories

## Promotion Criteria
- approval precision remains above threshold for the observation window
- dismiss and edit rates stay below threshold
- contradiction overrides remain rare and justified
- no secret persistence incidents occur
- rollback drill succeeds with the feature flag switched off

## Explicit Non-Goals
- no auto-save in Phase 1
- no free-form chat/log ingestion in Phase 1
- no draft indexing into default retrieval
