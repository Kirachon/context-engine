# Changelog

All notable changes to the Context Engine MCP Server will be documented in this file.

## [1.8.0] - 2025-12-25

### 🎉 Overview
Version 1.8.0 represents a **major milestone** in the Context Engine MCP Server, delivering a complete optimization of the reactive code review system. This release achieves **180-600x performance improvements** through a comprehensive 4-phase optimization strategy, along with critical bug fixes and enhanced reliability.

### ✨ New Features
#### 🚀 Phase 1: AI Agent Step Executor
- **Direct AI Analysis**: Replaced slow external API calls with direct AI agent capabilities.
- **Real Findings Generation**: Generates structured code review findings based on step descriptions.
- **Multi-Layer Caching**: Integrated with 3-layer cache (memory, commit, file hash).

#### 💾 Phase 2: Multi-Layer Response Cache
- **3-Layer Architecture**: Memory Cache, Commit Cache, and File Hash Cache.
- **Smart Invalidation**: Automatic cache invalidation on content changes.
- **Telemetry**: Hit rate tracking and performance metrics.

#### 📦 Phase 3: Continuous Batching
- **Batch Processing**: Process multiple files in single AI request.
- **Dynamic Batching**: Configurable batch size (default: 5 files).

#### ⚙️ Phase 4: Worker Pool Optimization
- **CPU-Aware Allocation**: Dynamically sets workers based on CPU cores.
- **Parallel Execution**: Efficient concurrent step processing.

### 🐛 Bug Fixes
- **Progress Tracking**: Fixed session exit before 100% completion in parallel mode.
- **Step Dependency Blocking**: Removed unnecessary step dependencies in review plans to enable true parallel execution.
- **HTTP Server**: Added robust error handling and graceful shutdown for SIGINT/SIGTERM.
- **Dynamic Versioning**: Fixed hardcoded version string in server entry point.

---

## [1.7.1] - 2025-12-25

### Fixed

#### Memory Leak Fixes (P0 Critical)
- **ReactiveReviewService**: Added session cleanup with configurable TTL and LRU eviction
  - Sessions in terminal states cleaned up after TTL expires (default 1 hour)
  - Max 100 sessions with automatic LRU eviction
  - Periodic cleanup timer (5 minute interval)
  - Commit cache now properly cleaned up on errors (try-finally pattern)

- **ExecutionTrackingService**: Added automatic state cleanup
  - Execution states cleaned up with 1 hour TTL for terminal states
  - Max 100 execution states with LRU eviction
  - Timer cleanup in `executeStepWithTimeout` - prevents timer accumulation
  - Orphaned `abortedPlans` entries now cleaned up properly

- **PlanHistoryService**: Added LRU eviction and version pruning
  - Max 50 histories in memory with LRU eviction
  - Max 20 versions per history with automatic pruning
  - Fixed eviction order - `touchHistory()` now called before `evictIfNeeded()`

#### Correctness Fixes
- **Diff Parsing**: Fixed line number initialization in `parseHunkLines()`
  - `oldLineNum` now correctly initialized from `oldStart`
  - Code review line number references are now accurate

#### Performance Improvements
- **Indexing**: Changed `indexWorkspace()` to streaming batch approach
  - Files read just-in-time per batch (10 files at a time)
  - Memory usage now O(batch_size) not O(total_files)
  - Large workspaces can be indexed without memory exhaustion

- **FileWatcher**: Now respects `.gitignore` and `.contextignore` patterns
  - Root-anchored patterns (e.g., `/.env`) now match correctly at workspace root
  - Reduces unnecessary file change events

### New Configuration Options
| Variable | Description | Default |
|----------|-------------|---------|
| `REACTIVE_SESSION_TTL` | Session TTL in milliseconds | 3600000 (1 hour) |
| `REACTIVE_MAX_SESSIONS` | Max sessions in memory | 100 |

