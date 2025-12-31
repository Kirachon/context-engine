# Context Engine MCP Server

A **local-first**, **agent-agnostic** Model Context Protocol (MCP) server implementation using the Auggie SDK as the core context engine.

> 📚 **New here?** Check out [INDEX.md](INDEX.md) for a complete documentation guide!
>
> 🚀 **Quick Start**: [QUICKSTART.md](QUICKSTART.md) → [GETTING_STARTED.md](GETTING_STARTED.md) → [API_REFERENCE.md](API_REFERENCE.md)
>
> 🏗️ **Architecture**: [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md) for deep technical dive

## Architecture

This implementation follows a clean 5-layer architecture as outlined in `plan.md`:

```
┌────────────────────────────┐
│ Coding Agents (Clients)    │  Layer 4: Claude, Cursor, etc.
│ Codex | Claude | Cursor    │
└────────────▲───────────────┘
             │ MCP (tools)
┌────────────┴───────────────┐
│ MCP Interface Layer        │  Layer 3: server.ts, tools/
│ (standardized tool API)    │
└────────────▲───────────────┘
             │ internal API
┌────────────┴───────────────┐
│ Context Service Layer      │  Layer 2: serviceClient.ts
│ (query orchestration)      │
└────────────▲───────────────┘
             │ domain calls
┌────────────┴───────────────┐
│ Core Context Engine        │  Layer 1: Auggie SDK
│ (indexing, retrieval)      │
└────────────▲───────────────┘
             │ storage
┌────────────┴───────────────┐
│ Storage / Index Backend    │  Layer 5: Auggie's internal
│ (vectors, metadata)        │
└────────────────────────────┘
```

### Layer Responsibilities

- **Layer 1 (Core Engine)**: Auggie SDK handles file ingestion, chunking, embedding, and semantic retrieval
- **Layer 2 (Service)**: Orchestrates context, formats snippets, deduplicates, enforces limits
- **Layer 3 (MCP Interface)**: Exposes tools, validates I/O, maps calls to service layer
- **Layer 4 (Agents)**: Consume context and generate responses
- **Layer 5 (Storage)**: Persists embeddings and metadata

## Features

### MCP Tools (41 tools available)

#### Core Context Tools (10)
1. **`index_workspace(force?)`** - Index workspace files for semantic search
   - `force` (optional): Force re-indexing even if files haven't changed
2. **`codebase_retrieval(query, top_k?)`** - PRIMARY semantic search with JSON output for programmatic use
   - `query`: Natural language search query
   - `top_k` (optional): Number of results to return (default: 5)
3. **`semantic_search(query, top_k?, mode?, bypass_cache?, timeout_ms?)`** - Semantic code search with markdown-formatted output
   - `query`: Natural language search query
   - `top_k` (optional): Number of results to return (default: 5)
   - `mode` (optional): `"fast"` (default) or `"deep"` for higher recall at higher latency
   - `bypass_cache` (optional): When true, bypass caches for this call
   - `timeout_ms` (optional): Cap time spent in retrieval pipeline (ms)
4. **`get_file(path)`** - Retrieve complete file contents
   - `path`: Relative path to file from workspace root
5. **`get_context_for_prompt(query, max_files?, token_budget?, include_related?, min_relevance?, bypass_cache?)`** - Get comprehensive context bundle for prompt enhancement
   - `query`: Context request description
   - `max_files` (optional): Maximum files to include (default: 5)
   - `token_budget` (optional): Token budget for the bundle (default: 8000)
   - `include_related` (optional): Include related/imported files (default: true)
   - `min_relevance` (optional): Minimum relevance score (default: 0.3)
   - `bypass_cache` (optional): When true, bypass caches for this call
6. **`enhance_prompt(prompt)`** - AI-powered prompt enhancement with codebase context
   - `prompt`: Simple prompt to enhance
7. **`index_status()`** - View index health metadata (status, fileCount, lastIndexed, isStale)
8. **`reindex_workspace()`** - Clear and rebuild the entire index from scratch
9. **`clear_index()`** - Remove index state without rebuilding
10. **`tool_manifest()`** - Discovery tool for available capabilities

#### Memory System (2)
11. **`add_memory(category, content, title?)`** - Store persistent memories for future sessions
    - `category`: 'preferences', 'decisions', or 'facts'
    - `content`: The memory content to store (max 5000 characters)
    - `title` (optional): Title for the memory
