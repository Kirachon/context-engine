# OpenAI MCP Gap Closure Graph Artifact Contract

Purpose: freeze the on-disk graph artifact contract for `T5a` before `T5b` lands any persistent graph writes.

This document is normative for graph persistence work in this program. If implementation needs behavior outside this contract, stop and update this document before writing graph artifacts.

## Scope and Anchors

- Task: `T5a`
- Wave: `Wave 2`
- Owner lane: `F0` docs only
- Downstream consumer tasks blocked on this contract: `T5b`, `T7`, `T8`, `T10a`, `T11b`
- Frozen against:
  - [openai-mcp-gap-closure-ownership-gate-pack.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-ownership-gate-pack.md:1)
  - [openai-mcp-gap-closure-t0-baseline.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-t0-baseline.md:1)
  - [openai-mcp-gap-closure-gap-ledger.md](D:\GitProjects\context-engine\docs\plan-execution\openai-mcp-gap-closure-gap-ledger.md:1)
  - [openai-mcp-gap-closure-swarm-plan.md](D:\GitProjects\context-engine\openai-mcp-gap-closure-swarm-plan.md:115)

## Current Repo Grounding

The graph contract must align with the artifact patterns already frozen elsewhere in the repo.

| Existing surface | Current pattern in repo | Frozen implication for graph artifacts |
| --- | --- | --- |
| Shared index state | [src/mcp/indexStateStore.ts](D:\GitProjects\context-engine\src\mcp\indexStateStore.ts:7) persists `.context-engine-index-state.json` with `schema_version`, `provider_id`, `workspace_fingerprint`, optional `feature_flags_snapshot`, and per-file hashes. Unsupported future `schema_version` resets to empty state. | Graph persistence must treat shared index state as the source of truth for changed-file detection and must fail safe when its schema/workspace/provider snapshot is incompatible. |
| Shared index fingerprint | [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:826) persists `.context-engine-index-fingerprint.json`. | Graph artifacts must stamp the current index fingerprint and treat fingerprint drift as a rebuild trigger. |
| Safe-delete caches | [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:832) and [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:836) mark `.context-engine-search-cache.json` and `.context-engine-context-cache.json` as safe to delete. | Graph artifacts may be safe to delete only if they are fully derived from source plus shared index state. The contract must say so explicitly. |
| Chunk index | [src/internal/retrieval/chunkIndex.ts](D:\GitProjects\context-engine\src\internal\retrieval\chunkIndex.ts:21) uses `.context-engine-chunk-index.json`, `version: 2`, workspace fingerprint, parser snapshot, and chunking config. Incompatibility deletes the stale file instead of reading partial data. | Graph artifacts must prefer delete-and-rebuild over mixed-epoch reads. |
| Lexical index | [src/internal/retrieval/sqliteLexicalIndex.ts](D:\GitProjects\context-engine\src\internal\retrieval\sqliteLexicalIndex.ts:24) uses `.context-engine-lexical-index.sqlite` and the shared index state. | A SQLite-backed graph store is consistent with current persistent index patterns. |
| Dense index | [src/internal/retrieval/denseIndex.ts](D:\GitProjects\context-engine\src\internal\retrieval\denseIndex.ts:20) uses `.context-engine-dense-index.json` with `version`, embedding metadata, and document hashes. | Graph sidecars must carry versioned metadata outside the primary storage file. |
| Vector index | [src/internal/retrieval/lancedbVectorIndex.ts](D:\GitProjects\context-engine\src\internal\retrieval\lancedbVectorIndex.ts:25) uses `.context-engine-lancedb/` plus `.context-engine-lancedb-index.json`; corrupt sidecars are removed on destructive recovery. | Graph recovery may delete only graph-owned artifacts; it must not delete shared retrieval state or source files. |
| Embedding reuse cache | [src/internal/handlers/performance.ts](D:\GitProjects\context-engine\src\internal\handlers\performance.ts:48) uses `.context-engine-embedding-cache.json` as a reusable performance cache, not an index. | Graph cleanup must not delete embedding reuse state unless the caller requested a full index clear. |
| Unsupported / skipped files | [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:511) already freezes `ignored_or_unsupported` as an indexing skip reason. | Unsupported graph languages must use the same vocabulary at the graph boundary instead of inventing a second skip taxonomy. |