### New Methods
- `ReactiveReviewService.cleanupExpiredSessions()` - Manual cleanup trigger
- `ReactiveReviewService.stopCleanupTimer()` - Graceful shutdown
- `ReactiveReviewService.getSessionCount()` - Monitoring
- `ExecutionTrackingService.cleanupExpiredStates()` - Manual cleanup trigger
- `ExecutionTrackingService.stopCleanupTimer()` - Graceful shutdown
- `ExecutionTrackingService.getStateCount()` - Monitoring
- `PlanHistoryService.getMemoryStats()` - Memory usage stats
- `PlanHistoryService.clearMemoryCache()` - Force clear cache
- `ContextServiceClient.getIgnorePatterns()` - Get loaded ignore patterns
- `ContextServiceClient.getExcludedDirectories()` - Get excluded directories

## [1.7.0] - 2024-12-24

### Added

#### AI-Powered Code Review Tools
- **New MCP Tool**: `review_changes` - AI-powered code review with structured output
  - **Structured Output Schema**: Codex-style findings with detailed metadata
  - **Confidence Scoring**: Per-finding confidence scores (0.0-1.0) and overall confidence
  - **Priority Levels**: P0 (critical), P1 (high), P2 (medium), P3 (low) with semantic meaning
  - **Category-Based Analysis**: Correctness, security, performance, maintainability, style, documentation
  - **Changed Lines Filter**: Focus on modified lines to reduce noise (configurable)
  - **Actionable Suggestions**: Each finding includes specific fix recommendations
  - **File Context Support**: Optional full file content for better understanding
  - **Custom Instructions**: Tailor reviews to specific frameworks or coding standards
  - **File Exclusion**: Glob pattern support to skip generated files, tests, etc.

- **New MCP Tool**: `review_git_diff` - Automatic git diff retrieval and review
  - **Staged Changes**: Review changes staged for commit (`git diff --cached`)
  - **Unstaged Changes**: Review working directory modifications
  - **Branch Comparison**: Compare any two branches or commits
  - **Commit Review**: Review specific commit changes
  - **Pattern Filtering**: Include/exclude files by glob patterns
  - **Seamless Integration**: Combines git operations with code review in one call

#### Code Review Infrastructure
- **CodeReviewService**: Core service layer for code review operations
  - Diff parsing (unified diff format)
  - Finding filtering and deduplication
  - Confidence threshold enforcement
  - Changed lines detection and filtering
  - File exclusion pattern matching
  - Review result validation

- **Git Utilities**: Comprehensive git integration
  - `execGitCommand`: Safe git command execution with error handling
  - `getGitStatus`: Repository detection and status checking
  - `getGitDiff`: Flexible diff retrieval (staged, unstaged, branch, commit)
  - `getStagedDiff`, `getUnstagedDiff`, `getCommitDiff`: Convenience functions
  - Diff parsing with addition/deletion counting

- **HTTP API Endpoints**: REST API for code review
  - `POST /api/v1/review-changes` - Review code from diff content
  - `POST /api/v1/review-git-diff` - Review code from git automatically
  - Full HTTP server infrastructure (CORS, error handling, logging)
  - Health check and status endpoints

#### Type Definitions
- **ReviewFinding**: Individual code review finding with metadata
- **ReviewResult**: Complete review output with findings and summary
- **ReviewCategory**: Enum for review categories
- **ReviewPriority**: P0-P3 priority levels
- **ReviewOptions**: Configurable review parameters
- **FileContext**: File content mapping for context

### Testing
- **67 New Unit Tests**: Comprehensive test coverage for code review functionality
  - Diff parsing tests (15 tests)
  - Service layer tests (40 tests)
  - Git utilities tests (12 tests)
- **270 Total Tests**: All tests passing
- **Edge Case Coverage**: Empty diffs, malformed input, null/undefined handling

### Documentation
- **README.md**: Updated with code review tools documentation
- **Tool Manifest**: Added `code_review` capability with feature list
- **Examples**: Code review usage examples (see EXAMPLES.md)

### Performance
- **Timeout Protection**: 120-second timeout for AI review operations
- **Efficient Filtering**: Changed lines filter reduces AI processing overhead
- **Parallel Processing**: HTTP endpoints support concurrent review requests

## [1.6.0] - 2024-12-21

### Added