12. **`list_memories(category?)`** - List all stored memories
    - `category` (optional): Filter to a specific category

#### Planning & Execution (4)
13. **`create_plan(task, options?)`** - Generate structured execution plans with DAG analysis
    - `task`: Task or goal to plan for
    - `generate_diagrams` (optional): Generate Mermaid diagrams (default: true)
14. **`refine_plan(current_plan, feedback?, clarifications?)`** - Refine existing plans based on feedback
15. **`visualize_plan(plan, diagram_type?)`** - Generate visual representations (Mermaid diagrams)
16. **`execute_plan(plan, ...)`** - Execute plan steps with AI-powered code generation

#### Plan Management (13)
17. **`save_plan(plan, name?, tags?, overwrite?)`** - Save plans to persistent storage
18. **`load_plan(plan_id \| name)`** - Load previously saved plans
19. **`list_plans(status?, tags?, limit?)`** - List saved plans with filtering
20. **`delete_plan(plan_id)`** - Delete saved plans from storage
21. **`request_approval(plan_id, step_numbers?)`** - Create approval requests for plans or specific steps
22. **`respond_approval(request_id, action, comments?)`** - Respond to approval requests
23. **`start_step(plan_id, step_number)`** - Mark a step as in-progress
24. **`complete_step(plan_id, step_number, notes?, files_modified?)`** - Mark a step as completed
25. **`fail_step(plan_id, step_number, error, ...)`** - Mark a step as failed
26. **`view_progress(plan_id)`** - View execution progress and statistics
27. **`view_history(plan_id, limit?, include_plans?)`** - View version history of a plan
28. **`compare_plan_versions(plan_id, from_version, to_version)`** - Generate diff between versions
29. **`rollback_plan(plan_id, version, reason?)`** - Rollback to a previous plan version

#### Code Review (5)
30. **`review_changes(diff, file_contexts?, options?)`** - AI-powered code review with structured output
31. **`review_git_diff(target?, base?, include_patterns?, options?)`** - Review code changes from git automatically
32. **`review_diff(diff, changed_files?, options?)`** - Enterprise review with risk scoring and static analysis
    - Risk scoring (1-5) based on deterministic preflight
    - Change classification (feature/bugfix/refactor/infra/docs)
    - Optional static analysis (TypeScript, Semgrep)
    - Per-phase timing telemetry
33. **`check_invariants(diff, changed_files?, invariants_path?)`** - Run YAML invariants deterministically (no LLM)
34. **`run_static_analysis(changed_files?, options?)`** - Run local static analyzers (tsc, semgrep)

#### Reactive Review (7)
35. **`reactive_review_pr(...)`** - Start a session-based, parallelized code review
36. **`get_review_status(session_id)`** - Track progress of a reactive review
37. **`pause_review(session_id)`** - Pause a running review session
38. **`resume_review(session_id)`** - Resume a paused session
39. **`get_review_telemetry(session_id)`** - Detailed metrics (tokens, speed, cache hits)
40. **`scrub_secrets(content)`** - Mask API keys and sensitive data
41. **`validate_content(content, content_type, ...)`** - Multi-tier validation for AI-generated content

### Key Characteristics

