# Context Engine Performance Swarm Plan

> Status: Tranche complete
> Progress: T1-T6 complete; Phase 0, the chunk/model + SQLite incremental + observability wave, the Wave 3 ranking/identifier/embedding-reuse tranche, and the final rerank/cache/model-eval follow-up slice are all landed and validated.
> Derived from: `docs/context-engine-improvement-plan.md`, `context-engine-next-tranche-swarm-plan.md`, and the reviewed v2 session draft

## Scope

Improve retrieval quality, latency, memory safety, and execution reliability for the local-native context engine without breaking MCP tool contracts or introducing speculative platform redesign.

## Execution update

- **Completed in this tranche**: T1 cache hardening, T2 embedding fallback visibility, T3 LanceDB guardrails, T4 retrieval concurrency limiting, T5 worker guardrails, T6 consolidation/validation.
- **Completed after T7 follow-up**: Phase 0 config/profile controls, kill switches, bench resource telemetry, labeled holdout fixture support, offline retrieval-quality reporting, and zero-flags/default-contract regression coverage. A second bounded wave also landed chunk/model alignment, shared transformer loading, SQLite incremental lexical reuse, and observability/memory-pressure guardrails.
- **Completed bounded wave**: `query-expansion-cache`, `true-rrf-fusion`, and `embedding-cache-impl` are now done. This wave also included identifier-aware lexical+chunk blending and stronger script-vs-test/config/artifact ranking heuristics where needed to close the holdout misses.
- **Validation snapshot**: targeted retrieval/cache/worker/status suites, the focused bench/eval/regression harness suites, the merged Wave 2 retrieval/indexing/memory slice, and the Wave 3 ranking/embedding slice all passed together with `npm run build`.
- **Measured note**: zero-flags holdout quality remains baseline-level by design, while `CE_PERF_PROFILE=quality` now passes the real offline gate with **MRR@10 0.6067 / nDCG@10 0.7036 / Recall@10 1.0 / P@1 0.4**. The earlier script-query misses are resolved; remaining ranking pressure is concentrated in a few non-script queries where config/artifact/test echoes still compete.
- **Follow-up after Wave 3**: the retrieval pipeline now supports a rerank latency budget guardrail that skips rerank when prior stages have already consumed the configured headroom and caps rerank timeout to the remaining budget when only partial headroom remains.
- **Final tranche additions**: alternate embedding-model evaluation seams (`CE_RETRIEVAL_TRANSFORMER_MODEL_ID`, `CE_RETRIEVAL_TRANSFORMER_VECTOR_DIMENSION`, `CE_RETRIEVAL_TRANSFORMER_LOCAL_MODEL_PATH`) are landed with first-load validation/fail-open behavior; cache invalidation coverage now explicitly exercises TTL, content mutation, defensive-copy, and rebuild invalidation paths; and a feature-gated local cross-encoder rerank runtime is implemented without changing the default gate path.

## Minimum viable result

Ship a first bounded tranche that:

1. fixes the highest-risk correctness and reliability issues already visible in the current runtime,
2. improves retrieval hot-path behavior in measurable ways,
3. keeps all public MCP tool names and schemas stable,
4. adds enough validation and rollback guardrails to safely continue later performance work.

## Scope lock

### In scope

- harden `ResponseCache` to avoid stale cross-step reuse and unbounded growth
- surface transformer-runtime fallback failures instead of silently degrading
- make LanceDB refresh/update paths safer and less wasteful
- limit retrieval parallelism to avoid local I/O saturation
- add worker guardrails for index execution
- preserve existing feature-flagged rollout behavior

### Out of scope for this tranche

- cross-encoder reranker replacement
- embedding-model migration
- full evaluation harness buildout
- IVF-PQ or alternate vector backends
- a brand new multi-tier cache architecture
- public MCP schema changes

## Review conclusions that changed the plan

- The chunk-size and embedding-context mismatch is real, but it touches shared retrieval quality decisions and should land after baseline and guardrail work.
- `ResponseCache` hardening is immediately actionable and independent.
- LanceDB already batches embeddings and writes in places; the real gaps are recovery safety, redundant index checks, and bounded write behavior.
- Worker parallelism must be conservative because the transformer runtime is memory-heavy.
- The plan should execute in bounded waves, not as one giant optimization pass.

## Task list