## Canonical Graph Artifact Family

`T5b` must write exactly this graph family in the workspace root. No alternate filenames, nested graph directory, or `.augment-*` alias is allowed in the first ship.

| Artifact | Status | Purpose | Safe to delete manually | Notes |
| --- | --- | --- | --- | --- |
| `.context-engine-code-graph.sqlite` | Required | Primary persistent graph store for files, symbols, and edges. | Yes | SQLite is frozen as the primary graph storage format for `v1`. |
| `.context-engine-code-graph-index.json` | Required | Versioned metadata sidecar for the SQLite graph store. | Yes, but only together with the `.sqlite` file | The sidecar is the canonical place for version stamps, fingerprints, and per-file graph outcomes. |
| `.context-engine-code-graph.sqlite-wal` | Optional runtime sidecar | SQLite write-ahead log file. | Yes | Must never be treated as an independently valid artifact. |
| `.context-engine-code-graph.sqlite-shm` | Optional runtime sidecar | SQLite shared-memory file. | Yes | Must never be treated as an independently valid artifact. |
| `.context-engine-code-graph.sqlite.tmp` | Optional build temp | Temporary rebuild target. | Yes | Temporary artifacts must use `.tmp` and must not be considered loadable graph state. |
| `.context-engine-code-graph-index.json.tmp` | Optional build temp | Temporary metadata sidecar write. | Yes | Same cleanup rule as above. |

Frozen naming rules:
- The preferred prefix is `.context-engine-`.
- The graph family uses `code-graph` in filenames, not `graph-store`, `call-graph`, `symbols`, or `edges`.
- There is no legacy `.augment-*` graph alias reserved in `T5a`.
- Graph artifacts live at workspace root, matching current retrieval/index/cache artifact placement.

## Graph Sidecar Schema

The sidecar at `.context-engine-code-graph-index.json` is the contract anchor for persistence compatibility. `T5b` may add fields, but it may not remove or rename the fields below without a new contract update.

```json
{
  "version": 1,
  "graph_schema_version": 1,
  "provider_id": "local_native",
  "updated_at": "2026-04-23T00:00:00.000Z",
  "workspace_fingerprint": "16-char hex",
  "index_fingerprint": "sha256 or equivalent current index fingerprint",
  "feature_flags_snapshot": "serialized snapshot string",
  "extractor": {
    "id": "tree-sitter-graph",
    "version": 1,
    "parser_family": "tree-sitter",
    "tree_sitter_parser_version": 1
  },
  "language_matrix_version": 1,
  "stats": {
    "file_count": 0,
    "symbol_count": 0,
    "edge_count": 0,
    "unsupported_file_count": 0,
    "parse_error_count": 0
  },
  "files": {
    "src/example.ts": {
      "hash": "sha256",
      "indexed_at": "2026-04-23T00:00:00.000Z",
      "language": "typescript",
      "graph_outcome": "full"
    }
  }
}
```

Frozen field semantics:
- `version`: sidecar envelope version. Starts at `1`.
- `graph_schema_version`: SQLite schema version. Starts at `1`.
- `provider_id`: must match the active retrieval provider id. `T5a` freezes `local_native` as the required initial value.
- `workspace_fingerprint`: must be built with the same workspace fingerprint logic used by [src/mcp/indexStateStore.ts](D:\GitProjects\context-engine\src\mcp\indexStateStore.ts:14).
- `index_fingerprint`: must match the active `.context-engine-index-fingerprint.json` value when the graph was last brought current.
- `feature_flags_snapshot`: must be the exact snapshot string used to validate shared index-state compatibility in [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:1908).
- `extractor.id`: frozen to `tree-sitter-graph` for the first ship even if implementation is split across modules.
- `extractor.version`: semantic extractor contract version, not the same field as SQLite schema version.
- `language_matrix_version`: initial supported-language matrix version. Starts at `1`.
- `files[*].graph_outcome`: frozen enum for `v1` is `full | ignored_or_unsupported | parse_error | skipped`.

## Stable Key Contract

