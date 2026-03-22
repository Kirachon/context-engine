# OpenAI-First Codebase Retrieval Checklist

## Goal
Switch retrieval for `codebase_retrieval` and `semantic_search` to an OpenAI-session-first flow while keeping MCP tool contracts unchanged.

## Why this fix is needed
- `codebase_retrieval` and `semantic_search` now share `serviceClient.semanticSearch()`.
- OpenAI-session output parsing had cases that fell back to keyword scan unexpectedly.
- Empty structured results (`[]`) from `openai_session` were incorrectly treated as "no data" and were silently converted into keyword fallback results.

## Implementation Steps

### 1) Routing and provider behavior
- [x] Keep provider routing by `getActiveAIProviderId()`:
  - `augment` -> DirectContext path
  - `openai_session` -> `searchAndAsk` + JSON parser path
- [x] Preserve existing `augment` behavior and index lifecycle.
- [ ] Optional: move provider-specific defaults to environment docs with a clear "OpenAI-first" runbook.

### 2) OpenAI-session result parsing hardening
- [x] Treat fenced JSON parsing failures safely (`parseResult` returns `null` only when parseable JSON-like candidates fail).
- [x] Return `[]` immediately when provider returns valid empty JSON array.
- [x] Avoid keyword fallback for explicit structured no-match responses.
- [x] Normalize escaped fence markers (`\``) before JSON extraction to keep parser tolerant of encoded provider outputs.

### 3) Test coverage
- [x] Add/adjust openai tests for:
  - empty array (`[]`) returning empty result set (no fallback)
  - valid JSON array in code fences
  - malformed fenced JSON still falling back to keyword scan
  - unsafe path filtering in provider output
- [x] Preserve existing `augment` and general semantic search tests.

### 4) Validation
- [ ] Run:
  - `npm test -- --runInBand tests/serviceClient.test.ts`
  - `npm test -- --runInBand tests/tools/search.test.ts tests/tools/codebaseRetrieval.test.ts`
  - Tool-level retrieval smoke check for `codebase_retrieval` and `semantic_search` with `CE_AI_PROVIDER=openai_session`.
- [ ] Confirm no accidental index calls to DirectContext during openai_session path.

### 5) Operator runbook (OpenAI-first)
- [ ] Set `CE_AI_OPENAI_SESSION_ONLY=1`
- [ ] Set `CE_AI_PROVIDER=openai_session` (defensive explicit mode)
- [ ] Ensure `CE_OPENAI_SESSION_CMD` points to working `codex` command and auth/session command succeeds.

## Rollback
- [ ] Remove session-only flag and unset provider override to restore default `augment` baseline.

