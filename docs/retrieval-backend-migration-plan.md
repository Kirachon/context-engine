# Plan: Retrieval Backend Migration

**Generated**: 2026-03-21
**Estimated Complexity**: High

## Overview
This plan covers the next migration phase after the chunk-aware exact-search foundation.
The goal is to replace the remaining query-time retrieval shortcuts with a real indexed backend while keeping the public MCP contract stable.

The migration should stay local-first and self-hosted, with `LanceDB-first` as the MVP vector backend and no dual-backend routing during the MVP.

Current state that this plan builds on:
- chunk-aware exact search foundation already exists
- local keyword fallback and provider-backed semantic search still coexist
- retrieval still depends on heuristic scoring, file scans, and local caches in key paths
- the improvement plan already defines the long-term target architecture and MVP backend choice

## Prerequisites
- Current hot-path hardening remains committed and pushed
- Baseline benchmark artifacts and gating docs already exist
- Public tool names and response shapes remain frozen for `semantic_search` and `codebase_retrieval`
- The MVP backend decision is fixed to `LanceDB-first`
- Feature-flag-driven rollout must remain the only way to flip migration behavior

## Sprint 1: Architecture Freeze and V2 Seams
**Goal**: Define the backend migration boundaries before new storage or parser code lands.

**Demo/Validation**:
- Review a signed-off architecture note for the V2 seams
- Confirm the current retrieval contract still passes existing tests

### Task 1.1: Define V2 Artifact and Store Contracts
- **Location**: `docs/context-engine-improvement-plan.md`, `docs/retrieval-backend-migration-plan.md`
- **Description**: Freeze the versioned artifact fields for parser, chunk, lexical, vector, and rerank stages.
- **Dependencies**: None
- **Acceptance Criteria**:
  - Artifact schema fields are explicit
  - Retrieval fallback and AI-provider fallback remain separate domains
  - No caller-visible API shape changes are introduced
- **Validation**:
  - Plan review against the current contract docs

### Task 1.2: Add Internal Adapter Boundaries
- **Location**: `src/internal/retrieval/types.ts`, `src/internal/retrieval/retrieve.ts`, `src/mcp/serviceClient.ts`
- **Description**: Define the internal seams for parser, chunk store, lexical store, vector store, and reranker adapters without changing public tool output.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Adapter interfaces are documented
  - The migration path can be swapped by feature flag
  - Legacy behavior remains the default
- **Validation**:
  - Architecture review and interface mapping

### Task 1.3: Lock Migration Flags and Rollout Posture
- **Location**: `src/config/features.ts`, `docs/FLAG_REGISTRY.md`, `docs/ROLLOUT_RUNBOOK.md`
- **Description**: Add or confirm the exact migration flags needed for Tree-sitter, FTS5, LanceDB, reranker, and shadow rollout control.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Every new backend surface has a flag owner
  - Default remains off or legacy-compatible until shadowing is ready
- **Validation**:
  - Flag registry review and default-state confirmation

## Sprint 2: Parser and Chunk Store
**Goal**: Replace heuristic chunking with a real parser-driven chunk pipeline.

**Demo/Validation**:
- A workspace file is parsed into stable chunks
- Incremental refresh updates only changed files
- Chunk IDs remain stable across unchanged content

### Task 2.1: Integrate Tree-sitter Parsing
- **Location**: `src/internal/retrieval/`, `package.json`, `docs/context-engine-improvement-plan.md`
- **Description**: Add parser-driven chunk extraction and metadata generation for supported file types.
- **Dependencies**: Sprint 1 complete
- **Acceptance Criteria**:
  - Parser output is chunk-aware
  - Declaration, function, class, and heading boundaries are preserved where possible
  - Unsupported files fall back safely
- **Validation**:
  - Parser unit tests on representative source files

### Task 2.2: Persist Chunk Artifacts
- **Location**: `src/internal/retrieval/`, workspace artifact files, benchmark docs
- **Description**: Store chunk metadata, stable IDs, parser version, and workspace fingerprints for incremental reuse.
- **Dependencies**: Task 2.1
- **Acceptance Criteria**:
  - Chunk artifacts are versioned
  - Re-indexing unchanged files reuses prior chunk data
  - Deleted files are pruned cleanly
- **Validation**:
  - Refresh and reuse tests

### Task 2.3: Add Parser Regression Coverage
- **Location**: `tests/internal/retrieval/`
- **Description**: Add tests for chunk stability, line ranges, parser fallback, and refresh behavior across edits.
- **Dependencies**: Tasks 2.1-2.2
- **Acceptance Criteria**:
  - Chunk splits are deterministic
  - Incremental parsing does not regress existing results
- **Validation**:
  - Focused parser/chunk test suite

## Sprint 3: SQLite FTS5 Lexical Index
**Goal**: Add a real exact-word search layer for fast symbol and text lookup.

**Demo/Validation**:
- Query exact names and symbols against the lexical index
- Confirm refreshes only touch changed documents

