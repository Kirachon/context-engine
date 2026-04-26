# OpenAI MCP Gap Closure T5a Graph Artifact Contract

Purpose: freeze the persistent graph artifact contract before `T5b` lands any durable graph writes or graph-backed tool behavior.

This document is normative for `T5b`, `T7`, `T8`, `T10a`, and `T11b` work that introduces graph extraction, persistence, rebuild logic, or graph-backed tool responses. If implementation needs behavior outside this contract, execution stops until this document is updated.

Linked execution anchors:
- Baseline bundle: [openai-mcp-gap-closure-t0-baseline.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-t0-baseline.md:1)
- Gap ledger: [openai-mcp-gap-closure-gap-ledger.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-gap-ledger.md:1)
- Ownership and gate pack: [openai-mcp-gap-closure-ownership-gate-pack.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-ownership-gate-pack.md:1)
- Plan of record: [openai-mcp-gap-closure-swarm-plan.md](D:\GitProjects\context-engine\openai-mcp-gap-closure-swarm-plan.md:102)

## Current Repo Anchors

The contract is grounded in the existing retrieval/indexing surfaces below.

| Surface | Current anchor | Observed behavior frozen by this contract |
| --- | --- | --- |
| Shared file hash + workspace fingerprinting | `src/mcp/indexStateStore.ts` | The repo already uses deterministic workspace fingerprints and optional normalized content hashing for index artifacts. |
| Lexical persistent artifact | `src/internal/retrieval/sqliteLexicalIndex.ts` | SQLite lexical index persists to `.context-engine-lexical-index.sqlite` and reuses `.context-engine-index-state.json` receipts. |
| Vector persistent artifact | `src/internal/retrieval/lancedbVectorIndex.ts` | LanceDB vectors persist under `.context-engine-lancedb/` with `.context-engine-lancedb-index.json` metadata. |
| Tree-sitter language matrix | `src/internal/retrieval/treeSitterChunkParser.ts` | Tree-sitter support is currently bounded to `typescript`, `tsx`, `python`, `go`, `rust`, `java`, and `csharp`; unsupported files fall back or skip cleanly. |
| Context/retrieval orchestration | `src/mcp/serviceClient.ts` | Retrieval already composes lexical, vector, and chunking layers and carries versioned retrieval artifact metadata. |
| Retrieval contract style | `src/internal/retrieval/v2Contracts.ts`, `tests/internal/retrieval/v2Contracts.test.ts` | The repo already uses versioned artifact envelopes, feature-flag snapshots, and deterministic metadata receipts. |

## Contract Summary

1. The graph store is an additive local artifact, not a replacement for existing lexical/vector indexes.
2. Graph persistence must follow the repo's existing artifact discipline: explicit schema versioning, workspace fingerprinting, deterministic metadata, atomic writes, and safe reset on incompatible future schemas.
3. Graph-backed callers must degrade deterministically when the graph is missing, stale, incomplete, unsupported for a language, or blocked by ownership gates.
4. The first graph rollout supports only the current tree-sitter language matrix unless a later contract expands it.
5. Graph artifacts may inform retrieval and symbol tooling, but they must not silently change MCP/HTTP response schemas before later tasks freeze those contracts.

## Artifact Layout Freeze

### Allowed artifact family

`T5b` may introduce exactly one new graph artifact family under the workspace root:
- graph directory: `.context-engine-graph/`
- graph metadata file: `.context-engine-graph-index.json`

Allowed optional contents inside `.context-engine-graph/`:
- partitioned edge or symbol files
- sqlite/sqlite-like graph storage
- deterministic shard files
- temporary `.tmp` files used only for atomic replacement

Out of scope for the first rollout:
- remote graph stores
- process-external daemons
- hidden artifacts outside the workspace root
- reuse of legacy branded names for new graph artifacts

### Naming and compatibility rules

- Preferred artifact names must begin with `.context-engine-graph`.
- If future legacy aliases are ever introduced, reads may support them, but writes stay on the preferred names only.
- Graph metadata and payload artifacts must carry an explicit schema/version stamp.
- Artifact names must be independent of branch, hostname, user id, or random process ids.