- ✅ **Local-first**: No cloud dependencies, no exposed ports, no data leakage
- ✅ **Agent-agnostic**: Works with any MCP-compatible coding agent
- ✅ **LLM-agnostic**: No LLM-specific logic in the engine
- ✅ **Storage-agnostic**: Auggie SDK handles storage abstraction
- ✅ **Extensible**: Clean separation allows easy feature additions
- ✅ **Real-time watching**: Automatic incremental indexing on file changes (v1.1.0)
- ✅ **Background indexing**: Non-blocking indexing via worker threads (v1.1.0)
- ✅ **Offline policy**: Enforce local-only operation with environment variable (v1.1.0)
- ✅ **Planning mode**: AI-powered implementation planning with DAG analysis (v1.4.0)
- ✅ **Execution tracking**: Step-by-step execution with dependency management (v1.4.0)
- ✅ **Version control**: Plan versioning with diff and rollback support (v1.4.0)
- ✅ **Approval workflows**: Built-in approval system for plans and steps (v1.4.0)
- ✅ **Defensive programming**: Comprehensive null/undefined handling (v1.4.1)
- ✅ **Cross-session memory**: Persistent memory system for preferences, decisions, and facts (v1.4.1)
- ✅ **AI-powered code review**: Structured code review with confidence scoring and priority levels (v1.7.0)
- ✅ **Git integration**: Automatic diff retrieval for staged, unstaged, branch, and commit changes (v1.7.0)
- ✅ **Reactive Optimization**: 180-600x faster reactive reviews via AI Agent Executor, Multi-layer Caching, Batching, and Worker Pool Optimization (v1.8.0)
- ✅ **High Availability**: Circuit breakers, adaptive timeouts, and zombie session detection (v1.8.0)
- ✅ **Static analysis integration**: Optional TypeScript and Semgrep analyzers for deterministic feedback (v1.9.0)
- ✅ **Invariants checking**: YAML-based custom rules for deterministic code review (v1.9.0)
- ✅ **Per-phase telemetry**: Detailed timing breakdowns for review pipeline optimization (v1.9.0)

## Reactive Review Optimizations (v1.8.0)

Version 1.8.0 introduces massive performance improvements to the reactive code review system, reducing review times from **30-50 minutes to 3-15 seconds** for typical PRs.

### Optimization Stack

| Phase | Feature | Performance Gain | Description |
|-------|---------|------------------|-------------|
| **Phase 1** | **AI Agent Executor** | **15-50x** | Executes reviews directly via the AI agent instead of external API calls. |
| **Phase 2** | **Multi-Layer Cache** | **2-4x (cached)** | 3-layer system: Memory (fastest) -> Commit (git-aware) -> File Hash (content-based). |
| **Phase 3** | **Continuous Batching** | **2-3x** | Accumulates and processes multiple files in a single AI request. |
| **Phase 4** | **Worker Pool Optimization** | **1.5-2x** | CPU-aware parallel execution with intelligent load balancing. |

### Total Performance Improvement

| Scenario | v1.7.1 | v1.8.0 | Improvement |
|----------|--------|--------|-------------|
| **Cold Run (10 steps)** | 30-50 min | ~60-90 sec | **25-45x** ⚡ |
| **Cached Run** | 30-50 min | ~10-30 sec | **60-180x** ⚡ |
| **Batched Run** | 30-50 min | ~5-15 sec | **120-360x** ⚡ |
| **Full Optimization** | 30-50 min | **3-10 sec** | **180-600x** 🚀 |

## Static Analysis & Invariants (v1.9.0)

Version 1.9.0 introduces optional static analysis and deterministic invariants checking for enhanced code review capabilities.

### Static Analysis Features

| Analyzer | Description | Opt-in |
|----------|-------------|--------|
| **TypeScript** | Type checking via `tsc --noEmit` | Default |
| **Semgrep** | Pattern-based security/quality checks | Optional (requires installation) |

### Usage

#### Enable Static Analysis in review_diff

```javascript
review_diff({
  diff: "<unified diff>",
  changed_files: ["src/file.ts"],
  options: {
    enable_static_analysis: true,
    static_analyzers: ["tsc", "semgrep"],
    static_analysis_timeout_ms: 60000
  }
})
```

#### Run Static Analysis Standalone

```javascript
run_static_analysis({
  changed_files: ["src/file.ts"],
  options: {
    analyzers: ["tsc", "semgrep"],
    timeout_ms: 60000,
    max_findings_per_analyzer: 20
  }
})
```

#### Check Custom Invariants

```javascript
check_invariants({
  diff: "<unified diff>",
  changed_files: ["src/file.ts"],
  invariants_path: ".review-invariants.yml"
})
```

### Invariants Configuration

Create `.review-invariants.yml` in your workspace root:

```yaml
invariants:
  - id: no-console-log
    pattern: "console\\.log"
    message: "Remove console.log statements before committing"
    severity: MEDIUM

  - id: no-todo-comments
    pattern: "TODO|FIXME"
    message: "Resolve TODO/FIXME comments"
    severity: LOW

  - id: require-error-handling
    pattern: "catch\\s*\\(\\s*\\)"
    message: "Empty catch blocks should log or handle errors"
    severity: HIGH
```

### Benefits