### Task 3.1: Design FTS5 Schema and Refresh Flow
- **Location**: `src/internal/retrieval/`, `docs/context-engine-improvement-plan.md`
- **Description**: Define the lexical index schema, tokenization approach, and incremental update path.
- **Dependencies**: Sprint 1 complete
- **Acceptance Criteria**:
  - Schema includes path, chunk metadata, and searchable text
  - Refresh path is incremental
- **Validation**:
  - Schema review and index build smoke test

### Task 3.2: Wire Lexical Search into Retrieval
- **Location**: `src/internal/retrieval/retrieve.ts`, `src/mcp/serviceClient.ts`
- **Description**: Route lexical candidates through the new index instead of file-scan heuristics.
- **Dependencies**: Task 3.1
- **Acceptance Criteria**:
  - Exact symbol queries are faster and more precise
  - File-scan fallback remains only as a last resort
- **Validation**:
  - Search correctness tests for identifiers, paths, and docs

### Task 3.3: Add FTS5 Regression and Perf Tests
- **Location**: `tests/internal/retrieval/`
- **Description**: Cover symbol lookups, docs queries, artifact exclusions, and incremental index updates.
- **Dependencies**: Tasks 3.1-3.2
- **Acceptance Criteria**:
  - Lexical results are deterministic
  - Regressions are caught by focused tests
- **Validation**:
  - Unit tests and benchmark slice checks

## Sprint 4: LanceDB Vector Retrieval and Embeddings
**Goal**: Introduce the MVP vector path with local embeddings and no multi-backend drift.

**Demo/Validation**:
- A query can reach the vector index and retrieve meaningful semantic matches
- The vector backend uses the LanceDB-first path only

### Task 4.1: Add Embedding Runtime Adapter
- **Location**: `src/internal/retrieval/`, `docs/context-engine-improvement-plan.md`
- **Description**: Add a local embedding runtime adapter that can power index-time embeddings for the vector store.
- **Dependencies**: Sprint 1 complete
- **Acceptance Criteria**:
  - Embedding model identity is recorded in artifacts
  - The runtime is local/self-hosted
- **Validation**:
  - Adapter smoke tests and artifact metadata checks

**Implementation note**:
- The codebase now has a dedicated embedding runtime seam in `src/internal/retrieval/embeddingRuntime.ts`.
- The default runtime remains local and deterministic for now, which keeps the eventual swap to a real local model bounded to one adapter.

### Task 4.2: Build the LanceDB Index Path
- **Location**: `src/internal/retrieval/`, workspace artifact files
- **Description**: Persist and query the MVP vector index through a single LanceDB-backed path.
- **Dependencies**: Task 4.1
- **Acceptance Criteria**:
  - Vector search works without dual-write or dual-read routing
  - Vector artifacts include schema and workspace fingerprints
- **Validation**:
  - Vector index build and query tests

### Task 4.3: Add Vector Retrieval Regression Coverage
- **Location**: `tests/internal/retrieval/`
- **Description**: Verify vector search behavior, fallback handling, and stable metadata.
- **Dependencies**: Tasks 4.1-4.2
- **Acceptance Criteria**:
  - Vector queries are deterministic enough for rollout gates
  - Legacy behavior remains available behind flags
- **Validation**:
  - Focused vector retrieval tests

## Sprint 5: Reranker and Hybrid Fusion
**Goal**: Improve result quality after the new chunk, lexical, and vector sources exist.

**Demo/Validation**:
- Hybrid retrieval returns a better-ranked top result set than any single source alone

### Task 5.1: Add Cross-Encoder Reranker Integration
- **Location**: `src/internal/retrieval/rerank.ts`, `src/internal/retrieval/types.ts`
- **Description**: Add the reranker adapter and timeout policy for the MVP backend stack.
- **Dependencies**: Sprint 4 complete
- **Acceptance Criteria**:
  - Reranker can fail open safely
  - Timeout budgets remain bounded
- **Validation**:
  - Rerank unit tests and fail-open coverage

### Task 5.2: Tune Hybrid Fusion Inputs
- **Location**: `src/internal/retrieval/fusion.ts`, `src/internal/retrieval/retrieve.ts`
- **Description**: Tune source weighting and tie-break behavior for chunk, lexical, and vector candidates.
- **Dependencies**: Task 5.1
- **Acceptance Criteria**:
  - Sources combine deterministically
  - Chunk-level matches are not lost in fusion
- **Validation**:
  - Fusion regression tests and benchmark slices

**Implementation note**:
- Dense retrieval is now enabled for balanced and rich profiles when `CE_RETRIEVAL_LANCEDB_V1=true`, and fusion gives compact chunk hits a small deterministic bonus so chunk-level matches stay visible after merging sources.

### Task 5.3: Add Quality Gates for the New Stack
- **Location**: `docs/BENCHMARKING.md`, `scripts/ci/`
- **Description**: Add relevance metrics and parity gates that make quality changes visible before rollout.
- **Dependencies**: Tasks 5.1-5.2
- **Acceptance Criteria**:
  - Quality and latency are gated together
  - Baseline artifacts remain reproducible
