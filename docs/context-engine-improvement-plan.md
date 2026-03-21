# Context-Engine Improvement Plan

## Guiding rule

Keep **production retrieval fully open-source and self-hosted/local where possible**, and use **Codex only as the engineering acceleration layer** for refactoring, test generation, benchmarking, rollout prep, and documentation. That fits Codex’s intended role as a coding agent that can work in the CLI, IDE, cloud, and MCP-based workflows, and it supports repo guidance through `AGENTS.md` and reusable Skills.

## Target end-state

The target architecture should be:

- **Chunking and parsing:** Tree-sitter
- **Lexical retrieval:** SQLite FTS5
- **Vector retrieval:** LanceDB OSS for the MVP vector path, with a later post-MVP option to evaluate Qdrant for production-scale needs
- **Embeddings:** local open-source embedding model via ONNX Runtime or a self-hosted embeddings service
- **Reranking:** local open-source cross-encoder reranker
- **Emergency fallback only:** ripgrep, not filesystem scanning as the normal path
- **Evaluation:** BEIR-style retrieval benchmarking plus Ragas-style answer and workflow evaluation

That target is practical because Tree-sitter is built for incremental parsing, FTS5 is SQLite’s full-text search module, LanceDB OSS can run embedded like SQLite, and ONNX Runtime has official Node.js support for CPU and selected acceleration backends. Qdrant remains a later option if the MVP proves out and the scale/ops tradeoff justifies a second backend.

## Architecture Decision Record: MVP Vector Backend

### Status

Accepted for MVP planning.

### Decision

Use **LanceDB-first** as the only vector backend path for the MVP migration.

During the MVP phase:

- do not introduce Qdrant as a second active backend
- do not add dual-write or dual-read routing
- do not let runtime selection switch between vector stores
- keep the vector layer single-path so the rest of the migration can be benchmarked and stabilized deterministically

### Rationale

- LanceDB fits the self-hosted, local-first direction of this plan.
- An embedded vector store keeps operational overhead low while the rest of the pipeline is still changing.
- A single MVP backend makes shadowing, benchmarking, and rollback much easier to reason about.
- It reduces the risk of parallel backend drift while chunking, lexical search, reranking, and incremental indexing are still being built.

### Tradeoffs

- LanceDB is a smaller operational step than Qdrant, so the scale ceiling is lower for the MVP.
- If production demand later requires it, a Qdrant migration can be treated as a post-MVP follow-on decision.
- This keeps the first release simpler, but it intentionally defers higher-scale backend choices.

### Non-goals

- No Qdrant rollout in the MVP.
- No multi-backend routing or backend fan-out.
- No dual-write synchronization between vector stores.
- No caller-visible API change to expose backend choice.
- No hidden fallback from LanceDB to another vector database.

### Phase Boundaries

This decision constrains the rest of the migration phases:

- **Phase 3:** chunking and metadata must produce LanceDB-friendly artifacts.
- **Phase 4:** lexical search remains separate and does not introduce a second vector path.
- **Phase 5:** vector retrieval binds to LanceDB-only MVP wiring.
- **Phase 6:** hybrid fusion and reranking consume LanceDB-backed retrieval results.
- **Phase 7:** incremental indexing updates the LanceDB artifacts instead of branching to a second store.
- **Phase 8:** intent routing and context packing must assume a single MVP vector backend.
- **Phase 9:** shadow/canary rollout compares legacy retrieval against LanceDB only.
- **Phase 10:** legacy hot-path removal only happens after LanceDB parity and rollback gates are satisfied.

### Freeze Criteria

Any request to add a second vector backend, dual-write path, or runtime backend switch during the MVP must be treated as a new architecture decision and must not be implemented under the current plan without an explicit revision.

---

# Workstream 0 — Codex Enablement

This starts first, before the retrieval rewrite.

## Purpose

