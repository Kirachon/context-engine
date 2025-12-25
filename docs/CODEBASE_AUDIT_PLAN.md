# Codebase Audit Plan (No Code Changes)

This document is an **analysis-first** audit plan for `D:\GitProjects\context-engine`. It identifies the most likely **breakpoints** (things that can crash/hang or behave incorrectly) and the biggest **slowdowns** (things that waste CPU, memory, or time), and then proposes a **phased plan** to address them.  

Scope note: this plan focuses on the **running server** (`src/`), not the build output (`dist/`).

---

## 1) Executive Summary (Plain English)

### What is most likely making it slow?
1. **Indexing does a lot of work in the main Node.js thread** and uses **sync filesystem calls** and **huge logging**, which can make the server feel “frozen” during indexing.
2. **Indexing loads all file contents into memory** before sending them to the indexer, which can spike memory and cause slowdowns or crashes on big repos.
3. “Background indexing” exists, but the **HTTP background indexing path doesn’t use it**, so HTTP clients may still trigger heavy work in the main thread.

### What is most likely breaking it?
1. **Diff parsing has a correctness gap** (line-number tracking is simplified) that can produce incorrect “changed lines” data and misleading review output.
2. **Reactive review sessions** store in-memory state without clear cleanup/eviction, which can become a slow “memory leak” over time for long-running servers.
3. Any environment/config mismatch (offline-only vs remote API URL, missing token, corrupted state file) can put the server into an “error” status and block key flows.

---

## 2) Findings (Actionable, Evidence-Based)

Severity scale:
- **P0** = can crash/hang, or breaks major functionality
- **P1** = serious performance issue or recurring failure risk
- **P2** = quality/maintainability issue that can become P0/P1 later

### P0 — Can break correctness or reliability

#### P0-1: Diff parsing line numbers are “simplified” and likely wrong for many diffs
- **Symptom:** Code review output may point to the wrong lines, or “changed_lines_only” filtering may behave incorrectly (misses real changes or flags wrong ones).
- **Evidence:** `src/mcp/services/codeReviewService.ts` → `parseHunkLines()` sets `oldLineNum = newStart; // Simplified - would need proper tracking`.
- **Why it happens (hypothesis):** Unified diff has separate old/new line counters. Using `newStart` for both will be wrong for deletions/context lines.
- **How to confirm (no code changes):**
  - Take a real unified diff that includes deletions + adds.
  - Run the existing review tool (`review_changes`) and compare line numbers to the diff hunks manually.
  - Also compare `changed_lines_only=true` behavior vs expected changed lines.

#### P0-2: Indexing can cause memory spikes (reads all file contents into a single in-memory array)
- **Symptom:** Process RSS grows fast during indexing; possible out-of-memory crash or OS kill on large workspaces.
- **Evidence:** `src/mcp/serviceClient.ts` → `indexWorkspace()` builds `files: Array<{ path; contents }>` by reading **every file** and holding contents in memory before `addToIndex()` batching.
- **Why it happens (hypothesis):** Reading/holding N file contents at once scales poorly with large file counts.
- **How to confirm (no code changes):**
  - Run indexing on a large workspace and monitor memory:
    - Windows: Task Manager “Memory” for the Node process.
    - Node: run with `--trace-gc` or `--inspect` (optional) and observe heap growth.
  - Compare memory before indexing vs peak during indexing.

### P1 — Big performance bottlenecks / high operational risk

#### P1-1: Indexing logs every discovered file path (and batch contents lengths); logging can dominate runtime
- **Symptom:** Indexing is slow even when CPU isn’t maxed; huge console output; slow terminals; possible log storage issues in production.
- **Evidence:** `src/mcp/serviceClient.ts` → `indexWorkspace()`:
  - Logs “Files to index:” then prints every path.
  - Logs each batch’s files and their content length.
  - Logs per-excluded-directory and per-ignored-path in discovery.
- **Why it happens (hypothesis):** Console I/O is slow; large logs block the event loop and inflate runtime.
- **How to confirm (no code changes):**
  - Run `node dist/index.js --workspace <repo> --index` and measure elapsed time.
  - Compare with stderr redirected to file vs printed to terminal; large differences indicate logging overhead.

#### P1-2: “Background indexing” is implemented, but the HTTP endpoint’s background mode does not use the worker
- **Symptom:** Calling HTTP indexing with `{ background: true }` still causes the server process to work heavily and feel slow/unresponsive.
- **Evidence:** `src/http/routes/tools.ts`:
  - When `background` is true it calls `serviceClient.indexWorkspace().catch(...)` (same-thread work).
  - Worker-based indexing exists as `ContextServiceClient.indexWorkspaceInBackground()` and is used by the MCP tool `index_workspace` (`src/mcp/tools/index.ts`).