### T0: Freeze baseline and contract safety
- **depends_on**: []
- **files**: `package.json`, `scripts/bench.ts`, `tests/**/*`, retrieval contracts
- **goal**: keep a stable measurement and regression baseline before invasive retrieval changes
- **validation**: existing build/tests/bench commands run cleanly before and after tranche changes

### T1: Harden reactive response caching
- **depends_on**: []
- **files**: `src/reactive/cache/ResponseCache.ts`, reactive cache tests
- **goal**:
  - bound commit-cache growth
  - avoid shared-reference mutations when promoting cached results
  - include review-step scope in file-hash reuse
- **validation**:
  - cache-hit behavior preserved for same-step lookups
  - distinct review steps do not collide
  - eviction stays bounded

### T2: Surface embedding-runtime degradation
- **depends_on**: []
- **files**: `src/internal/retrieval/embeddingRuntime.ts`, `src/mcp/tools/status.ts`, status/runtime tests
- **goal**:
  - record transformer load failures
  - expose degraded embedding runtime state
  - retry instead of permanently pinning fallback on first failure
- **validation**:
  - failing runtime increments metrics / status signal
  - successful retry clears degraded state

### T3: Make LanceDB refresh safer and cheaper
- **depends_on**: []
- **files**: `src/internal/retrieval/lancedbVectorIndex.ts`, LanceDB tests
- **goal**:
  - classify transient vs destructive recovery paths
  - batch large `table.add()` operations in bounded chunks
  - avoid repeated `ensureVectorIndex()` work when nothing changed
  - add vector-index state integrity checks
- **validation**:
  - incremental refresh preserves index/docs consistency
  - recoverable failures do not immediately wipe artifacts
  - repeated searches avoid redundant index-management work

### T4: Add retrieval concurrency guardrails
- **depends_on**: []
- **files**: `src/internal/retrieval/retrieve.ts`, retrieval tests
- **goal**:
  - cap per-query variant/backend fan-out with a local semaphore
  - preserve result semantics while reducing local saturation risk
- **validation**:
  - result ordering semantics remain unchanged
  - concurrency cap is observable and configurable

### T5: Add worker execution guardrails
- **depends_on**: []
- **files**: `src/worker/IndexWorker.ts`, worker tests
- **goal**:
  - improve worker failure reporting
  - keep indexing workers bounded and explicit about error/exit states
- **validation**:
  - worker failures surface deterministically
  - no nested-worker regressions

### T6: Consolidate and validate tranche
- **depends_on**: [T1, T2, T3, T4, T5]
- **files**: touched runtime files, tests, plan doc if needed
- **goal**:
  - merge non-overlapping slices
  - resolve conflicts
  - run focused tests, build, and relevant validation
- **validation**:
  - combined tranche passes targeted tests plus build
  - no MCP contract changes

### T7: Re-plan next tranche from updated baseline
- **depends_on**: [T6]
- **files**: this plan or follow-on plan
- **goal**:
  - decide whether next work should prioritize chunking/model quality, config profiles, or evaluation harness
- **validation**:
  - next wave has measured evidence and a bounded scope

## Dependency map

```text
T0
T1 ----\
T2 -----\
T3 -------> T6 -> T7
T4 -----/
T5 ----/
```

## Parallelizable slices

| Wave | Tasks | Why parallel is safe |
|------|-------|----------------------|
| 0 | T0 | baseline and validation setup |
| 1 | T1, T2, T3, T4, T5 | each slice owns different runtime files and can be consolidated later |
| 2 | T6 | merge, resolve, validate |
| 3 | T7 | follow-on planning from new baseline |

## Initial implementation wave

Start with the independent Wave 1 slices:

1. **Cache hardening**: `T1`
2. **Embedding fallback visibility**: `T2`
3. **LanceDB safety/perf guardrails**: `T3`
4. **Retrieval concurrency cap**: `T4`
5. **Worker guardrails**: `T5`

## Validation notes

- Run targeted tests for each slice before consolidation.
- Run build after consolidation.
- Prefer focused regression coverage over broad speculative refactors.
- Keep feature-flag behavior stable unless the slice explicitly adds a safer guardrail.

## Rollback notes

- Each Wave 1 slice should be revertible independently.
- If T3 regresses retrieval behavior, roll back the LanceDB slice without reverting the cache or worker slices.
- If T2 status signaling proves noisy, keep the runtime metric and roll back only the user-facing status output.
- Do not bundle public-contract changes with runtime guardrail changes.
