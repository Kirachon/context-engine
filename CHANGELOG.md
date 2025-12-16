# Changelog

All notable changes to the Context Engine MCP Server will be documented in this file.

## [1.4.1] - 2025-12-15

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

- **1.4.0** - Planning mode with persistence, approval workflows, execution tracking, and history
- **1.3.0** - AI-only enhance_prompt tool (breaking change)
- **1.2.0** - codebase_retrieval tool with JSON output
- **1.1.0** - MCP compliance, automation, background indexing, and policy features
- **1.0.0** - Initial release with core functionality