- **Why it happens (hypothesis):** HTTP background path was implemented earlier and never updated to use the worker path.
- **How to confirm (no code changes):**
  - Start server in HTTP mode.
  - Call `POST /api/v1/index { "background": true }` and watch CPU/memory/log spam. If it spikes immediately, it’s not truly background.

#### P1-3: Indexing and file operations use synchronous filesystem APIs in recursive loops
- **Symptom:** The server becomes “stuttery” or unresponsive while indexing or reading many files.
- **Evidence:** `src/mcp/serviceClient.ts`:
  - `discoverFiles()` uses `fs.readdirSync(...)` recursively.
  - `readFileContents()` uses `fs.statSync(...)` and `fs.readFileSync(...)`.
- **Why it happens (hypothesis):** Sync I/O blocks Node’s single event loop thread.
- **How to confirm (no code changes):**
  - Trigger indexing while also sending another request (e.g., `GET /api/v1/status` repeatedly).
  - If status requests stall while indexing runs, the event loop is blocked.

#### P1-4: Reactive review sessions hold state in memory without clear cleanup (potential long-run slowdown)
- **Symptom:** Long-running server gradually uses more memory and slows down after many reactive reviews.
- **Evidence:** `src/reactive/ReactiveReviewService.ts` stores multiple Maps (`sessions`, `sessionPlans`, `sessionFindings`, etc.) and does not show explicit eviction/cleanup on completion.
- **Why it happens (hypothesis):** Completed/failed sessions remain referenced forever.
- **How to confirm (no code changes):**
  - Run many reactive review sessions and observe heap growth over time.
  - Check whether completed sessions are ever removed from in-memory maps (runtime inspection/logging only).

### P2 — Maintainability / “death by a thousand cuts”

#### P2-1: Plan persistence uses sync disk writes in “async” methods
- **Symptom:** Save/load operations can block briefly, especially on slow disks or large plan files.
- **Evidence:** `src/mcp/services/planPersistenceService.ts` uses `fs.writeFileSync` / `fs.readFileSync` inside `async` functions.
- **Why it happens (hypothesis):** Sync disk I/O blocks the event loop.
- **How to confirm (no code changes):**
  - Save/load plans while running other endpoints and watch for latency spikes.

#### P2-2: Internal cache hooks exist but appear disabled by default
- **Symptom:** Internal “bundle” helpers do repeated work even for repeated queries (if those helpers are used in a tight loop).
- **Evidence:** `src/internal/handlers/performance.ts` defaults to a disabled cache; `src/internal/handlers/context.ts` and `src/internal/handlers/retrieval.ts` call `getInternalCache()`.
- **How to confirm (no code changes):**
  - Trace whether internal handlers are used in production paths and whether `setInternalCache()` is ever called.

---

## 3) Bottleneck Map (Top Suspected Slow Paths)

1. **Workspace indexing path**
   - `ContextServiceClient.indexWorkspace()` → `discoverFiles()` → `readFileContents()` → `DirectContext.addToIndex()`
   - Suspected costs: sync FS recursion, reading many files, building an in-memory mega-array, verbose logging.

2. **Incremental indexing (watcher path)**
   - `FileWatcher` batches changes → `ContextServiceClient.indexFiles()`
   - Suspected costs: sync file reads per changed file, repeated indexing calls, no “ignored” defaults passed to watcher.

3. **LLM calls serialized by design**
   - `ContextServiceClient.searchAndAsk()` uses a queue to serialize calls.
   - This protects against SDK concurrency issues but caps throughput under concurrent clients.

4. **Large diff review parsing**
   - `CodeReviewService.parseDiff()` / `parseHunkLines()` over large diffs can be CPU-heavy and correctness-sensitive.

5. **Log volume as a hidden bottleneck**
   - Many hot paths log to `console.error` with high frequency (indexing, searching).
   - Logging can become the dominant cost in real usage.

---

## 4) Prioritized Action Plan (Phased, Still No Coding Here)

### Phase 0 — Safety & Triage (stop “breaks” first)
Goal: remove correctness traps and crash risks before optimizing.

1. Validate diff parsing correctness
   - Confirm P0-1 with 3 real diffs (adds, deletes, renames, mixed hunks).
   - Define acceptance criteria: line numbers and changed-lines filtering match the diff.