#### Plan Execution Tool (`execute_plan`)
- **New MCP Tool**: `execute_plan` for AI-powered step-by-step plan execution
  - Three execution modes: `single_step`, `all_ready`, `full_plan`
  - AI-generated code changes with file path, operation type, and content
  - Optional automatic file writing with `apply_changes=true` parameter
  - Configurable step limits and failure handling
  - Progress tracking with completion percentages
  - Next ready steps calculation based on dependency graph

#### File Writing Capabilities
- **`applyGeneratedChanges` function**: Safely applies AI-generated code changes to disk
  - **Security**: Path validation prevents directory traversal attacks
  - **Safety**: Automatic backup creation before overwriting files (`.backup.TIMESTAMP` format)
  - **Convenience**: Parent directories created automatically for new files
  - **Operations**: Supports create, modify, and delete file operations
  - **Reporting**: Detailed tracking of applied files, errors, and backups created

#### API Timeout Protection
- **`withTimeout` helper**: Generic timeout wrapper for async operations
  - Default 120-second timeout for AI API calls
  - Configurable timeout per request
  - Descriptive error messages on timeout
  - Queue cleanup support via `clearPending` method

### Performance

#### Parallel Step Execution
- **`all_ready` mode optimization**: Independent steps execute in parallel
  - Uses `Promise.all` for concurrent step execution
  - Results sorted by step number for consistent output
  - Graceful error handling - failed steps don't crash the batch
  - Falls back to sequential execution for `single_step` and `full_plan` modes
  - **Estimated improvement**: 2-5x faster for plans with multiple independent steps

#### Service Instance Reuse
- **Lazy singleton pattern** for `PlanningService`
  - Cached service instance reused across requests
  - Uses `WeakRef` for safe memory management
  - Automatic recreation if `serviceClient` changes
  - Reduces memory allocation and initialization overhead

### Changed

#### Type Definitions
- **`ExecutePlanResult` interface** extended with file operation tracking:
  - `files_applied`: Number of files successfully written to disk
  - `apply_errors`: Array of error messages from file operations
  - `backups_created`: Array of backup file paths created

#### Service Client
- **`SearchQueue` class** enhanced with timeout support:
  - `enqueue` method accepts optional `timeoutMs` parameter
  - `clearPending` method for queue cleanup
  - Better error handling for timeout scenarios

### Fixed

#### Critical Bug Fixes
1. **File Writing**: `execute_plan` now properly writes generated code to disk when `apply_changes=true`
   - Previously, generated code was only returned in the response
   - Now creates/modifies/deletes files as specified in the plan

2. **API Timeouts**: AI API calls no longer hang indefinitely
   - Added 120-second default timeout for `searchAndAsk` operations
   - Prevents tool timeout errors in MCP clients
   - Provides clear error messages when timeouts occur

### Tests

- **All 222 tests passing** (no new test failures)
- Existing test suite validates backward compatibility
- TypeScript compilation passes with no errors

### Backward Compatibility

- **No breaking changes**: All existing MCP tool APIs remain unchanged
- `apply_changes=false` (default) preserves preview-only behavior
- Sequential execution still works for `single_step` and `full_plan` modes
- All response formats backward compatible (only additions)

### Security

- **Path validation**: Prevents writes outside workspace directory
- **Backup creation**: Automatic backups before overwriting files
- **Error isolation**: File operation errors don't crash the entire execution

## [1.5.0] - 2025-12-19

### Added

#### Layer 2.5: Internal Shared Handlers (Phase 2)
- **New Architecture Layer**: `src/internal/handlers/` for shared internal logic
  - `retrieval.ts` - Shared retrieval wrapper with timing and caching hooks
  - `context.ts` - Context bundle and snippet assembly helpers
  - `enhancement.ts` - AI prompt enhancement logic (extracted from enhance.ts)
  - `utilities.ts` - Shared file and index status helpers
  - `performance.ts` - Disabled-by-default performance hooks (cache/batching/embedding reuse)
  - `types.ts` - Shared handler type definitions

