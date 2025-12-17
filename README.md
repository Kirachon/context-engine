# Context Engine MCP Server

A **local-first**, **agent-agnostic** Model Context Protocol (MCP) server implementation using the Auggie SDK as the core context engine.

> 📚 **New here?** Check out [INDEX.md](INDEX.md) for a complete documentation guide!

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

### MCP Tools (28 tools available)

#### Core Context Tools
1. **`index_workspace(force?)`** - Index workspace files for semantic search
   - `force` (optional): Force re-indexing even if files haven't changed
2. **`codebase_retrieval(query, top_k?)`** - PRIMARY semantic search with JSON output for programmatic use
   - `query`: Natural language search query
   - `top_k` (optional): Number of results to return (default: 5)
3. **`semantic_search(query, top_k?)`** - Semantic code search with markdown-formatted output
   - `query`: Natural language search query
   - `top_k` (optional): Number of results to return (default: 5)
4. **`get_file(path)`** - Retrieve complete file contents
   - `path`: Relative path to file from workspace root
5. **`get_context_for_prompt(query, max_files?)`** - Get comprehensive context bundle for prompt enhancement
   - `query`: Context request description
   - `max_files` (optional): Maximum files to include (default: 5)
6. **`enhance_prompt(prompt)`** - AI-powered prompt enhancement with codebase context
   - `prompt`: Simple prompt to enhance

#### Index Management Tools (v1.1.0)
7. **`index_status()`** - View index health metadata (status, fileCount, lastIndexed, isStale)
8. **`reindex_workspace()`** - Clear and rebuild the entire index from scratch
9. **`clear_index()`** - Remove index state without rebuilding
10. **`tool_manifest()`** - Capability discovery for agents (lists all available tools and capabilities)

#### Planning Tools (v1.4.0)
11. **`create_plan(task, options?)`** - Generate structured execution plans with DAG analysis
    - `task`: Task or goal to plan for
    - `max_context_files` (optional): Max files for context (default: 10)
    - `context_token_budget` (optional): Token budget (default: 12000)
    - `generate_diagrams` (optional): Generate Mermaid diagrams (default: true)
    - `mvp_only` (optional): Focus on MVP features only (default: false)
12. **`refine_plan(current_plan, feedback?, clarifications?)`** - Refine existing plans based on feedback
    - `current_plan`: JSON string of current plan
    - `feedback` (optional): Feedback on what to change
    - `clarifications` (optional): Answers to clarifying questions
    - `focus_steps` (optional): Specific step numbers to refine
13. **`visualize_plan(plan, diagram_type?)`** - Generate visual representations (Mermaid diagrams)
    - `plan`: JSON string of the plan
    - `diagram_type` (optional): 'dependencies', 'architecture', or 'gantt' (default: 'dependencies')

#### Plan Persistence Tools (v1.4.0)
14. **`save_plan(plan, name?, tags?, overwrite?)`** - Save plans to persistent storage
    - `plan`: JSON string of EnhancedPlanOutput
    - `name` (optional): Custom name for the plan
    - `tags` (optional): Array of tags for organization
    - `overwrite` (optional): Overwrite existing plan with same ID
15. **`load_plan(plan_id)`** - Load previously saved plans
    - `plan_id`: ID of the plan to load
16. **`list_plans(status?, tags?, limit?)`** - List saved plans with filtering
    - `status` (optional): Filter by status ('ready', 'approved', 'executing', 'completed', 'failed')
    - `tags` (optional): Filter by tags
    - `limit` (optional): Maximum number of plans to return
17. **`delete_plan(plan_id)`** - Delete saved plans from storage
    - `plan_id`: ID of the plan to delete

#### Approval Workflow Tools (v1.4.0)
18. **`request_approval(plan_id, step_numbers?)`** - Create approval requests for plans or specific steps
    - `plan_id`: ID of the plan
    - `step_numbers` (optional): Specific steps to approve (omit for full plan approval)
19. **`respond_approval(request_id, action, comments?)`** - Respond to approval requests
    - `request_id`: ID of the approval request
    - `action`: 'approve', 'reject', or 'request_changes'
    - `comments` (optional): Comments or feedback

#### Execution Tracking Tools (v1.4.0)
20. **`start_step(plan_id, step_number)`** - Mark a step as in-progress
    - `plan_id`: ID of the plan
    - `step_number`: Step number to start
21. **`complete_step(plan_id, step_number, notes?, files_modified?)`** - Mark a step as completed
    - `plan_id`: ID of the plan
    - `step_number`: Step number to complete
    - `notes` (optional): Completion notes
    - `files_modified` (optional): Array of files actually modified
22. **`fail_step(plan_id, step_number, error, retry?, skip?, skip_dependents?)`** - Mark a step as failed
    - `plan_id`: ID of the plan
    - `step_number`: Step number that failed
    - `error`: Error message or reason
    - `retry` (optional): Whether to retry the step
    - `skip` (optional): Whether to skip the step
    - `skip_dependents` (optional): Whether to skip dependent steps
23. **`view_progress(plan_id)`** - View execution progress and statistics
    - `plan_id`: ID of the plan

#### History & Versioning Tools (v1.4.0)
24. **`view_history(plan_id, limit?, include_plans?)`** - View version history of a plan
    - `plan_id`: ID of the plan
    - `limit` (optional): Number of versions to retrieve
    - `include_plans` (optional): Include full plan content in each version
25. **`compare_plan_versions(plan_id, from_version, to_version)`** - Generate diff between versions
    - `plan_id`: ID of the plan
    - `from_version`: Starting version number
    - `to_version`: Ending version number
26. **`rollback_plan(plan_id, version, reason?)`** - Rollback to a previous plan version
    - `plan_id`: ID of the plan
    - `version`: Version number to rollback to
    - `reason` (optional): Reason for rollback

#### Memory Tools (v1.4.1)
27. **`add_memory(category, content, title?)`** - Store persistent memories for future sessions
    - `category`: 'preferences', 'decisions', or 'facts'
    - `content`: The memory content to store (max 5000 characters)
    - `title` (optional): Title for the memory
28. **`list_memories(category?)`** - List all stored memories
    - `category` (optional): Filter to a specific category

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

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Interactive MCP testing
npm run inspector
```

**Test Status:** 186 tests passing ✅

## License

MIT
