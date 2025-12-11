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

### MCP Tools (10 tools)

#### Core Tools
1. **`index_workspace(force)`** - Index workspace files for semantic search
2. **`codebase_retrieval(query, top_k)`** - PRIMARY semantic search, JSON output for programmatic use
3. **`semantic_search(query, top_k)`** - Semantic code search across the codebase (markdown output)
4. **`get_file(path)`** - Retrieve complete file contents
5. **`get_context_for_prompt(query)`** - Get relevant context for prompt enhancement (primary tool)
6. **`enhance_prompt(prompt)`** - Transform simple prompts into detailed, structured prompts using AI-powered enhancement

#### Management Tools (New in v1.1.0)
7. **`index_status()`** - View index health metadata (status, fileCount, lastIndexed, isStale)
8. **`reindex_workspace()`** - Clear and rebuild the entire index
9. **`clear_index()`** - Remove index state without rebuilding
10. **`tool_manifest()`** - Capability discovery for agents (lists all available tools)

### Key Characteristics

- ✅ **Local-first**: No cloud dependencies, no exposed ports, no data leakage
- ✅ **Agent-agnostic**: Works with any MCP-compatible coding agent
- ✅ **LLM-agnostic**: No LLM-specific logic in the engine
- ✅ **Storage-agnostic**: Auggie SDK handles storage abstraction
- ✅ **Extensible**: Clean separation allows easy feature additions
- ✅ **Real-time watching**: Automatic incremental indexing on file changes (v1.1.0)
- ✅ **Background indexing**: Non-blocking indexing via worker threads (v1.1.0)
- ✅ **Offline policy**: Enforce local-only operation with environment variable (v1.1.0)

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
│   │   └── tools/
│   │       ├── index.ts      # index_workspace tool
│   │       ├── search.ts     # semantic_search tool
│   │       ├── file.ts       # get_file tool
│   │       ├── context.ts    # get_context_for_prompt tool
│   │       ├── enhance.ts    # enhance_prompt tool
│   │       ├── status.ts     # index_status tool (v1.1.0)
│   │       ├── lifecycle.ts  # reindex/clear tools (v1.1.0)
│   │       └── manifest.ts   # tool_manifest tool (v1.1.0)
│   ├── watcher/              # File watching (v1.1.0)
│   │   ├── FileWatcher.ts    # Core watcher logic
│   │   ├── types.ts          # Event types
│   │   └── index.ts          # Exports
│   └── worker/               # Background indexing (v1.1.0)
│       ├── IndexWorker.ts    # Worker thread
│       └── messages.ts       # IPC messages
├── tests/                    # Unit tests (106 tests)
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

**Test Status:** 106 tests passing ✅

## License

MIT