- **Advanced Retrieval Features**: `src/internal/retrieval/` for enhanced retrieval pipeline
  - `retrieve.ts` - Core retrieval orchestration
  - `dedupe.ts` - Result deduplication logic
  - `expandQuery.ts` - Query expansion for better recall
  - `rerank.ts` - Result re-ranking for improved relevance
  - `types.ts` - Retrieval type definitions

#### Snapshot Testing Infrastructure
- **Snapshot Harness**: `tests/snapshots/snapshot-harness.ts`
  - Byte-for-byte regression testing for MCP tool outputs
  - 22 baseline snapshots covering core tools and error cases
  - Supports baseline creation (`--update`) and verification modes
  - Test workspace with sample files and memories

- **Test Inputs**: `tests/snapshots/test-inputs.ts`
  - Comprehensive test cases for codebase_retrieval, semantic_search, get_context_for_prompt
  - Error validation tests for edge cases
  - Tool manifest and visualization tests

#### Development Tools
- **Tool Inventory Generator**: `scripts/extract-tool-inventory.ts`
  - Automated extraction of all 28 MCP tools from source code
  - Generates comprehensive tool documentation table
  - Outputs to `docs/PHASE2_TOOL_INVENTORY.md`

### Changed

#### Code Consolidation
- **Refactored MCP Tools** to use internal handlers (no output changes):
  - `codebase_retrieval` - Now uses `internalRetrieveCode()` and `internalIndexStatus()`
  - `semantic_search` - Now uses `internalRetrieveCode()`
  - `get_context_for_prompt` - Now uses `internalContextBundle()`
  - `enhance_prompt` - Now uses `internalPromptEnhancer()` (~100 lines of duplicate code removed)

#### Configuration
- **Test Configuration**: Added `tsconfig.test.json` for test-specific TypeScript settings
  - ES2022 module system for Jest compatibility
  - Separate from production TypeScript configuration

- **Jest Configuration**: Updated `jest.config.js`
  - Uses `tsconfig.test.json` for test compilation
  - Suppresses diagnostic warnings (codes 1343, 1378)

- **Git Ignore**: Updated `.gitignore`
  - Excludes `.augment-plans/` (runtime plan storage)
  - Excludes `plan/` (personal planning notes)

### Documentation

#### New Documents
1. **docs/PHASE2_SAFE_TOOL_CONSOLIDATION_PLAN.md**
   - Phase 2 implementation strategy and goals
   - Non-negotiables (preserve all MCP contracts)
   - Validation checklist and rollback plan

2. **docs/PHASE2_TOOL_INVENTORY.md**
   - Complete inventory of all 28 MCP tools
   - Tool names, handlers, file locations, and schemas
   - Generated automatically from source code

#### Updated Documents
1. **ARCHITECTURE.md**
   - Added Layer 2.5 documentation with responsibilities and key handlers
   - Updated tool count from 26 to 28 (added memory tools)
   - Updated architecture flow diagram to include Layer 2.5

2. **README.md**
   - Updated test count from 186 to 213 tests passing
   - Added alternative test command for quieter ESM runs

3. **TESTING.md**
   - Added automated testing section with commands
   - Documented Phase 2 snapshot baseline verification
   - Added quieter test run option for stream/pipe error avoidance

### Testing
- **Test Count**: 213 tests passing (up from 186)
- **New Tests**: 27 additional tests
- **Snapshot Baselines**: 22 baseline files for regression testing

### Performance
- **Code Reduction**: ~100 lines removed from `enhance.ts` through consolidation
- **Maintainability**: Shared handlers reduce duplication across 4 MCP tools

### Internal
- **No Breaking Changes**: All MCP tool schemas, names, and outputs preserved
- **Backward Compatible**: External contracts unchanged

## [1.4.1] - 2025-12-17

### Added

#### Cross-Session Memory System
- **New MCP Tools**: `add_memory` and `list_memories` for persistent memory management
  - Store preferences, architecture decisions, and project facts across sessions
  - Memories are indexed by Auggie and retrieved via semantic search
  - Human-editable markdown files in `.memories/` directory
  - Version-controllable via Git for team sharing