2. Measure and cap indexing memory usage
   - Measure peak memory on a large repo.
   - Define acceptance criteria: indexing does not exceed a target RSS/heap (set realistic target per typical workspace size).

3. Establish reproducible measurements
   - Capture baseline metrics (index time, search time, plan time, review time, memory peak).
   - Store results in a simple markdown table (date, machine, repo size).

### Phase 1 — Quick Wins (high impact / low risk)
Goal: reduce “obvious waste” without changing core behavior.

1. Logging audit
   - Identify the top log sources by volume (indexing “Files to index”, per-file logs, etc.).
   - Decide what becomes debug-only vs always-on.

2. Make HTTP background indexing truly background (by using the worker path)
   - Align HTTP `/index` background behavior with MCP `index_workspace background=true`.

3. Event loop blocking audit
   - Identify sync FS usage on hot paths and quantify impact.

### Phase 2 — Deeper Refactors (bigger changes, bigger payoff)
Goal: fundamentally reduce CPU/memory overhead under real workloads.

1. Stream indexing instead of buffering entire workspace
   - Avoid holding all contents at once; push to `addToIndex` progressively.

2. Replace sync FS with async where it matters
   - Especially in discovery and file reads during indexing.

3. Add session cleanup / TTL for reactive review in-memory state
   - Prevent long-running memory accumulation.

4. Revisit throughput limits of serialized AI calls
   - Keep safety, but consider safe parallelism if the SDK supports it (or isolate calls per worker).

---

## 5) Implementation Strategy (How to Do This Without Breaking Things)

Rules:
1. Change one “hot path” at a time and re-measure after each change.
2. Keep feature flags for risky behavior changes (especially indexing and concurrency).
3. Prefer backward-compatible improvements (same APIs, better internals).

Suggested order:
1. Fix correctness issues (diff parsing)
2. Remove “waste” (log volume, HTTP background indexing)
3. Address architectural scaling issues (streaming indexing, async FS, session cleanup)

---

## 6) Success Metrics (How We Know It’s Better)

Minimum metrics to track before/after each phase:
- **Indexing time**: P50 and P95 on representative workspaces.
- **Peak memory during indexing**: RSS + heap peak.
- **Tool latency under load**: concurrent requests (especially HTTP).
- **Server responsiveness during indexing**: can `/status` respond within a small bound.
- **Correctness**: diff review line references match unified diff hunks.

---

## 7) Additional Findings (2025-12-25 Audit)

The following additional issues were discovered during a comprehensive codebase analysis:

### NEW P0 — Critical Issues

#### P0-3: ReactiveReviewService has unbounded session maps without cleanup
- **Symptom:** Long-running servers accumulate memory indefinitely as sessions complete or fail.
- **Evidence:** `src/reactive/ReactiveReviewService.ts` lines 63-77:
  - `sessions: Map<string, ReviewSession>` - never cleaned up
  - `sessionPlans: Map<string, EnhancedPlanOutput>` - never cleaned up
  - `sessionFindings: Map<string, number>` - never cleaned up
  - `sessionStartTimes: Map<string, number>` - never cleaned up
  - `sessionTokensUsed: Map<string, number>` - never cleaned up
- **Why it happens:** No session cleanup, eviction, or TTL mechanism exists.
- **Impact:** Memory leak proportional to number of review sessions created.
- **How to confirm:** Run multiple reactive reviews and observe heap growth via `--inspect`.

#### P0-4: ExecutionTrackingService accumulates execution state indefinitely
- **Symptom:** `executionStates` Map grows without bound as plans are executed.
- **Evidence:** `src/mcp/services/executionTrackingService.ts` line 69:
  - `private executionStates: Map<string, PlanExecutionState>` - `removeExecutionState()` exists but is never called automatically
  - `abortedPlans: Set<string>` (line 91) - never cleaned up after execution completes
- **Why it happens:** State is added but never removed when plans complete.
- **Impact:** Memory leak proportional to number of plans executed.

#### P0-5: PlanHistoryService accumulates history without eviction
- **Symptom:** Plan history grows without bound in memory.
- **Evidence:** `src/mcp/services/planHistoryService.ts` line 72:
  - `private histories: Map<string, PlanHistory>` - loaded from disk and cached indefinitely
  - Each `PlanHistory.versions` array grows with each version recorded
- **Why it happens:** No max history size, no eviction, no pruning mechanism.
- **Impact:** Memory leak proportional to plan history size.

