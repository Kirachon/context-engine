# Changelog

All notable changes to the Context Engine MCP Server will be documented in this file.

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

- **1.1.0** - MCP compliance, automation, background indexing, and policy features
- **1.0.0** - Initial release with core functionality