Use Codex to make the migration safer and faster, but do not place Codex in the production semantic-search hot path. Codex should help your team write code, inspect the repo, generate tests, review diffs, and automate benchmark workflows. OpenAI’s current Codex docs explicitly position it as a coding agent and support `AGENTS.md`, Skills, CLI, IDE, cloud workflows, and MCP connectivity.

## What to implement

Create a root `AGENTS.md` that tells Codex:

- repository rules
- forbidden changes
- rollout constraints
- required tests before merge
- performance thresholds
- where retrieval code lives
- how to run index rebuilds and benchmarks

Codex reads `AGENTS.md` before doing work, and Skills are meant to package instructions, resources, and optional scripts for repeatable workflows.

## Required Codex Skills

Create at least these Skills:

- `audit-retrieval`
- `build-eval-dataset`
- `generate-regression-tests`
- `benchmark-retrieval`
- `compare-legacy-vs-v2`
- `prepare-rollout-pr`
- `validate-index-schema`
- `write-runbook`

## Rules for using Codex

Codex may:
- generate or refactor code
- generate tests
- produce benchmark harnesses
- analyze regressions
- propose PR-ready changes
- draft migration docs

Codex may not:
- become the live retrieval engine
- replace your local embedding or search infrastructure
- bypass tests, rollout gates, or feature flags

---

# Phase 1 — Safety rails, observability, and freeze the public contract

## Objective

Make it safe to improve internals without breaking the application.

## Actions

Keep these unchanged:
- API routes
- tool names
- response schemas
- path formatting
- line-range formatting
- caller-visible behavior

Add new internal interfaces:
- `RetrievalProviderV2`
- `IndexStoreV2`
- `ChunkStoreV2`
- `RerankerV2`
- `SearchTelemetryV2`

Add feature flags:
- `CE_RETRIEVAL_V2`
- `CE_RETRIEVAL_V2_SHADOW`
- `CE_VECTOR_INDEX_V2`
- `CE_RERANK_V2`
- `CE_TREE_SITTER_CHUNKING`
- `CE_DISABLE_LEGACY_RUNTIME_SEMANTIC`
- `CE_FORCE_LEGACY_RETRIEVAL`
- `CE_FORCE_FALLBACK_ONLY`

Version every artifact with:
- schema version
- chunking version
- parser version
- embedding model id
- vector dimension
- created-at timestamp
- workspace fingerprint

## Required telemetry

Track:
- p50, p95, p99 search latency
- queue wait time
- fallback rate
- query embedding time
- lexical search time
- vector search time
- rerank time
- context packing time
- index build time
- incremental update time
- memory and CPU
- old-vs-new overlap during shadow mode

## Codex in this phase

Use Codex to:
- add feature flags
- add telemetry hooks
- create snapshot tests for current responses
- generate “do not break” regression cases
- produce a rollout checklist per endpoint

## Exit criteria

You can switch between old and new retrieval with one flag, and you can measure performance and relevance before changing behavior.

## Retrieval V2 Artifact and Fallback Domain Contract

### Objective

Define the versioned artifact shape and fallback-domain boundaries now, before any migration wave starts writing new runtime paths. The goal is to keep shadowing, benchmarking, and rollback deterministic while preserving the public MCP contract.

### Current runtime split

These are the relevant current codepaths:

- `ContextServiceClient.semanticSearch()` drives the public search flow and caches the final results.
- `ContextServiceClient.searchWithProviderRuntime()` wraps the provider-backed semantic runtime.
- `searchWithSemanticRuntime()` owns the provider parse path and the local keyword fallback path.
- `keywordFallbackSearch()` is the retrieval fallback domain.
- `searchAndAsk()` plus `SearchQueuePressureTimeoutError` are AI-provider admission and execution concerns.
- `parseAIProviderSearchResults()` only parses provider payloads; parse success or failure does not by itself mean the retrieval layer failed.

### Artifact contract

Any retrieval artifact or benchmark payload that participates in shadow compare, rollout gates, or regression review should carry at least:

- `artifact_schema_version`
- `retrieval_engine_version`
- `chunking_version`
- `parser_version`
- `embedding_model_id`
- `vector_dimension`
- `retrieval_provider`
- `workspace_fingerprint`
- `index_fingerprint`
- `feature_flags_snapshot`
- `env_fingerprint`
- `fallback_domain`
- `fallback_reason`

### Fallback domain rules

- `retrieval` domain:
  - keyword fallback after provider parse failure
  - compatibility fallback for explicit empty provider arrays when the compat flag is on
  - operational/setup fast-path fallback
- `ai_provider` domain:
  - queue admission rejection
  - queue timeout budget rejection
  - provider call failure
  - provider auth failure
  - malformed provider payload that cannot be represented as retrieval output

### Compatibility rules

- Public MCP tool names, request shapes, and response shapes stay unchanged in this phase.
- Missing V2 artifact metadata implies legacy handling, not a hard failure.
- Retrieval shadow compare should treat mismatched artifact schema versions as a rollout signal, not a caller-visible error.
- Provider fallback and retrieval fallback must be measured separately so a provider outage does not get misclassified as a retrieval-quality regression.

### Rollback semantics

- If artifact validation fails, keep the legacy retrieval path as the default.
- If fallback-domain labels disagree with actual behavior, fail the rollout gate and do not widen the canary.
- If shadow compare detects parity drift, treat the issue as a rollback candidate before any public contract change.
- Legacy compatibility flags remain the escape hatch until a later architecture revision explicitly removes them.

### Related flags

- `CE_SEMANTIC_EMPTY_ARRAY_COMPAT_FALLBACK` and `CE_SEMANTIC_PARALLEL_FALLBACK` belong to the retrieval fallback domain.
- `CE_SEARCH_AND_ASK_QUEUE_REJECT_MODE` belongs to the AI-provider admission domain.
- `CE_RETRIEVAL_SHADOW_COMPARE_ENABLED` and `CE_RETRIEVAL_SHADOW_SAMPLE_RATE` are shadow-only observability controls.

---

# Phase 2 — Build the evaluation foundation

## Objective

Create the dataset and test harness that will tell you whether the new engine is truly better.

## Actions

Build a real internal retrieval eval set with at least:
- exact symbol lookups
- file path lookups
- config lookups
- docs/setup queries
- debugging/root-cause questions
- cross-file behavior questions
- test-file discovery queries
- recency-sensitive repo questions if your system supports them

Measure:
- Recall@5 and @10
- MRR
- nDCG
- exact-file hit rate
- exact-symbol hit rate
- time to first result
- total search latency

Use BEIR as the retrieval evaluation discipline and Ragas for broader application-level eval loops.

## Codex in this phase

Use Codex to:
- label and normalize query sets
- generate benchmark scripts
- write comparison reports
- synthesize failure cases into reproducible tests
- prepare “why this result was wrong” reports for the team

## Exit criteria

You have a repeatable benchmark that can fail the build if retrieval quality or latency regresses.

---

# Phase 3 — Replace file-level search with chunk-based indexing

## Objective

Move from file-level scanning to chunk-level retrieval.

## Actions

Chunk the repository into searchable units:
- functions
- methods
- classes
- interfaces
- imports/exports
- tests
- docs sections
- config blocks

Store metadata per chunk:
- `chunk_id`
- file path
- language
- symbol name
- symbol type
- start/end lines
- parent symbol
- imports
- neighboring chunk ids
- commit/hash metadata if available

Use Tree-sitter as the default parser because it is an incremental parsing library that can efficiently update syntax trees as files change.

Fallback to line-window chunking only for unsupported languages or malformed files.

## Codex in this phase

Use Codex to:
- scaffold language-specific chunkers
- generate parser tests
- create bad-file and malformed-source tests
- standardize chunk metadata contracts
- document chunking heuristics in `AGENTS.md` and repo docs

## Exit criteria

The system can build a chunk store from the repo and answer “which chunk, not just which file?” reliably.

---

# Phase 4 — Build the lexical retrieval layer

## Objective

Make lexical search fast, correct, and independent of filesystem scans.

