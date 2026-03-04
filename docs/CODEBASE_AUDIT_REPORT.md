# Codebase Audit Report (Performance + Correctness)

Target: `context-engine-mcp-server` (MCP server + VS Code extension)

Constraints followed:
- Open-source only
- Kept the legacy retrieval SDK bridge and `@modelcontextprotocol/sdk` for MCP
- No breaking changes to MCP tool names/args/outputs

## Executive Summary (Top 3)

1) **Background indexing produced a “fresh on disk, stale in memory” index**
   - Impact: After `indexWorkspaceInBackground()` completes, subsequent `semanticSearch()` / `searchAndAsk()` could still use an older in-memory `DirectContext`.
   - Location: `src/mcp/serviceClient.ts` → `indexWorkspaceInBackground()`
   - Fix applied: After worker completion, reset `context`/`initPromise` and reload state before resolving.

2) **Watcher flushes could overlap, causing concurrent incremental indexing**
   - Impact: Multiple `flush()` calls could run concurrently under load, leading to out-of-order batches and concurrent SDK writes (`addToIndex`) from overlapping `onBatch` invocations.
   - Location: `src/watcher/FileWatcher.ts` → `scheduleFlush()` / `flush()`
   - Fix applied: Serialize flushes and ensure pending changes are flushed on shutdown.

3) **Initialization auto-indexing could deadlock with serialized indexing**
   - Impact: SDK initialization (`doInitialize`) can auto-index when no state exists. With indexing serialization, calling `indexWorkspace()` while initializing could deadlock or double-index.
   - Location: `src/mcp/serviceClient.ts` → `ensureInitialized()` / `doInitialize()` / `indexWorkspace()`
   - Fix applied: `ensureInitialized({ skipAutoIndex: true })` for explicit indexing operations (`indexWorkspace`, `indexFiles`), and `doInitialize` respects `skipAutoIndex`.

## Fixes Implemented (Safe, Backward-Compatible)

- `src/mcp/serviceClient.ts`
  - Added serialized indexing chain to prevent concurrent `addToIndex` operations from watcher/manual calls.
  - Fixed `indexWorkspace()` batch failure accounting (don’t count whole batch as failed if per-file retries succeed).
  - Reload in-memory context after background indexing worker finishes.
  - Make initialization retryable by clearing `initPromise` after completion/failure.
  - Added env-controlled tuning/logging:
    - `CE_INDEX_BATCH_SIZE` (default 10)
    - `CE_DEBUG_INDEX` / `CE_DEBUG_SEARCH`
  - Reduced per-file discovery logs unless `CE_DEBUG_INDEX=true` (big win for large workspaces and tests).

- `src/watcher/FileWatcher.ts`
  - Prevent overlapping flush runs (`flushInFlight` + `flushQueued`).
  - Flush pending changes on `stop()` to avoid dropping events during shutdown.

- `src/mcp/server.ts`
  - Advertise tool list changes capability: `capabilities.tools.listChanged = true`

## Remaining Findings / Recommendations

### High impact (should do next)

1) **Event loop blocking during indexing**
   - Symptom: Indexing does synchronous FS traversal (`fs.readdirSync`, `fs.statSync`, `fs.readFileSync`) in `src/mcp/serviceClient.ts` (`discoverFiles`, `readFileContents`), which can stall tool responsiveness on large repos.
   - Recommendation:
     - Move discovery + reading into the existing worker path (or use async FS + concurrency limits).
     - Keep `DirectContext.addToIndex` calls serialized in the main thread (or one worker) to avoid SDK concurrency hazards.

2) **HTTP transport alignment**
   - Current: `src/http/httpServer.ts` exposes REST-ish endpoints for the VS Code extension.
   - Recommendation:
     - If you want true MCP-over-HTTP, add an opt-in MCP endpoint using `StreamableHTTPServerTransport` and MCP JSON-RPC semantics (`tools/list`, `tools/call`), and close transport on disconnect.
     - Keep existing REST routes for backward compatibility.

3) **Deletions and renames**
   - Current: watcher ignores `unlink` in `src/mcp/server.ts` watcher hook; index may retain stale content for deleted files until a full reindex.
   - Recommendation:
     - If SDK supports delete/remove APIs, use them.
     - Otherwise, detect large delete bursts and trigger a scheduled full reindex (opt-in).

### Medium impact (good ROI)

1) **Logging volume + sensitive output**
   - Gate any “raw results preview” and verbose indexing logs behind env flags (now partially done).
   - Consider adding structured metrics (search latency, indexing throughput, queue depth) behind `CE_METRICS=true`.

2) **Index batch sizing**
   - `CE_INDEX_BATCH_SIZE` now exists. Add guidance on tuning (e.g., 25/50 for speed; 10 for lower memory).

### Low impact (nice to have)

1) **MCP server ergonomics**
   - Evaluate migrating from low-level `Server` handlers to higher-level `McpServer` registration APIs for easier schema validation and less boilerplate (only if it stays compatible with current tool schemas/outputs).

## Benchmarks to Add

Add an opt-in benchmark script (or Jest perf harness kept out of CI) that measures:
- Indexing throughput: files/sec for 1k / 10k / 50k file workspaces
- Search latency: p50/p95 for `semanticSearch` at `top_k = 5/10/20`
- Memory: peak RSS during indexing; steady-state RSS after idle
- Watcher churn: time to settle after mass changes (git checkout/rebase) and number of incremental index calls

Suggested measurement primitives:
- `perf_hooks.performance.now()` timers around: `discoverFiles`, `addToIndex`, `search`, `searchAndAsk`
- Heap snapshots / `process.memoryUsage()` sampling around indexing

## Validation

- All Jest tests pass (`npm test`).