- ✅ **Deterministic**: No LLM required for invariants/static analysis
- ✅ **Fast**: Local execution, no API calls
- ✅ **CI-Friendly**: Structured JSON output suitable for CI/CD pipelines
- ✅ **Customizable**: YAML-based rules, configurable analyzers
- ✅ **Opt-in**: Disabled by default, enable as needed

### Per-Phase Telemetry

The `review_diff` tool now reports detailed timing breakdowns in `stats.timings_ms`:

```json
{
  "stats": {
    "timings_ms": {
      "preflight": 45,
      "invariants": 12,
      "static_analysis": 3200,
      "context_fetch": 890,
      "secrets_scrub": 5,
      "llm_structural": 1200,
      "llm_detailed": 2400
    }
  }
}
```

This allows you to:
- Identify performance bottlenecks in the review pipeline
- Optimize timeout settings for your workflow
- Monitor static analysis overhead
- Track LLM usage patterns

## Planning Workflow (v1.4.0+)

The Context Engine now includes a complete planning and execution system:

### 1. Create a Plan
```javascript
create_plan({
  task: "Implement user authentication with JWT tokens",
  generate_diagrams: true
})
```

### 2. Save the Plan
```javascript
save_plan({
  plan: "<plan JSON>",
  name: "JWT Authentication",
  tags: ["auth", "security"]
})
```

### 3. Execute Step-by-Step
```javascript
// Start a step
start_step({ plan_id: "plan_abc123", step_number: 1 })

// Complete it
complete_step({
  plan_id: "plan_abc123",
  step_number: 1,
  notes: "Created User model"
})

// Check progress
view_progress({ plan_id: "plan_abc123" })
```

### 4. Track History
```javascript
// View version history
view_history({ plan_id: "plan_abc123" })

// Compare versions
compare_plan_versions({
  plan_id: "plan_abc123",
  from_version: 1,
  to_version: 2
})

// Rollback if needed
rollback_plan({ plan_id: "plan_abc123", version: 1 })
```

See [EXAMPLES.md](EXAMPLES.md) for complete planning workflow examples.

## Memory System (v1.4.1)

The Context Engine includes a cross-session memory system that persists preferences, decisions, and project facts across sessions.

### Memory Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| `preferences` | Coding style and tool preferences | "Prefer TypeScript strict mode", "Use Jest for testing" |
| `decisions` | Architecture and design decisions | "Chose JWT over sessions", "Using PostgreSQL" |
| `facts` | Project facts and environment info | "API runs on port 3000", "Uses monorepo structure" |

### Adding Memories

```javascript
// Store a preference
add_memory({
  category: "preferences",
  content: "Prefers functional programming patterns over OOP"
})

// Store an architecture decision with a title
add_memory({
  category: "decisions",
  title: "Authentication Strategy",
  content: "Chose JWT with refresh tokens for stateless authentication. Sessions were considered but rejected due to horizontal scaling requirements."
})

// Store a project fact
add_memory({
  category: "facts",
  content: "The API uses PostgreSQL 15 with pgvector extension for embeddings"
})
```

### Automatic Memory Retrieval

Memories are automatically included in `get_context_for_prompt` results when relevant:

```javascript
// Memories are retrieved alongside code context
const context = await get_context_for_prompt({
  query: "How should I implement authentication?"
})
// Returns: code context + relevant memories about auth decisions
```

### Memory Files

Memories are stored in `.memories/` as markdown files:
- `preferences.md` - Coding style preferences
- `decisions.md` - Architecture decisions
- `facts.md` - Project facts

These files are human-editable and can be version controlled with Git.

## Prerequisites

1. **Node.js 18+**
2. **Auggie CLI** - Install globally:
   ```bash
   npm install -g @augmentcode/auggie
   ```
3. **Authentication** - Run `auggie login` or set environment variables:
   ```bash
   export AUGMENT_API_TOKEN="your-token"
   export AUGMENT_API_URL="https://api.augmentcode.com"
   ```

## Installation

```bash
# Clone or navigate to the repository
cd context-engine

# Install dependencies
npm install

# Build the project
npm run build
```

## Usage

### Standalone Mode

#### Using the Management Script (Windows)

For Windows users, a convenient batch file is provided for managing the server:

```batch
# Start the server with indexing and file watching
manage-server.bat start

# Check server status
manage-server.bat status

# Restart the server
manage-server.bat restart

# Stop the server
manage-server.bat stop
```

The management script automatically:
- Uses the current directory as workspace
- Enables indexing (`--index`)
- Enables file watching (`--watch`)
- Logs output to `.server.log`
- Tracks the process ID in `.server.pid`

#### Manual Start (All Platforms)

```bash
# Start server with current directory
node dist/index.js

# Start with specific workspace
node dist/index.js --workspace /path/to/project

# Index workspace before starting
node dist/index.js --workspace /path/to/project --index

# Enable file watcher for automatic incremental indexing (v1.1.0)
node dist/index.js --workspace /path/to/project --watch
```

### CLI Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--workspace <path>` | `-w` | Workspace directory to index (default: current directory) |
| `--index` | `-i` | Index the workspace before starting server |
| `--watch` | `-W` | Enable filesystem watcher for incremental indexing |
| `--http` | - | Enable HTTP server (in addition to stdio) |
| `--http-only` | - | Enable HTTP server only (for VS Code integration) |
| `--port <port>` | `-p` | HTTP server port (default: 3333) |
| `--help` | `-h` | Show help message |

### With Codex CLI

1. Build the project:
   ```bash
   npm run build
   ```

2. Add the MCP server to Codex CLI:
   ```bash
   codex mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
   ```

   Or edit `~/.codex/config.toml` directly:
   ```toml
   [mcp_servers.context-engine]
   command = "node"
   args = [
       "/absolute/path/to/context-engine/dist/index.js",
       "--workspace",
       "/path/to/your/project"
   ]
   ```

3. Restart Codex CLI

4. Type `/mcp` in the TUI to verify the server is connected

### With Other MCP Clients (Antigravity, Claude Desktop, Cursor)

For other MCP clients, add this server to your client's MCP configuration:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/context-engine/dist/index.js",
        "--workspace",
        "/path/to/your/project"
      ]
    }
  }
}
```

See [QUICKSTART.md - Step 5B](QUICKSTART.md#step-5b-configure-other-mcp-clients-antigravity-claude-desktop-cursor) for detailed instructions for each client.

## Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run the server
npm start
```

## Project Structure

```
context-engine/
├── src/
│   ├── index.ts              # Entry point with CLI parsing
│   ├── mcp/
│   │   ├── server.ts         # MCP server implementation
│   │   ├── serviceClient.ts  # Context service layer
│   │   ├── tools/
│   │   │   ├── index.ts      # index_workspace tool
│   │   │   ├── search.ts     # semantic_search tool
│   │   │   ├── file.ts       # get_file tool
│   │   │   ├── context.ts    # get_context_for_prompt tool
│   │   │   ├── enhance.ts    # enhance_prompt tool
│   │   │   ├── status.ts     # index_status tool (v1.1.0)
│   │   │   ├── lifecycle.ts  # reindex/clear tools (v1.1.0)
│   │   │   ├── manifest.ts   # tool_manifest tool (v1.1.0)
│   │   │   ├── plan.ts       # Planning tools (v1.4.0)
│   │   │   └── planManagement.ts  # Plan persistence/workflow tools (v1.4.0)
│   │   ├── services/         # Business logic services (v1.4.0)
│   │   │   ├── planningService.ts        # Plan generation, DAG analysis
│   │   │   ├── planPersistenceService.ts # Save/load/list plans
│   │   │   ├── approvalWorkflowService.ts # Approval request handling
│   │   │   ├── executionTrackingService.ts # Step progress tracking
│   │   │   └── planHistoryService.ts     # Version history, rollback
│   │   ├── types/            # TypeScript type definitions (v1.4.0)
│   │   │   └── planning.ts   # Planning-related types
│   │   └── prompts/          # AI prompt templates (v1.4.0)
│   │       └── planning.ts   # Planning system prompts
│   ├── watcher/              # File watching (v1.1.0)
│   │   ├── FileWatcher.ts    # Core watcher logic
│   │   ├── types.ts          # Event types
│   │   └── index.ts          # Exports
│   └── worker/               # Background indexing (v1.1.0)
│       ├── IndexWorker.ts    # Worker thread
│       └── messages.ts       # IPC messages
├── tests/                    # Unit tests (186 tests)
├── plan.md                   # Architecture documentation
├── package.json
├── tsconfig.json
└── README.md
```