- **Memory Integration**: Enhanced `get_context_for_prompt` to include relevant memories
  - Memories are automatically retrieved alongside code context
  - New `memories` field in ContextBundle with relevance scores
  - Memory hints displayed in context output

- **Memory Categories**:
  - `preferences`: Coding style, tool preferences, workflow choices
  - `decisions`: Architecture decisions, technology choices, design rationale
  - `facts`: Project facts, environment info, codebase structure

### Performance

#### Parallelization Optimizations (Phase 1)
- **ServiceClient**: Implemented request queuing for `searchAndAsk` operations
  - Added `SearchQueue` class to serialize AI calls and prevent SDK concurrency issues
  - Ensures only one AI call runs at a time while allowing other operations to run in parallel
  - Provides queue length monitoring for debugging

- **ServiceClient**: Parallel file reading in `getContextForPrompt`
  - Replaced sequential file processing with `Promise.all` for concurrent file reads
  - Related files discovery now runs in parallel for each file
  - Token budget enforcement happens after parallel processing
  - **Estimated 2-4 seconds saved** per `create_plan` call

- **PlanningService**: Concurrent post-processing in `generatePlan`
  - Plan parsing and dependency analysis now run concurrently using `Promise.all`
  - JSON is parsed once and shared between validation and dependency analysis
  - **Estimated 1-2 seconds saved** per `create_plan` call

**Total estimated performance improvement: 3-6 seconds per plan generation**

### Documentation

- **README.md**: Added timeout configuration guidance
  - New troubleshooting section for tool timeout errors during plan generation
  - Documented how to configure `tool_timeout_sec` in Codex CLI (`~/.codex/config.toml`)
  - Provided guidance for other MCP clients (Claude Desktop, Cursor, Antigravity)
  - Recommended 600 seconds (10 minutes) timeout for complex planning tasks

### Fixed

#### Defensive Programming Improvements
- **ApprovalWorkflowService**: Added comprehensive null/undefined handling
  - Safely handle undefined `steps` and `risks` arrays in `createPlanApprovalRequest()`
  - Added fallback values for missing `plan.id` and `step.title` properties
  - Prevent crashes when processing malformed plan data

- **ExecutionTrackingService**: Enhanced robustness for execution tracking
  - Safely handle undefined `steps`, `depends_on`, and `blocks` arrays
  - Added defensive checks in `initializeExecution()`, `startStep()`, `completeStep()`, and `failStep()`
  - Prevent runtime errors when processing incomplete plan data

- **PlanHistoryService**: Improved version tracking reliability
  - Safely handle undefined `steps` array in `recordVersion()`
  - Added null checks in `getHistoryFilePath()` and `collectAllFiles()`
  - Enhanced `generateDiff()` to handle undefined steps arrays

- **PlanningService**: Strengthened plan generation
  - Safely handle undefined/null task strings in `generatePlan()`
  - Added safe array handling for `mvp_features`, `nice_to_have_features`, and `risks`
  - Improved error messages with better context

- **plan.ts tool**: Enhanced visualization safety
  - Safely handle undefined `steps` array in `visualize_plan` tool
  - Prevent crashes during diagram generation

### Tests Added
- **ExecutionTrackingService**: 3 new defensive programming tests
  - Test handling of undefined steps array
  - Test handling of undefined depends_on array
  - Test handling of undefined blocks array in failStep

- **PlanHistoryService**: 5 new defensive programming tests
  - Test handling of undefined/null planId in getHistoryFilePath
  - Test handling of non-existent planId in getHistory
  - Test handling of undefined file arrays in collectAllFiles
  - Test handling of undefined steps arrays in generateDiff

**Total test count: 194 (all passing)**

### New Files
- `scripts/test-defensive-checks.ts` - Manual verification script for defensive programming patterns

---

## [1.4.0] - 2025-12-15

### Added

#### Planning Mode (Phase 1)
- **`create_plan` tool**: Generate structured execution plans with DAG analysis
- **`refine_plan` tool**: Refine plans based on feedback and constraints
- **`visualize_plan` tool**: Generate text or Mermaid diagram visualizations
- **PlanningService**: Core planning logic with AI-powered plan generation
  - DAG algorithms: topological sort, critical path analysis, parallel groups
  - JSON validation and extraction from LLM responses
  - Plan refinement and iterative improvement