### NEW P1 — Performance Issues

#### P1-5: HTTP background indexing doesn't use worker thread
- **Symptom:** HTTP `/index?background=true` still blocks the main event loop.
- **Evidence:** `src/http/routes/tools.ts` lines 77-81:
  ```typescript
  if (background) {
      serviceClient.indexWorkspace().catch((err) => {...});  // Same-thread work!
  }
  ```
- **Why it happens:** Should call `indexWorkspaceInBackground()` instead of `indexWorkspace()`.
- **How to confirm:** Call `POST /api/v1/index { "background": true }` and observe CPU spike in main thread.
- **STATUS:** ✅ FIXED - Now uses `indexWorkspaceInBackground()` worker thread.

#### P1-6: File watcher doesn't respect context ignore patterns
- **Symptom:** Watcher triggers indexing for files that should be ignored.
- **Evidence:** `src/watcher/FileWatcher.ts` - uses `options.ignored` array but doesn't load `.gitignore` or `.contextignore` patterns.
- **Why it happens:** Watcher has its own ignore config that doesn't sync with serviceClient's ignore patterns.
- **Impact:** Unnecessary indexing work for ignored files.

#### P1-7: Duplicate `extractJsonFromResponse` implementations
- **Symptom:** Code duplication with potential for divergent behavior.
- **Evidence:**
  - `src/mcp/prompts/codeReview.ts` lines 278-292
  - `src/mcp/prompts/planning.ts` lines 239-253
- **Why it happens:** Copy-paste during implementation.
- **Impact:** Maintenance burden and potential for bugs if one is updated but not the other.
- **STATUS:** ✅ FIXED - Consolidated to single implementation.

#### P1-8: Search queue doesn't cancel pending requests on shutdown
- **Symptom:** Server shutdown may hang waiting for queued requests.
- **Evidence:** `src/mcp/serviceClient.ts` `SearchQueue` class has `clearPending()` but it's not called during shutdown.
- **Why it happens:** Shutdown handler in `src/mcp/server.ts` doesn't clear the search queue.
- **Impact:** Slow/hung shutdowns when requests are queued.
- **STATUS:** ✅ FIXED - Shutdown now calls `clearPending()`.

### NEW P2 — Maintainability Issues

#### P2-3: Inconsistent timeout values across the codebase
- **Symptom:** Different timeouts for similar operations make debugging difficult.
- **Evidence:**
  - `src/http/routes/tools.ts`: `DEFAULT_TOOL_TIMEOUT_MS = 30000`, `AI_TOOL_TIMEOUT_MS = 120000`
  - `src/mcp/serviceClient.ts`: `DEFAULT_API_TIMEOUT_MS = 120000`
  - `src/reactive/config.ts`: `step_timeout_ms: 60000`
  - `src/internal/retrieval/retrieve.ts`: `timeoutMs` capped at 10000
- **Why it happens:** Different developers added timeouts without coordination.
- **Impact:** Confusing behavior when timeouts trigger.
- **STATUS:** ✅ FIXED - Centralized timeout configuration added.

#### P2-4: Missing null/undefined checks in plan processing
- **Symptom:** Potential crashes when processing malformed plans.
- **Evidence:** Many places now have defensive checks added, but some remain:
  - `src/mcp/services/planHistoryService.ts` `collectAllFiles()` now safely handles undefined arrays
  - `src/mcp/services/executionTrackingService.ts` `initializeExecution()` now safely handles undefined steps
- **Why it happens:** TypeScript types may not reflect runtime reality from LLM responses.
- **STATUS:** ✅ Already partially fixed - defensive checks exist in key places.

#### P2-5: Regex patterns in secretScrubber use global flag incorrectly
- **Symptom:** Potential false negatives when checking for secrets multiple times.
- **Evidence:** `src/reactive/guardrails/secretScrubber.ts` lines 396-402:
  - `hasSecrets()` method resets `lastIndex` before each pattern test
  - This is correct, but the caller must be careful with pattern reuse
- **Why it happens:** JavaScript regex with global flag has stateful `lastIndex`.
- **Impact:** Edge case where secrets might be missed on repeated calls.
- **STATUS:** ✅ Already correctly handled - `lastIndex` is reset.

#### P2-6: Plan persistence uses synchronous file operations
- **Symptom:** Disk I/O blocks event loop during save/load.
- **Evidence:** `src/mcp/services/planPersistenceService.ts`:
  - Line 92: `fs.readFileSync(this.indexPath, 'utf-8')`
  - Line 115: `fs.writeFileSync(this.indexPath, ...)`
  - Line 175: `fs.writeFileSync(metadata.file_path, ...)`
  - Line 217: `fs.readFileSync(metadata.file_path, 'utf-8')`