## Example Usage

Once connected to Codex CLI, you can use natural language:

- "Search for authentication logic in the codebase"
- "Show me the database schema files"
- "Get context about the API endpoints"
- "Find error handling patterns"

The server will automatically use the appropriate tools to provide relevant context.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AUGMENT_API_TOKEN` | Auggie API token (or use `auggie login`) | - |
| `AUGMENT_API_URL` | Auggie API URL | `https://api.augmentcode.com` |
| `CONTEXT_ENGINE_OFFLINE_ONLY` | Enforce offline-only policy (v1.1.0) | `false` |
| `REACTIVE_ENABLED` | Enable reactive review features | `false` |
| `REACTIVE_USE_AI_AGENT_EXECUTOR`| Use local AI agent for reviews (Phase 1) | `false` |
| `REACTIVE_ENABLE_MULTILAYER_CACHE`| Enable 3-layer caching (Phase 2) | `false` |
| `REACTIVE_ENABLE_BATCHING`| Enable request batching (Phase 3) | `false` |
| `REACTIVE_OPTIMIZE_WORKERS`| Enable CPU-aware worker optimization (Phase 4) | `false` |
| `REACTIVE_PARALLEL_EXEC`| Enable concurrent worker execution | `false` |
| `CE_INDEX_STATE_STORE` | Persist per-file index hashes to `.augment-index-state.json` | `false` |
| `CE_SKIP_UNCHANGED_INDEXING` | Skip re-indexing unchanged files (requires `CE_INDEX_STATE_STORE=true`) | `false` |
| `CE_HASH_NORMALIZE_EOL` | Normalize CRLF/LF when hashing (recommended with state store across Windows/Linux) | `false` |

### Offline-Only Mode (v1.1.0)

To enforce that no data is sent to remote APIs, set:

```bash
export CONTEXT_ENGINE_OFFLINE_ONLY=true
```

When enabled, the server will fail to start if a remote API URL is configured. This is useful for enterprise environments with strict data locality requirements.

## Troubleshooting

### Server not showing up in Codex CLI

1. Check `~/.codex/config.toml` for syntax errors
2. Ensure paths are absolute
3. Restart Codex CLI
4. Run `codex mcp list` to see configured servers
5. Use `/mcp` command in the TUI to check connection status

### Authentication errors

Run `auggie login` or verify environment variables are set correctly.

### No search results

Index your workspace first:
```bash
node dist/index.js --workspace /path/to/project --index
```

### File watcher not detecting changes (v1.1.0)

1. Ensure you started the server with `--watch` flag
2. Check that the file is not in `.gitignore` or `.contextignore`
3. Wait for the debounce period (default: 500ms) after the last change
4. Check server logs for watcher status messages

### Offline-only mode blocking startup (v1.1.0)

If you see an error about offline-only mode:
1. Remove the `CONTEXT_ENGINE_OFFLINE_ONLY` environment variable, or
2. Configure a localhost API URL in `AUGMENT_API_URL`

### Tool timeout errors during plan generation (v1.4.0)

The `create_plan` tool can take longer than default MCP client timeouts for complex tasks. If you experience timeout errors, increase the timeout in your MCP client configuration:

#### For Codex CLI

Edit `~/.codex/config.toml` and add or modify the `tool_timeout_sec` setting under the `[mcp_servers.context-engine]` section:

```toml
[mcp_servers.context-engine]
command = "node"
args = ["/absolute/path/to/context-engine/dist/index.js", "--workspace", "/path/to/your/project"]
tool_timeout_sec = 600  # 10 minutes for complex planning tasks
```

#### For Other MCP Clients

Consult your client's documentation for timeout configuration. Common locations:
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor**: `.cursor/mcp.json` in your workspace
- **Antigravity**: Check client-specific configuration files

Add a timeout setting appropriate for your client's configuration format. A value of **600 seconds (10 minutes)** is recommended for complex planning tasks.

## Testing

```bash
# Run all tests
npm test

# Quieter ESM run (use if you see pipe/stream errors)
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --silent

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Interactive MCP testing
npm run inspector
```

**Test Status:** 397 tests passing (100% completion) ✅

## License

MIT