#### Plan Persistence (Phase 2)
- **`save_plan` tool**: Save plans to disk with metadata (name, tags, status)
- **`load_plan` tool**: Load previously saved plans by ID
- **`list_plans` tool**: List saved plans with filtering (status, tags, limit)
- **`delete_plan` tool**: Remove saved plans from storage
- **PlanPersistenceService**: JSON-based plan storage with index management

#### Approval Workflows (Phase 2)
- **`request_approval` tool**: Create approval requests for full plans, single steps, or step groups
- **`respond_approval` tool**: Approve, reject, or request modifications with comments
- **ApprovalWorkflowService**: Approval request lifecycle management
  - Risk-based approval summaries
  - Pending approval tracking
  - Approval history per plan

#### Execution Tracking (Phase 2)
- **`start_step` tool**: Mark a step as in-progress
- **`complete_step` tool**: Mark a step as completed with notes
- **`fail_step` tool**: Mark a step as failed with reason (optionally skip dependents)
- **`view_progress` tool**: View execution progress and statistics
- **ExecutionTrackingService**: Step state machine with dependency management
  - States: pending, ready, in_progress, completed, failed, skipped, blocked
  - Automatic dependent step unlocking
  - Progress percentage calculation

#### History & Versioning (Phase 2)
- **`view_history` tool**: View version history of a plan
- **`compare_plan_versions` tool**: Generate detailed diff between versions
- **`rollback_plan` tool**: Rollback to a previous plan version
- **PlanHistoryService**: Version tracking with diff generation
  - Step-level change detection (added, removed, modified)
  - File change tracking
  - Scope change detection

#### Type Definitions
- Extended `planning.ts` with 25+ new types:
  - `PlanStatus`, `StepExecutionStatus`, `ApprovalStatus`, `ApprovalAction`
  - `ApprovalRequest`, `ApprovalResponse`, `ApprovalResult`
  - `PlanExecutionState`, `StepExecutionState`, `ExecutionProgress`
  - `PlanVersion`, `PlanHistory`, `PlanDiff`, `FieldChange`
  - Various options interfaces for save, complete, fail, rollback operations

### Fixed
- **PlanPersistenceService.savePlan()**: Handle undefined `goal` and `id` properties
  - Added null/undefined checks in `generatePlanName()` method
  - Added null/undefined checks in `getPlanFilePath()` method
  - Added null/undefined checks in `countFilesAffected()` method
  - Generate fallback plan ID when `plan.id` is undefined
  - Generate fallback plan name when `plan.goal` is undefined
  - Return correct `planId` in savePlan result

### Tests Added
- `tests/services/planningService.test.ts` - DAG algorithms and JSON validation (20 tests)
- `tests/services/planPersistenceService.test.ts` - Save/load/list/delete operations (15 tests)
- `tests/services/approvalWorkflowService.test.ts` - Approval workflow tests (11 tests)
- `tests/services/executionTrackingService.test.ts` - Execution tracking tests (10 tests)
- `tests/services/planHistoryService.test.ts` - History and versioning tests (11 tests)
- `tests/prompts/planning.test.ts` - Planning prompt template tests
- `tests/tools/plan.test.ts` - Planning tool handler tests
- **Total test count: 186 (all passing)**

### New Files
- `src/mcp/services/planningService.ts` - Core planning logic
- `src/mcp/services/planPersistenceService.ts` - Plan storage
- `src/mcp/services/approvalWorkflowService.ts` - Approval workflows
- `src/mcp/services/executionTrackingService.ts` - Execution tracking
- `src/mcp/services/planHistoryService.ts` - Version history
- `src/mcp/tools/plan.ts` - Planning tool handlers
- `src/mcp/tools/planManagement.ts` - Plan management tool handlers
- `src/mcp/types/planning.ts` - Planning type definitions
- `src/mcp/prompts/planning.ts` - Planning prompt templates

---

## [1.3.0] - 2025-12-11