- **Validation**:
  - CI gate execution against sample fixtures

## Sprint 6: Incremental and Background Indexing
**Goal**: Keep heavy indexing work off the live search path.

**Demo/Validation**:
- File changes refresh indexes in the background
- Unchanged files are skipped
- Search remains responsive during updates

### Task 6.1: Build Watcher/Debounce Refresh Flow
- **Location**: `src/mcp/server.ts`, `src/mcp/serviceClient.ts`
- **Description**: Move workspace file changes into an incremental background pipeline for the new stores.
- **Dependencies**: Sprints 2-4
- **Acceptance Criteria**:
  - Change batches do not trigger full reindex work by default
  - Deletions and edits are handled separately
- **Validation**:
  - Watcher tests and incremental refresh tests

### Task 6.2: Add Warm-Load and Recovery Paths
- **Location**: `src/internal/retrieval/`, persistence artifact files
- **Description**: Restore indexes quickly on startup and recover safely from partial refresh failures.
- **Dependencies**: Task 6.1
- **Acceptance Criteria**:
  - Startup does not force full rebuilds
  - Partial failures do not corrupt the store
- **Validation**:
  - Recovery and restart smoke tests

### Task 6.3: Add Indexing Performance Measurements
- **Location**: `docs/BENCHMARKING.md`, `scripts/ci/`
- **Description**: Measure incremental update time, refresh latency, and background queue pressure.
- **Dependencies**: Tasks 6.1-6.2
- **Acceptance Criteria**:
  - Update-time telemetry exists
  - Baseline comparisons can show incremental gains
- **Validation**:
  - Benchmark harness output includes update metrics

## Sprint 7: Shadow Rollout and Legacy Retirement
**Goal**: Compare the new backend against the old path, then retire legacy pieces safely.

**Demo/Validation**:
- Shadow runs compare legacy and candidate results
- Canary gates control promotion
- Legacy fallback can be removed only after parity is stable

### Task 7.1: Shadow Compare the New Backend
- **Location**: `src/mcp/serviceClient.ts`, `docs/BENCHMARKING.md`
- **Description**: Compare the new backend against the current path without changing caller-visible behavior.
- **Dependencies**: Sprints 4-6
- **Acceptance Criteria**:
  - Shadow data is captured separately from primary results
  - Mismatches are visible in gate output
- **Validation**:
  - Shadow compare reports and parity checks

### Task 7.2: Add Canary Promotion and Rollback Rules
- **Location**: `docs/ROLLOUT_RUNBOOK.md`, `docs/context-engine-improvement-plan.md`
- **Description**: Define promotion, rollback, and kill-switch rules for the new backend path.
- **Dependencies**: Task 7.1
- **Acceptance Criteria**:
  - Promotion gates are explicit
  - Rollback is rehearsed before default flip
- **Validation**:
  - Rollout checklist and rehearsal evidence

### Task 7.3: Retire Legacy Hot-Path Fallbacks
- **Location**: `src/mcp/serviceClient.ts`, `src/retrieval/providers/semanticRuntime.ts`
- **Description**: Remove legacy query-time shortcuts only after the new backend proves parity and stability.
- **Dependencies**: Task 7.2
- **Acceptance Criteria**:
  - Legacy fallback is no longer the default path
  - Public MCP contracts remain stable
- **Validation**:
  - Final regression suite and rollout approval

## Testing Strategy
- Keep the current contract tests for `semantic_search` and `codebase_retrieval` in place throughout the migration
- Add focused tests for each new backend layer before wiring the next layer on top
- Use benchmark slices to verify speed and quality separately
- Run shadow parity comparisons before any default-flip decision
- Treat startup, refresh, and rollback behavior as first-class test cases, not afterthoughts

## Potential Risks & Gotchas
- Tree-sitter integration can change chunk boundaries in ways that make old benchmark comparisons noisy
- FTS5 tokenization can improve exact search but may regress docs-heavy or mixed-intent queries if tuned too narrowly
- LanceDB-first keeps the MVP simpler, but it also means the first vector backend must be reliable enough to carry the migration alone
- Incremental indexing can introduce subtle stale-data bugs if deletion and refresh ordering is not handled carefully
- Shadow mode can hide quality drift if metrics are not compared against the same slice matrix used for baselines
- Removing the legacy fallback too early would make the tools brittle during migration

## Rollback Plan
- Keep the current local-native path available behind feature flags until the new backend passes shadow and canary gates
- If a new layer fails, disable only that layer's flag and fall back to the previous working stage
- If the parser or chunk store fails, keep the chunk-aware exact-search foundation as the operational fallback
- If vector or rerank quality regresses, freeze promotion and keep lexical plus existing semantic behavior as the default
- Do not remove legacy retrieval code until parity, rollback drills, and benchmark evidence are all green