## Actions

Use SQLite FTS5 as the default lexical layer.

Build separate searchable structures for:
- chunk text
- file paths
- symbol names
- imports
- test names
- docs headings

Add boosts for:
- exact symbol matches
- exact path matches
- camelCase and snake_case decomposition
- recently changed files if that matters to your product
- tests when the query implies tests

Keep ripgrep only as a last-resort operational fallback.

## Codex in this phase

Use Codex to:
- write FTS schema migrations
- generate tokenizer and normalization tests
- compare FTS results with the old fallback results
- produce query examples that expose ranking flaws

## Exit criteria

Normal keyword/path/symbol queries no longer depend on recursive file scanning.

---

# Phase 5 — Build the vector retrieval layer

## Objective

Add true semantic retrieval that is index-based, not provider-driven at query time.

## Actions

Choose one of these paths:

### Preferred production path
Use **Qdrant** if you want a dedicated vector engine with HNSW, payload indexing, and room to scale.

### Simpler first rollout
Use **LanceDB OSS** if you want an embedded, in-process database first.

### Embeddings
Use a real open-source embedding model, not a placeholder embedding scheme. Good first candidates:
- `sentence-transformers/all-MiniLM-L6-v2`
- `BAAI/bge-small-en-v1.5`

### Runtime
Use ONNX Runtime in Node if you want local embeddings directly in the app or worker process.

### Optional serving layer
If you want a self-hosted model server instead of embedding inside the app process, use:
- Hugging Face TEI for embeddings
- Infinity if you want a lightweight open-source REST layer for embeddings and reranking

## Important design rule

All chunk embeddings must be computed at **index time**, not during search. Query time should only:
- embed the query
- run ANN search
- return candidates

## Codex in this phase

Use Codex to:
- generate the vector-index integration
- build migration scripts
- write embedding-cache tests
- generate performance benchmarks for CPU and optional GPU modes
- diff Qdrant vs LanceDB behavior on your evaluation set

## Exit criteria

Semantic retrieval works without any paid API and without query-time document embedding or LLM-based discovery.

---

# Phase 6 — Add reranking and hybrid fusion

## Objective

Improve result quality while keeping latency predictable.

## Actions

Use hybrid retrieval:
- lexical top N
- vector top N
- dedupe
- reciprocal-rank or weighted fusion
- rerank only the top small candidate set

Recommended reranker:
- `cross-encoder/ms-marco-MiniLM-L6-v2` first
- optionally `bge-reranker-base` later if needed

Do not rerank everything. Start with reranking only the top 10–20 fused candidates.

## Codex in this phase

Use Codex to:
- tune fusion weights
- produce ablation tests
- generate “quality gain vs latency cost” reports
- write guardrail tests that fail if rerank cost exceeds the budget

## Exit criteria

You can show measurable quality gains over lexical-only and vector-only baselines without blowing up p95 latency.

---

# Phase 7 — Rebuild indexing as an incremental pipeline

## Objective

Move heavy work out of the hot path and into background indexing.

## Actions

Index-time work should include:
- file discovery
- parsing
- chunking
- symbol extraction
- metadata extraction
- chunk embedding
- lexical indexing
- vector indexing
- neighbor linking
- cleanup of stale chunks on deletes

Use:
- watcher-driven updates
- worker threads or background jobs
- debounce windows
- partial rebuilds for changed files only
- checkpointed index state
- startup validation instead of full rebuild on every launch

Warm-load:
- lexical index
- vector collection
- symbol map
- frequently accessed metadata

## Codex in this phase

Use Codex to:
- generate worker orchestration code
- write failure-recovery logic
- build index-corruption tests
- produce operator docs for rebuild, repair, and warm startup

## Exit criteria

Search stays fast under repeated queries, and repo changes trigger cheap incremental updates instead of broad reprocessing.

---

# Phase 8 — Improve capability beyond speed

## Objective

Make the context-engine smarter, not just faster.

## Actions