### Changed (BREAKING)
- **`enhance_prompt` tool now always uses AI mode**: Removed `use_ai` and `max_files` parameters
  - The tool now exclusively uses AI-powered enhancement via `searchAndAsk()`
  - Template-based enhancement mode has been removed
  - Requires authentication (`auggie login`) for all uses
  - Migration: Remove `use_ai` and `max_files` parameters from tool calls; only `prompt` is now accepted

### Removed
- Template-based enhancement mode from `enhance_prompt` tool
- `use_ai` parameter (was previously defaulted to `true`)
- `max_files` parameter (no longer applicable without template mode)

## [1.2.0] - 2025-12-11

### Added
- `codebase_retrieval` tool: primary semantic search with JSON output for programmatic consumers; includes workspace/index metadata.
- Manifest now advertises policy capability and the new tool.
- Documentation updated to list the new primary search tool.

### Enhanced
- **`codebase_retrieval` tool description with comprehensive usage rules**:
  - Added **IMPORTANT/PRIMARY/FIRST CHOICE** emphasis positioning tool as the primary codebase search tool
  - Included detailed 5-point feature list (proprietary retrieval/embedding model, real-time index, multi-language support, disk state only)
  - Added comprehensive examples section:
    - 3 good query examples ("Where is the function that handles user authentication?", etc.)
    - 4 bad query examples with recommended alternative tools (grep, file view)
  - Added **`<RULES>` section** with critical usage guidelines:
    - **Tool Selection for Code Search**: CRITICAL rules on when to use codebase-retrieval vs grep/bash commands
    - **Preliminary tasks and planning**: ALWAYS use codebase-retrieval before starting any task
    - **Making edits workflow**: ALWAYS call codebase-retrieval before editing, ask for ALL symbols in a single call
  - Provided clear decision criteria for tool selection (semantic understanding vs exact string matching)
  - Expanded embedded documentation from 16 lines to 44 lines
  - This enhancement guides AI agents to correctly use the tool as the primary choice for semantic code understanding

## [1.0.0] - 2024-12-10

### Added

#### Core Architecture
- Implemented 5-layer architecture as specified in plan.md
- Layer 1: Auggie SDK integration for core context engine
- Layer 2: Context Service Layer (serviceClient.ts) for orchestration
- Layer 3: MCP Interface Layer with three tools
- Layer 4: Agent-agnostic design for any MCP client
- Layer 5: Auggie's internal storage backend

#### MCP Tools
- `semantic_search(query, top_k)` - Semantic code search across codebase
- `get_file(path)` - Retrieve complete file contents
- `get_context_for_prompt(query, max_files)` - Primary tool for prompt enhancement

#### Features
- Local-first operation (no cloud dependencies)
- Agent-agnostic implementation (works with any MCP client)
- Authentication via Auggie CLI or environment variables
- Workspace indexing support
- Comprehensive error handling
- Detailed logging for debugging

#### Documentation
- README.md with architecture overview and usage instructions
- QUICKSTART.md for 5-minute setup guide
- TESTING.md with comprehensive testing strategies
- Example configuration files for Codex CLI
- Inline code documentation following architectural principles

#### Developer Experience
- TypeScript implementation with full type safety
- Clean separation of concerns across layers
- Extensible architecture for future enhancements
- NPM scripts for common tasks
- MCP Inspector integration for debugging

### Design Principles

- **Stateless MCP Layer**: No business logic in protocol adapter
- **Clean Contracts**: Well-defined interfaces between layers
- **Separation of Concerns**: Each layer has single responsibility
- **Extensibility**: Easy to add new tools or features
- **Local-First**: No data leaves the local machine

### Technical Stack

- TypeScript 5.3+
- Node.js 18+
- @modelcontextprotocol/sdk for MCP protocol
- @augmentcode/auggie for context engine
- stdio transport for local communication

### Known Limitations

- Requires Auggie CLI to be installed and in PATH
- Requires authentication setup before use
- Search quality depends on workspace indexing
- Large codebases may require initial indexing time

### Future Enhancements (Planned)