`T5b` must emit deterministic file and symbol identities so rebuild and receipt comparisons do not depend on row order or SQLite internals.

- File key: normalized workspace-relative path using `/` separators.
- Symbol key: `<file>#<kind>#<name>#L<start>-L<end>`.
- Edge key: `<edge_type>#<from_symbol_key>#<to_symbol_key_or_external_ref>`.
- Line numbers are 1-based and inclusive.
- Keys must be stable across process restarts and independent of insertion order.

## Supported-Language Matrix

The graph-supported language matrix is frozen to what the current tree-sitter retrieval parser already supports in [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:12).

| Graph language | Accepted file extensions | Current repo grounding |
| --- | --- | --- |
| `typescript` | `.ts`, `.cts`, `.mts` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:154) |
| `tsx` | `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:155) |
| `python` | `.py` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:156) |
| `go` | `.go` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:157) |
| `rust` | `.rs` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:158) |
| `java` | `.java` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:159) |
| `csharp` | `.cs` | [src/internal/retrieval/treeSitterChunkParser.ts](D:\GitProjects\context-engine\src\internal\retrieval\treeSitterChunkParser.ts:160) |

Rules:
- Files outside this matrix must record `graph_outcome=ignored_or_unsupported` in the graph sidecar and must not produce symbol or edge rows.
- Files inside this matrix whose grammar is unavailable at runtime must also record `graph_outcome=ignored_or_unsupported`, not partial output.
- Files inside this matrix whose parse or extraction fails must record `graph_outcome=parse_error` and must not emit partial symbol or edge rows.
- `ignored_or_unsupported` files remain eligible for lexical/vector/dense retrieval according to the existing retrieval stack; graph unsupported does not mean retrieval unsupported.

## Rebuild Triggers

### Full rebuild required

`T5b` must discard the current graph family and rebuild from source when any of the following is true:

- `.context-engine-code-graph.sqlite` is missing.
- `.context-engine-code-graph-index.json` is missing.
- `version != 1`.
- `graph_schema_version != 1`.
- `provider_id` does not match the active retrieval provider id.
- `workspace_fingerprint` does not match the active workspace fingerprint.
- `feature_flags_snapshot` does not match the active snapshot string.
- `extractor.id`, `extractor.version`, or `language_matrix_version` changes.
- The shared index state was reset because of unsupported schema, provider mismatch, or incompatible workspace/feature-flags snapshot, per [src/mcp/indexStateStore.ts](D:\GitProjects\context-engine\src\mcp\indexStateStore.ts:102) and [src/mcp/serviceClient.ts](D:\GitProjects\context-engine\src\mcp\serviceClient.ts:1900).
- The SQLite file or graph sidecar is corrupt, unreadable, or internally inconsistent.

### Incremental refresh allowed

Incremental graph refresh is allowed only when all full-rebuild stamps still match and one of the following is true:

- The shared `.context-engine-index-state.json` file hashes changed for one or more files.
- The current `.context-engine-index-fingerprint.json` differs from the graph sidecar fingerprint.
- A file moved from `ignored_or_unsupported` to supported because its extension changed into the frozen matrix.
- A previously supported file disappeared and its graph rows need removal.

## Mismatch and Load Behavior

Graph loading is fail-safe, not best-effort:

- On any full-rebuild mismatch, the runtime must not serve mixed old/new graph data.
- On a graph load failure, graph-backed consumers must degrade deterministically to current non-graph behavior and surface a fallback reason.
- The runtime may attempt one non-destructive reopen of the SQLite graph in the same request.
- If recovery requires deletion, only the graph family may be removed: `.context-engine-code-graph.sqlite`, `.context-engine-code-graph-index.json`, `.sqlite-wal`, `.sqlite-shm`, and `.tmp` siblings.
- Deleting graph artifacts must not delete:
  - `.context-engine-index-state.json`
  - `.context-engine-index-fingerprint.json`
  - `.context-engine-search-cache.json`
  - `.context-engine-context-cache.json`
  - `.context-engine-embedding-cache.json`
  - lexical, dense, chunk, or LanceDB retrieval artifacts

## Write and Cleanup Rules

Write rules:
- Rebuilds must stage writes through temp files and use atomic replace semantics for the sidecar, matching the repo’s current JSON write pattern.
- The sidecar must not be written before the SQLite graph is queryable.
- A successful rebuild must leave either the old complete graph family or the new complete graph family, never a half-written mix.

Cleanup rules:
- Manual deletion of the graph family is a supported rollback and recovery action because the graph is a derived artifact.
- Future `clearIndex()` behavior must delete the entire graph family in the same pass as other derived retrieval artifacts.
- Future `reindex_workspace` with force semantics must also delete the graph family before rebuilding.
- Normal `indexWorkspace` and `indexFiles` paths must not delete unrelated caches or retrieval artifacts.

## Rollback Posture

Rollback must be cheap and deterministic:

- `T5b` must ship behind a dedicated feature flag named `CE_RETRIEVAL_GRAPH_V1`, default `false`.
- When `CE_RETRIEVAL_GRAPH_V1=false`, graph reads and writes are disabled and the runtime remains on the current heuristic / retrieval behavior.
- If a graph-backed regression is detected after enablement, rollback order is:
  1. Set `CE_RETRIEVAL_GRAPH_V1=false`.
  2. Restart the process.
  3. If needed, delete the graph family files.
- Graph absence must never block startup.
- Graph absence must never block indexing of non-graph retrieval artifacts.
- There is no migration contract from an older experimental graph file. Any pre-contract scratch artifact must be ignored and deleted manually.

## Determinism Receipt Contract

Raw SQLite bytes are not the determinism receipt because SQLite page layout, WAL state, and vacuum behavior can vary. Determinism is proven from a normalized export plus the sidecar.

Required receipt fields for future graph evidence:

| Field | Requirement |
| --- | --- |
| `timestamp_utc` | UTC ISO-8601 timestamp |
| `commit_sha` | Full commit SHA |
| `workspace_fingerprint` | Must match the sidecar and current workspace |
| `index_fingerprint` | Must match the sidecar and current index fingerprint |
| `provider_id` | Must be `local_native` for `v1` |
| `artifact_version` | Sidecar `version` |
| `graph_schema_version` | Sidecar `graph_schema_version` |
| `extractor_id` / `extractor_version` | Must match the sidecar |
| `language_matrix_version` | Must match the sidecar |
| `feature_flags_snapshot` | Exact snapshot string used for the build |
| `supported_file_count` | Count of files with `graph_outcome=full` |
| `unsupported_file_count` | Count of files with `graph_outcome=ignored_or_unsupported` |
| `parse_error_count` | Count of files with `graph_outcome=parse_error` |
| `symbol_count` / `edge_count` | Global counts from normalized export |
| `normalized_export_sha256` | SHA-256 over ordered JSON export of files, symbols, and edges |
| `unsupported_files_sha256` | SHA-256 over ordered JSON export of unsupported/parse-error file outcomes |
| `artifact_paths` | Paths to the `.sqlite` and `.json` graph files |

Normalized export rules:
- Export rows must be sorted by file key, then symbol key, then edge key.
- Receipt hashing must use normalized line endings before hashing, matching the repo’s existing optional EOL normalization pattern in [src/mcp/indexStateStore.ts](D:\GitProjects\context-engine\src\mcp\indexStateStore.ts:19).
- The receipt must not hash raw `.sqlite` bytes as the pass/fail determinism signal.

## Implementation Stop Conditions

Implementation must stop and return to docs/planning if any of these occur during `T5b`:

- A second graph filename family is proposed.
- The implementation needs a non-SQLite primary graph store for `v1`.
- Graph consumers need to read partial graph data after mismatch.
- Unsupported-language behavior cannot be expressed with `ignored_or_unsupported` and `parse_error`.
- Graph rollout cannot be gated independently from existing retrieval flags.

## T5a Completion Standard

`T5a` is complete only when:

- This contract exists under `docs/plan-execution/`.
- The contract freezes canonical graph artifact names, version stamps, language matrix, rebuild triggers, mismatch behavior, cleanup rules, rollback posture, and determinism receipt requirements.
- The contract is grounded in the repo’s current index/cache/retrieval behavior rather than an abstract future design.
- `T5b` can implement persistent graph writes without reopening storage naming or compatibility semantics.
