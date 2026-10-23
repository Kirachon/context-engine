# Local retrieval repair

`CE_RETRIEVAL_LOCAL_REPAIR_V1=true` enables the repaired local file-scan fallback. The flag defaults to false in every performance profile. Existing SQLite/chunk paths retain their own behavior; this change does not establish their quality or enable embeddings.

The fallback reads every eligible scoped file through existing size, containment, ignore and cancellation checks before selecting results. It reuses BM25-style content scoring and shared Unicode/identifier/plural analysis. Declarations and path terms count only when they match the query. Provider/factory directories receive no unconditional bonus. Snippets retain accurate contiguous source lines around concentrated query terms.

Scorer `local-bm25-v6` softly prioritizes implementation over supporting documents for implementation-location questions. Source-to-source scores and ordering are preserved. Explicit documentation, test, script, operational-evidence, filename and include-category requests bypass that preference. Pure Unicode queries reach the repair analyzer instead of being discarded by the legacy ASCII guard.

The scan keeps compact query-term statistics, not complete corpus text or per-line analysis. Exact-match boosts are computed while each file is present; selected files are securely reread for snippets. Query metadata is limited to an estimated 16 MiB and 20,000 matching documents; exceeding the budget raises an actionable error to narrow `include_paths`, rather than silently truncating candidates or returning ordinary empty results. Per-file analysis is limited to an estimated 32 MiB, independently of the bounded process analysis cache. These are retention estimates and cardinality limits, not a total process-RSS guarantee.

## Freshness and latency

The repair flag and scorer version participate in cache identity. Cached retrieval requires a live, complete corpus fingerprint matching index/provider/settings identity. Same-size edits with restored timestamps cannot authorize stale results. A stale or unavailable identity disables result reuse. Aborted work does not publish partial results.

The retrieval handler obtains fresh status with the existing bounded asynchronous scan. A stale scan may report status but never authorize a result-cache hit. Invalid/unavailable validation falls back to the synchronous status path. Cache validation receives cancellation, and publication rechecks invalidation generations after asynchronous work. The default-off semantic, keyword and handler cache paths retain their predecessor behavior; composite health remains a lightweight snapshot. No persistent cache or new indexing dependency is added.

The repair's asynchronous corpus and fallback content reads validate real-path containment before opening and opened file identity before consuming content, with no-follow/nonblocking flags where available. Linux also validates the descriptor target. Byte consumption is capped even if a file grows after its stat snapshot. These portable checks reject tested discovery/open link swaps; they do not claim an atomic open-beneath primitive for arbitrary adversarial filesystem namespace races on every platform.

For repaired `local_native` search with an available lexical backend, retrieval skips semantic AI-helper fanout. Other providers, explicit semantic-only requests, disabled repair and unavailable lexical paths retain existing routing. This does not disable explicitly requested AI tools.

## Diagnostics and compatibility

`index_status` adds optional `indexAvailability` (`empty_workspace`, `uninitialized`, `available`) and `retrieval` diagnostics with the configured scorer and last executed local backend. Persisted timestamps alone do not establish readiness. Availability can coexist with stale content; inspect freshness separately.

The last backend is process history, not proof of what served a cache hit or what will serve the next request. Legacy mode labels (`semantic`, `keyword`, `hybrid`), tool names and provider IDs do not prove that an embedding model ran. Existing required response fields and MCP tool arguments are unchanged.

## Verification

Run from the repository root:

```powershell
npm run build
npm test -- --runInBand --roots ./tests
npm test -- --runInBand --roots ./tests --runTestsByPath tests/serviceClientLocalRepair.test.ts tests/internal/retrieval/localRepair.test.ts tests/internal/retrieval/localRepairAnalysis.test.ts tests/tools/codebaseRetrieval.test.ts
npm test -- --runInBand --roots ./tests --runTestsByPath tests/serviceClientReviewRegressions.test.ts
npm run ci:check:stale-cache-guards
npm run ci:check:retrieval-dependency-boundary
npm run ci:check:retrieval-config-precedence
```

The original local development corpus and question pack are private workstation artifacts and are not included in this source delivery. The synthetic regressions above are self-contained. Earlier workstation timings precede the opened-file hardening and must not be attributed to this commit. Run matched corpus quality and latency checks before enabling or replacing a deployed build; passing source tests is not performance acceptance.

This change does not establish independent validation, improved AI answers, coding productivity or token savings. Unrelated session-recovery and context-selection changes remain outside this focused branch.

Startup configuration and local compiled artifacts are outside this source commit. Enabling the flag or changing an entrypoint requires a fresh server/client session and a live diagnostics check. The default remains off.