## Graph Metadata Contract

The graph metadata file is frozen as a versioned JSON envelope with these minimum fields:
- `version`
- `schema_version`
- `graph_engine_version`
- `updated_at`
- `workspace_fingerprint`
- `feature_flags_snapshot`
- `language_matrix`
- `artifact_layout_version`
- `graph_status`
- `symbols_count`
- `edges_count`
- `files_indexed`
- `unsupported_files`
- `degraded_reason`

Field rules:
- `workspace_fingerprint` must use the same path-normalized fingerprinting pattern as `buildIndexStateWorkspaceFingerprint()`.
- `feature_flags_snapshot` must be deterministic and bounded, similar in spirit to retrieval artifact snapshots.
- `language_matrix` is the frozen supported-language list for the build, not a per-file dump.
- `graph_status` must be a bounded enum such as `ready`, `empty`, `degraded`, `stale`, or `rebuild_required`.
- `degraded_reason` must be `null` or a bounded enum; never raw stack traces or free-form upstream payloads.
- Counts must be aggregate integers only.

## Determinism Contract

The graph layer must be replayable on the same workspace and feature-flag snapshot.

Determinism requirements:
- the same workspace contents, supported-language matrix, and feature-flag snapshot produce identical graph metadata except for timestamps
- symbol ids and edge ids must be stable across rebuilds on unchanged files
- file-path normalization must use forward slashes
- traversal order used for persistence must be deterministic
- rebuilds must not depend on nondeterministic directory enumeration order

Allowed nondeterminism:
- `updated_at`
- temporary file names ending in `.tmp`
- internal storage ordering that is not externally surfaced, as long as emitted metadata and query results remain deterministic

## Rebuild and Mismatch Rules

### Rebuild triggers

The graph store must rebuild when any of the following change:
- graph artifact missing
- graph metadata missing
- `schema_version` unsupported or newer than the current implementation
- `graph_engine_version` changes in a way the implementation marks incompatible
- `workspace_fingerprint` mismatch
- supported-language matrix changes
- relevant feature-flag snapshot changes
- source file hash/input changes for graph-supported files

### Mismatch behavior

On mismatch, the first rollout must prefer safe rebuild over partial in-place migration:
- incompatible future schema: ignore old artifact, reset to empty default state, and emit bounded warning/receipt
- corrupted artifact: rebuild from source
- partial artifact family present: treat as degraded and rebuild
- missing graph while other retrieval artifacts exist: continue serving non-graph functionality

No hard startup failure is allowed solely because the graph artifact is missing, stale, or incompatible.

## Cleanup and Rollback Rules

### Cleanup

Allowed cleanup actions:
- delete only `.context-engine-graph/` and `.context-engine-graph-index.json`
- delete only after verifying the resolved path is inside the intended workspace
- clear orphaned `.tmp` files created by graph persistence

Not allowed:
- deleting unrelated retrieval artifacts as part of graph recovery
- deleting `.context-engine-index-state.json`
- deleting `.context-engine-lancedb/` or `.context-engine-lexical-index.sqlite` during graph-specific recovery

### Rollback posture

Rollback for the first rollout is artifact-local:
- if graph writes are bad, remove graph artifacts and continue with heuristic/non-graph behavior
- callers must keep a deterministic fallback reason when graph use is skipped
- rollback must not require reverting symbol/retrieval API contracts that stayed additive

## Supported Language Matrix

The initial supported graph extraction matrix is frozen to the languages already represented in the tree-sitter parser path:
- `typescript`
- `tsx`
- `python`
- `go`
- `rust`
- `java`
- `csharp`

Rules:
- unsupported languages must not create hard failures
- unsupported files may be counted in metadata and reported through bounded degraded/fallback reasons
- graph-backed tool callers must surface that a fallback path was used when a query lands on unsupported material
- language expansion requires a follow-up contract update before persistence behavior changes

## Symbol and Edge Scope Freeze

