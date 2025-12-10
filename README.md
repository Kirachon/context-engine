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

### MCP Tools

1. **`semantic_search(query, top_k)`** - Semantic code search across the codebase
2. **`get_file(path)`** - Retrieve complete file contents
3. **`get_context_for_prompt(query)`** - Get relevant context for prompt enhancement (primary tool)

### Key Characteristics

- ✅ **Local-first**: No cloud dependencies, no exposed ports, no data leakage
- ✅ **Agent-agnostic**: Works with any MCP-compatible coding agent
- ✅ **LLM-agnostic**: No LLM-specific logic in the engine
- ✅ **Storage-agnostic**: Auggie SDK handles storage abstraction
- ✅ **Extensible**: Clean separation allows easy feature additions

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
```

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
│   ├── index.ts              # Entry point
│   └── mcp/
│       ├── server.ts         # MCP server implementation
│       ├── serviceClient.ts  # Context service layer
│       └── tools/
│           ├── search.ts     # semantic_search tool
│           ├── file.ts       # get_file tool
│           └── context.ts    # get_context_for_prompt tool
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

## License

MIT