Add query-intent routing:
- symbol lookup
- path lookup
- debug/root cause
- docs/setup
- config query
- test query
- architecture query

Add structure-aware expansion:
- containing symbol
- neighboring chunks
- test-implementation pairing
- config/schema pairing
- import-linked chunks
- optionally recent-change boost

Add context packing:
- deduplicate by file and symbol
- keep stable line ranges
- pack high-value chunks first
- enforce token budgets
- keep provenance per chunk

This increases usefulness for downstream answering, debugging, and codebase navigation without relying on large runtime prompts.

## Codex in this phase

Use Codex to:
- generate routing rules
- propose heuristics from bad-query logs
- create capability-specific regression tests
- document how each intent is resolved

## Exit criteria

The engine returns more relevant and more compact context for different query types.

---

# Phase 9 — Rollout without breaking the app

## Objective

Ship safely.

## Actions

### Shadow mode
Run legacy and v2 retrieval in parallel:
- serve legacy
- log v2
- compare overlap, latency, and misses

### Canary mode
Serve v2 to a small percentage:
- internal users first
- then low-risk traffic
- then default-on

### Kill switch
At every stage, keep one config flag that returns the system to legacy behavior immediately.

### Operational tooling
Ship commands for:
- validate index
- full rebuild
- changed-files rebuild
- clear cache
- compare legacy vs v2 results
- inspect chunk by file/line
- print benchmark summary

### Track A rollout playbook
Use this sequence for stabilization releases (Track A). The goal is to ship performance/reliability improvements while preserving caller-visible tool contracts.

Stages:
- PR stage: run the deterministic CI gate suite and block merges on the PR gate thresholds in `docs/BENCHMARKING_GATES.md`.
- Shadow stage: enable the change in a "shadow" configuration where possible, or run paired baseline vs candidate benchmarks without changing the primary response path.
- Canary stage: enable for internal users first, then broaden gradually only after clean gate windows.
- Release stage: promote only after nightly stability and rollback drills are proven.

Evidence bundle (required for promotion decisions):
- Approved baseline artifact and candidate artifact for the same dataset id + dataset hash and environment class.
- Provenance lock fields present and matching (commit SHA, workspace fingerprint, index fingerprint, feature-flag snapshot, node/os/env fingerprints).
- Gate verdict output: PASS/FAIL plus triggered conditions and operator action (proceed, hold, rollback).
- If applicable: shadow overlap report and queue/timeout distribution report (p95 queue wait, p95 duration, error rate).

Minimum sample windows:
- Benchmarks: at least 3 replicates per required slice before promotion decisions.
- Nightly stability: treat "persistent nightly failures" and "unstable variance" as defined in `docs/BENCHMARKING_GATES.md` before promoting beyond canary.

Numeric gates:
- PR gates: fail on p95 regression greater than +15%, error rate increase greater than +0.5pp, overlap below 0.85, `unique_files@k` drop greater than 10%, or other PR gate breaches in `docs/BENCHMARKING_GATES.md`.
- Nightly gates: fail on any PR gate breach, deep retrieval p95 regression greater than +20%, cache hit rate drop greater than 10pp, or abort thresholds in `docs/BENCHMARKING_GATES.md`.
- Release gates: do not promote if nightly failures are persistent or variance is unstable (definitions in `docs/BENCHMARKING_GATES.md`).

Rollback and kill-switch posture:
- Kill switch must exist for each Track A tuning change: disable the flag(s) and revert to the last known-good baseline behavior immediately.
- If the evidence bundle is incomplete, the stage is HOLD (not PASS).
- If any abort threshold is breached, or if nightly failures meet the "persistent" definition, rollback is mandatory even if a partial sample passed.

## Shadow Parity Framework

This is a rollout specification, not a runtime implementation. It defines the evidence shape needed to compare the legacy retrieval path against the LanceDB-first candidate path before canary or release promotion.

### Comparison model

