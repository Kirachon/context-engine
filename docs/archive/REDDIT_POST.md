# Reddit Post: Context Engine MCP Server

## Title
🚀 Built a Local-First Semantic Code Search Engine for AI Coding Agents (MCP Server with 5-Layer Architecture)

## Post Body

Hey r/programming! I wanted to share a project I've been working on that solves a real problem I had with AI coding assistants: **giving them deep, semantic understanding of your codebase without sending your code to the cloud.**

### What is it?

**Context Engine MCP Server** is a production-ready implementation of the Model Context Protocol (MCP) that provides semantic code search and context enhancement to AI coding agents like Claude Desktop, Cursor, and Codex CLI.

Think of it as giving your AI assistant a photographic memory of your entire codebase, with the ability to understand *meaning* rather than just matching keywords.

### Why did I build this?

AI coding assistants are powerful, but they struggle with large codebases. They need context to give good suggestions, but:
- Copy-pasting code is tedious and error-prone
- Cloud-based solutions raise privacy concerns
- Keyword search misses semantically similar code
- Most solutions are tied to specific AI tools

I wanted something **local-first**, **agent-agnostic**, and **actually useful**.

### The Architecture (5 Layers)

I designed this with clean separation of concerns:

```
┌─────────────────────────────┐
│ Layer 4: Agent Clients      │  Claude, Cursor, Codex CLI
│ (any MCP-compatible tool)   │
└──────────────▲──────────────┘
               │ MCP Protocol
┌──────────────┴──────────────┐
│ Layer 3: MCP Interface      │  Protocol adapter (28 tools)
│ (server.ts, tools/)         │
└──────────────▲──────────────┘
               │ Internal API
┌──────────────┴──────────────┐
│ Layer 2: Context Service    │  Orchestration, deduplication
│ (serviceClient.ts)          │
└──────────────▲──────────────┘
               │ SDK calls
┌──────────────┴──────────────┐
│ Layer 1: Core Engine        │  Auggie SDK (indexing, embeddings)
│ (@augmentcode/auggie)       │
└──────────────▲──────────────┘
               │ Storage
┌──────────────┴──────────────┐
│ Layer 5: Storage Backend    │  Vectors, metadata (local)
│ (Qdrant/SQLite)             │
└─────────────────────────────┘
```

Each layer has a single responsibility and clean interfaces. The MCP layer is completely stateless—just protocol translation.

### Key Features

✅ **Local-First**: All your code stays on your machine. No cloud dependencies, no data leakage.

✅ **Agent-Agnostic**: Works with any MCP-compatible AI assistant. Not locked into one vendor.

✅ **Real-Time Indexing**: File watcher automatically updates the index when you edit code.

✅ **Semantic Search**: Find code by *meaning*, not just keywords. "authentication logic" finds JWT handlers, OAuth flows, session management, etc.

✅ **Planning Mode**: AI-powered implementation planning with dependency analysis and execution tracking.

✅ **Cross-Session Memory**: Remembers your preferences, architecture decisions, and project facts across sessions.

### Example Usage

Once configured, you can ask your AI assistant:

```
"Find all authentication-related code"
"Show me error handling patterns in the API layer"
"Get context about the database schema"
```

The server automatically:
1. Performs semantic search across your codebase
2. Retrieves relevant code snippets
3. Deduplicates and ranks results
4. Formats context optimally for the AI

### Code Example

Here's how the semantic search tool works under the hood:

```typescript
// Layer 3: MCP tool handler (pure protocol translation)
export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const results = await serviceClient.semanticSearch(
    args.query,
    args.top_k || 5
  );
  
  return formatResultsAsMarkdown(results);
}

// Layer 2: Service orchestration
async semanticSearch(query: string, topK: number): Promise<SearchResult[]> {
  const context = await this.ensureInitialized();
  const results = await context.search(query, topK);
  
  // Deduplicate, rank, and format for optimal LLM consumption
  return this.processResults(results);
}
```

The architecture makes it trivial to add new tools or swap out the underlying engine.

### Technical Highlights

- **TypeScript** with strict typing throughout
- **29 MCP tools** including semantic search, file retrieval, context enhancement, planning, execution, and memory
- **213 passing tests** with comprehensive coverage
- **Background indexing** via worker threads (non-blocking)
- **Defensive programming** with null/undefined handling everywhere
- **Extensible design** - add new tools without touching core layers

### Getting Started

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Index your workspace
node dist/index.js --workspace /path/to/project --index

# Configure your AI assistant (example for Codex CLI)
codex mcp add context-engine -- node /path/to/dist/index.js --workspace /path/to/project
```

Full setup takes about 5 minutes. Works on Windows, macOS, and Linux.

### What's Next?

I'm using this daily with Codex CLI and it's been a game-changer for working with large codebases. The planning mode is especially useful for breaking down complex features.

Future ideas:
- Multi-repo support
- Hybrid semantic + keyword search
- Custom context bundling strategies
- Performance metrics dashboard

### Check it out!

**GitHub**: https://github.com/Kirachon/context-engine

The repo includes comprehensive documentation:
- 5-minute quickstart guide
- Architecture deep-dive
- Testing strategies
- Troubleshooting guide

I'd love to hear your thoughts! Have you tried MCP servers? What features would make this more useful for your workflow?

---

**TL;DR**: Built a local-first semantic code search engine for AI coding assistants using the Model Context Protocol. Clean 5-layer architecture, works with any MCP-compatible AI tool, keeps your code private. 29 tools, 213 tests, production-ready.