The first persistent graph must store only bounded, source-derived facts:
- files
- symbols
- definitions
- references
- containment
- imports
- call edges where extraction confidence is sufficient
- extraction confidence and language provenance

Out of scope for the first graph artifact:
- inferred runtime types
- dynamic dispatch resolution beyond bounded heuristics
- cross-repo dependencies
- build-system graphs
- package-manager dependency graphs

## Degraded-Mode Contract

Graph consumers must distinguish these bounded degraded states:
- `graph_unavailable`
- `graph_missing`
- `graph_stale`
- `graph_rebuild_required`
- `graph_unsupported_language`
- `graph_partial`
- `graph_corrupt`

Rules:
- degraded reasons are additive metadata only unless a later task freezes a new response field
- current symbol tools may keep their existing heuristics as fallback
- retrieval may continue without graph expansion
- degraded mode must not silently masquerade as graph-backed success in internal receipts

## Ownership and Write Boundaries

This contract keeps single-writer ownership from the gate pack:
- graph artifact persistence and contracts belong to the graph/index lane
- `src/mcp/serviceClient.ts` remains a protected integration surface and should only receive the minimum adapter changes needed during `T5b`
- graph store implementation should live in new focused graph modules rather than ballooning `serviceClient.ts`

The first implementation should prefer:
- new `src/internal/graph/` or `src/graph/` modules for artifact IO and graph queries
- narrowly scoped touch points in `src/mcp/serviceClient.ts`

## Receipt and Validation Expectations

`T5b` is conformant only if it produces receipts proving:
- graph artifact names and metadata match this contract
- graph build survives process restart
- two rebuilds on unchanged supported files produce equivalent metadata except for timestamps
- unsupported-language inputs degrade cleanly
- corrupted metadata or payload artifacts rebuild safely
- graph-specific cleanup does not delete lexical/vector artifacts
- graph removal restores deterministic fallback behavior

Required proof set:
- deterministic fixture receipt
- restart persistence receipt
- rebuild idempotence receipt
- unsupported-language negative receipt
- corruption-recovery receipt
- rollback/delete receipt

## Test Matrix Freeze

The minimum first-wave graph validation matrix is:

| Scenario | Expected result |
| --- | --- |
| Clean build on supported fixture repo | `graph_status=ready`, stable counts, non-empty symbols/edges |
| Immediate second rebuild with unchanged files | equivalent metadata except `updated_at` |
| Restart after successful build | persisted graph loads without forced rebuild |
| Unsupported-language-only fixture | bounded degraded state, no hard failure |
| Mixed supported + unsupported fixture | supported subset indexed, unsupported files counted |
| Corrupt metadata file | safe reset/rebuild |
| Corrupt graph payload file | safe reset/rebuild |
| Manual graph artifact deletion | fallback behavior until rebuild, no broader retrieval outage |

## Additive Behavior Constraints

Graph work under this contract may:
- add local graph artifacts
- add internal graph modules
- add additive internal metadata/receipts
- improve symbol/retrieval internals behind existing tool names

Graph work under this contract may not:
- rename existing retrieval artifacts
- make graph availability a startup prerequisite
- silently change MCP/HTTP output schemas
- remove heuristic fallback before parity is proven
- broaden supported languages without updating this contract

## Decision Table

| Topic | Frozen decision |
| --- | --- |
| Artifact family | `.context-engine-graph/` plus `.context-engine-graph-index.json` |
| Persistence style | local durable artifact with atomic replacement |
| Metadata style | versioned JSON envelope with workspace fingerprint and bounded degraded state |
| Rebuild policy | prefer safe rebuild over in-place migration on mismatch or corruption |
| Rollback | delete graph artifact family only; keep non-graph retrieval operational |
| Supported languages | `typescript`, `tsx`, `python`, `go`, `rust`, `java`, `csharp` only |
| Unsupported languages | bounded degraded mode, never hard failure |
| Consumer behavior | graph-backed when ready, deterministic fallback when not |
| Existing retrieval artifacts | remain separate and untouched by graph-specific recovery |