- Legacy reference: the current retrieval path.
- Candidate: the LanceDB-first path under shadow comparison.
- Pairing: the same query text, tool, profile, state, query family, repo size, queue lane, dataset id/hash, workspace/index fingerprints, and feature-flag snapshot.

### Parity dimensions

| Dimension | Required evidence | Promotion rule |
| --- | --- | --- |
| Overlap | top-k overlap, unique-files-at-k, exact-path agreement, exact-symbol agreement, per-query mismatch samples | Hold if overlap drops outside the budget in `docs/BENCHMARKING_GATES.md` |
| Error | error-rate delta, empty-result delta, fallback delta, timeout/reject delta, malformed-result delta | Hold or rollback if candidate adds failure modes or widens fallback/reject behavior |
| Latency | p50/p95/p99, queue wait, execution time, compare overhead | Do not promote on latency wins alone; latency must clear the gate budget together with parity |

### Required shadow evidence outputs

- raw legacy shadow artifact
- raw candidate shadow artifact
- shadow compare summary report
- mismatch sample list
- provenance integrity check result
- gate decision record with `proceed`, `hold`, or `rollback`

### Evidence fields

Any shadow comparison artifact should retain the existing benchmark provenance lock plus:

- `shadow_compare_enabled`
- `shadow_sample_rate`
- `shadow_pair_id`
- `comparison_role`
- `comparison_window_start`
- `comparison_window_end`
- `query_fingerprint`
- `paired_query_count`
- `legacy_artifact_path`
- `candidate_artifact_path`
- `overlap_at_k`
- `unique_files_at_k`
- `error_rate_delta`
- `empty_result_rate_delta`
- `fallback_rate_delta`
- `p95_latency_delta`
- `queue_wait_p95_delta`

### Gate linkage

- Shadow comparison is required before canary and release promotion when the shadow flag is enabled.
- The shadow framework feeds the same go or no-go decisions as `docs/BENCHMARKING_GATES.md` and the rollout steps in `docs/ROLLOUT_RUNBOOK.md`.
- If the parity report is incomplete, the stage stays `HOLD`.
- If overlap or error budgets fail, treat the release as a rollback candidate even if latency improves.

## Codex in this phase

Use Codex to:
- prepare rollout PRs
- generate changelogs
- build shadow comparison dashboards
- summarize regressions from canary traffic
- draft rollback runbooks and incident docs

## Exit criteria

V2 becomes default only after:
- quality meets or beats legacy
- p95 latency is materially lower
- fallback use becomes rare
- rollback is proven
- no public contract changes are introduced

## Migration Canary and Rollback Criteria

This section turns the shadow evidence from T14 into operator decisions for canary, ramp, and rollback.

### Entry conditions

- The shadow parity framework is complete and producing compare artifacts.
- The Phase 9 rollout playbook remains the operational source of truth for stage changes.
- The required shadow evidence bundle is present: legacy artifact, candidate artifact, compare summary, mismatch samples, and provenance integrity check.
- `CE_ROLLOUT_ENFORCE_GATES` stays enabled during canary and controlled ramp.

### Promotion rules

- Start canary only after shadow parity evidence and rollback drill evidence are both green.
- Widen canary only when PR and nightly gates continue to pass and the parity report stays within the approved budgets.
- Move to controlled ramp only after canary evidence is stable and the rollback posture is still green.
- Move to GA hardening only after controlled ramp evidence is stable and release-gate evidence is complete.

### Abort and rollback triggers

| Trigger | Required action |
| --- | --- |
| Parity report incomplete | Hold; do not widen canary. |
| Any PR or nightly gate breach | Stop progression and execute rollback order. |
| Overlap or error budget failure | Treat as rollback candidate even if latency improves. |
| Stale or failing rollback drill | Keep the stage at `dark_launch` and refresh the drill evidence before retrying. |
| Runtime instability or severe error trend | Set the kill switch and revert to the last known-good stage. |

### Required artifacts

- Shadow compare summary report
- Gate decision record
- Rollback drill log
- Rollout evidence log entries for canary and controlled ramp
- Provenance integrity check result