- **Why it happens:** Async methods marked `async` but use sync I/O.
- **Impact:** Brief event loop blocks on slow disks.
- **STATUS:** ✅ FIXED - Converted to async fs operations.

---

## 8) Implementation Status

### Phase 0 Fixes Applied (Previous Work)

1. ✅ **P1-5: HTTP background indexing** - Now uses worker thread via `indexWorkspaceInBackground()`
2. ✅ **P1-7: Duplicate extractJsonFromResponse** - Consolidated to `src/mcp/utils/jsonParser.ts`
3. ✅ **P1-8: Search queue cleanup on shutdown** - Added `clearSearchQueue()` method and call in shutdown handler
4. ✅ **P2-3: Timeout configuration** - Centralized in `src/mcp/utils/timeoutConfig.ts`
5. ✅ **P2-6: Plan persistence async I/O** - Converted to use `fs/promises`

### Phase 1 Fixes Applied (2025-12-25 Audit)

6. ✅ **P0-3: ReactiveReviewService memory leak** - Added session cleanup with TTL
   - Added `cleanupExpiredSessions()` method with periodic timer (5 min interval)
   - Added `session_ttl_ms` and `max_sessions` config options
   - Sessions in terminal states (completed, failed, cancelled) are cleaned up after TTL
   - LRU eviction when over max_sessions limit
   - Added `stopCleanupTimer()` for graceful shutdown
   - Added `getSessionCount()` for monitoring

7. ✅ **P0-4: ExecutionTrackingService memory leak** - Added automatic state cleanup
   - Added `cleanupExpiredStates()` method with periodic timer (5 min interval)
   - States in terminal status (completed, failed, aborted) are cleaned up after 1 hour TTL
   - Max 100 execution states in memory with LRU eviction
   - Added `stopCleanupTimer()` for graceful shutdown
   - Added `getStateCount()` for monitoring

8. ✅ **P0-5: PlanHistoryService memory leak** - Added max history size and eviction
   - Added LRU eviction for histories map (max 50 histories in memory)
   - Added version pruning (max 20 versions per history)
   - Added `lastAccessTime` tracking for LRU
   - Added `getMemoryStats()` and `clearMemoryCache()` methods

9. ✅ **P1-6: FileWatcher ignore patterns** - Synced with serviceClient patterns
   - Added `getIgnorePatterns()` and `getExcludedDirectories()` methods to serviceClient
   - FileWatcher now loads patterns from .gitignore and .contextignore
   - Patterns converted to chokidar-compatible format

### Phase 2 Fixes Applied (2025-12-25 Audit - Continued)

10. ✅ **P0-1: Diff parsing line numbers** - Fixed proper old/new line tracking
    - Modified `parseHunkLines()` to accept both `oldStart` and `newStart` parameters
    - `oldLineNum` now properly initialized from `oldStart` instead of `newStart`
    - Removed the "Simplified" comment and implemented correct tracking

11. ✅ **P0-2: Indexing memory spikes** - Implemented streaming approach
    - Changed from loading all files into memory to batch-by-batch streaming
    - Files are now read just-in-time for each batch (10 files at a time)
    - Memory from previous batches can be garbage collected before loading new batches
    - Log spam reduced: only first 50 files shown with "... and N more files" summary
    - Added clear logging for skipped files per batch

### All P0 Issues Now Resolved ✅

---

## 9) Appendix: Key Files to Review First

- Indexing + caching: `src/mcp/serviceClient.ts`
- HTTP indexing behavior: `src/http/routes/tools.ts`
- Worker-based indexing: `src/mcp/tools/index.ts`, `src/worker/IndexWorker.ts`
- Diff review parsing: `src/mcp/services/codeReviewService.ts`
- Reactive sessions/state: `src/reactive/ReactiveReviewService.ts`
- Watcher behavior: `src/watcher/FileWatcher.ts`
- Execution tracking: `src/mcp/services/executionTrackingService.ts`
- Plan history: `src/mcp/services/planHistoryService.ts`
- Plan persistence: `src/mcp/services/planPersistenceService.ts`
- Timeout configuration: `src/mcp/utils/timeoutConfig.ts` (new)
- JSON parsing utilities: `src/mcp/utils/jsonParser.ts` (new)