As outlined in plan.md, these can be added without architectural changes:
- ~~File watchers for automatic re-indexing~~ ✅ Implemented in v1.1.0
- ~~Incremental indexing for faster updates~~ ✅ Implemented in v1.1.0
- Multi-repo support
- Role-based filtering
- Hybrid search (semantic + keyword)
- ~~Result caching~~ ✅ Implemented in v1.0.0
- Custom tool configurations
- Advanced context bundling strategies

## [1.1.0] - 2025-12-11

### Added

#### New MCP Tools (4 new tools)
- `index_status` - View index health metadata (workspace, status, lastIndexed, fileCount, isStale)
- `reindex_workspace` - Clear and rebuild the entire index
- `clear_index` - Remove index state without rebuilding
- `tool_manifest` - Capability discovery for agents (lists all available tools)

#### File System Watcher (Phase 2)
- Real-time file watching with `chokidar` library
- Automatic incremental indexing on file changes
- Configurable debounce (default: 500ms) and batch size (default: 100 files)
- Enable with `--watch` or `-W` CLI flag
- Graceful shutdown on SIGTERM/SIGINT

#### Background Indexing (Phase 3)
- Non-blocking indexing via worker threads
- Message protocol: `index_start`, `index_progress`, `index_complete`, `index_error`
- Graceful fallback to synchronous indexing on worker failure
- Status tracking via `IndexStatus.status` field

#### Offline Policy Enforcement (Phase 4)
- New `CONTEXT_ENGINE_OFFLINE_ONLY` environment variable
- Blocks initialization if remote API is configured when offline-only mode is enabled
- Validation of API URL against localhost

#### Retrieval Audit Metadata (Phase 4)
- Enhanced `SearchResult` with audit fields:
  - `matchType`: "semantic" | "keyword" | "hybrid"
  - `chunkId`: Optional chunk identifier
  - `retrievedAt`: ISO timestamp of retrieval
- Audit table included in search results markdown output

#### CLI Enhancements
- New `--watch` / `-W` flag for enabling file watcher
- Improved help output with watcher documentation

### Changed
- `src/mcp/server.ts` - Added watcher integration and graceful shutdown handling
- `src/mcp/serviceClient.ts` - Added `indexFiles()`, `getIndexStatus()`, `clearIndex()`, offline policy checks
- `src/mcp/tools/search.ts` - Enhanced output with audit metadata table

### New Files
- `src/mcp/tools/status.ts` - Index status tool
- `src/mcp/tools/lifecycle.ts` - Lifecycle management tools
- `src/mcp/tools/manifest.ts` - Tool manifest for capability discovery
- `src/watcher/FileWatcher.ts` - Core file watcher implementation
- `src/watcher/types.ts` - Watcher type definitions
- `src/watcher/index.ts` - Watcher exports
- `src/worker/IndexWorker.ts` - Background indexing worker
- `src/worker/messages.ts` - Worker IPC message types

### Tests Added
- `tests/tools/status.test.ts` - Index status tool tests
- `tests/tools/lifecycle.test.ts` - Lifecycle tools tests
- `tests/watcher/FileWatcher.test.ts` - File watcher tests
- `tests/worker/IndexWorker.test.ts` - Background worker tests
- Total test count: 106 (all passing)

### Dependencies
- Added `chokidar@^3.5.3` for file system watching
- Added `@types/chokidar@^2.1.3` for TypeScript support

---

## [Unreleased]

### Planned
- E2E testing with MCP Inspector
- Performance benchmarks
- Additional example configurations
- Video tutorials
- Integration with more MCP clients

---

## Version History

- **1.6.0** - Plan execution tool with file writing, API timeout protection, and performance improvements
- **1.5.0** - Internal handlers layer, snapshot testing, and code consolidation
- **1.4.1** - Cross-session memory system and parallelization optimizations
- **1.4.0** - Planning mode with persistence, approval workflows, execution tracking, and history
- **1.3.0** - AI-only enhance_prompt tool (breaking change)
- **1.2.0** - codebase_retrieval tool with JSON output
- **1.1.0** - MCP compliance, automation, background indexing, and policy features
- **1.0.0** - Initial release with core functionality