### Rollback order

1. Set `CE_ROLLOUT_KILL_SWITCH=true`
2. Set `CE_ROLLOUT_CANARY_PERCENT=0`
3. Move stage to `dark_launch`
4. Keep `CE_ROLLOUT_ENFORCE_GATES=true`
5. Re-run readiness checks and publish the rollback summary

### Ownership

- Release owner: promotion decisions
- On-call operator: rollback and kill switch
- Benchmark owner: parity evidence integrity
- Architecture lead: any future contract revision

## Migration Failure-Mode Rehearsal Plan

Rehearse the failure modes that matter most before any default flip.

### Rehearsal matrix

| Scenario | Trigger | Expected response | Evidence |
| --- | --- | --- | --- |
| Partial rollback | Parity failure or runtime instability during canary | Revert to `dark_launch` and keep the legacy path primary. | Rollback drill log and gate record. |
| Dual-read mismatch | Legacy and candidate disagree beyond the parity budget | Hold the stage and sample mismatch cases. | Shadow compare summary and mismatch sample list. |
| Replay | Duplicated or retried shadow traffic | Idempotent compare output; no duplicate promotion. | Shadow artifact summary and provenance check. |
| Downgrade | Artifact schema or version mismatch | Fall back to legacy handling and block promotion. | Artifact validation report. |

### Pass criteria

- Drill artifact exists.
- Controls are verified.
- Ownership is recorded.
- Evidence is complete.

---

# Phase 10 — Decommission legacy runtime retrieval

## Objective

Remove the parts that keep the system slow and fragile.

## Actions

Only after one stable release cycle:
- retire query-time LLM-assisted retrieval on the hot path
- retire legacy filesystem-based keyword scanning as a normal path
- keep only minimal emergency fallback
- archive legacy code behind a maintenance branch or feature tombstone plan
- keep benchmark suites permanently

## Codex in this phase

Use Codex to:
- identify dead code
- prepare cleanup PRs
- update docs and diagrams
- ensure old flags are removed safely

## Exit criteria

The application’s default retrieval path is now:
- open-source
- indexed
- incremental
- hybrid
- locally controllable
- faster and easier to operate

---

# Recommended open-source stack

## Default recommendation

If you want the best balance of safety and capability, use:

- Tree-sitter
- SQLite FTS5
- Qdrant
- ONNX Runtime Node
- `BAAI/bge-small-en-v1.5` or `all-MiniLM-L6-v2`
- `cross-encoder/ms-marco-MiniLM-L6-v2`
- Ragas
- BEIR-style benchmarks
- ripgrep as emergency fallback only

## Simpler first deployment

If you want fewer moving parts at first:
- Tree-sitter
- SQLite FTS5
- LanceDB OSS
- ONNX Runtime Node
- same embedding and reranker choices

LanceDB OSS is a strong option when you want the vector store embedded in-process during the first migration stage.

---

# Non-negotiable rules

- No paid API in the production retrieval path.
- No LLM-based retrieval as the default hot path.
- No query-time document embedding.
- No full repo scans as the normal fallback.
- No rollout without shadow mode and kill switches.
- No schema changes without versioned index artifacts.
- No Codex-generated change merged without tests and benchmarks.

---

# Most important things to do first

1. Add `AGENTS.md`, Codex Skills, flags, and telemetry.
2. Build the eval dataset and benchmark harness.
3. Implement chunking with Tree-sitter.
4. Stand up lexical retrieval with SQLite FTS5.
5. Stand up vector retrieval with Qdrant or LanceDB.
6. Move embeddings to index time.
7. Add reranking and hybrid fusion.
8. Build incremental indexing and warm startup.
9. Run shadow mode, then canary rollout.
10. Remove legacy hot-path retrieval only after the new path proves itself.

# One-line summary

**Use Codex to help your team build and safely ship Retrieval V2, but keep the production context-engine itself fully open-source, indexed, local/self-hosted, and designed so nearly all heavy work happens at indexing time instead of search time.**
