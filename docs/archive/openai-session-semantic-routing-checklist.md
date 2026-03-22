# CE_AI_SESSION Semantic Routing Checklist

## Goal
Migrate `ContextServiceClient.semanticSearch` to use the OpenAI session provider when
`CE_AI_PROVIDER=openai_session` while preserving existing behavior for `augment`.

## Plan (implemented)
- [x] Add provider-resolution and provider instance wiring in `ContextServiceClient`.
- [x] Add provider-scoped cache-key namespace (`provider:query:topK`).
- [x] Route `semanticSearch` based on active provider (`augment` -> DirectContext, `openai_session` -> `searchAndAsk`).
- [x] Add JSON-array parsing for `openai_session` search responses.
- [x] Add strict result-path sanitization and unsafe-path filtering.
- [x] Preserve fallback path for malformed provider output (`keywordFallbackSearch`).
- [x] Keep existing `semantic_search` and `codebase_retrieval` tool contracts intact.
- [x] Add targeted unit tests for openai provider response parsing/fallback/cache-keying.
- [x] Preserve offline-mode guard behavior for `openai_session` in `searchAndAsk`.
- [x] Preserve offline-mode behavior for `augment` in initialization by pre-invoking `ensureInitialized()` when needed.
- [ ] Optional hardening: move provider-parsing retry and telemetry into shared provider layer.
- [ ] Optional cleanup: reduce noisy console output in test environments.

## Evidence
- `npm test -- --runInBand tests/serviceClient.test.ts`
- `npm test -- --runInBand tests/tools/search.test.ts tests/tools/codebaseRetrieval.test.ts`