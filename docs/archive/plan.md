COMPREHENSIVE ARCHITECTURE PLAN

Auggie SDK → Custom MCP Wrapper → Any Coding Agent

**Hybrid Architecture**: We use the Auggie SDK as the core context engine
while maintaining our custom MCP server for protocol adaptation and orchestration.

Reference: https://docs.augmentcode.com/context-services/sdk/examples


---

1. High-Level Architecture (Mental Model)

Think in 5 layers, each with one responsibility only.

┌────────────────────────────┐
│ Coding Agents (Clients) │
│ Codex | Claude | Cursor │
└────────────▲───────────────┘
             │ MCP (tools)
┌────────────┴───────────────┐
│ MCP Interface Layer │
│ (our custom server.ts) │
└────────────▲───────────────┘
             │ internal API
┌────────────┴───────────────┐
│ Context Service Layer │
│ (our serviceClient.ts) │
└────────────▲───────────────┘
             │ SDK calls
┌────────────┴───────────────┐
│ Auggie SDK / CLI │
│ (@augmentcode/auggie) │
└────────────▲───────────────┘
             │ cloud API
┌────────────┴───────────────┐
│ Auggie Cloud Backend │
│ (embeddings, vectors) │
└────────────────────────────┘

This separation is critical.
Never collapse these layers.


---

2. Layer 1 — Core Context Engine (Auggie SDK)

Purpose

This is the brain. We use the Auggie SDK instead of building from scratch.
It knows nothing about MCP, Codex, or Claude.

The Auggie SDK handles:
✅ File ingestion & scanning
✅ Chunking (with language-aware parsing)
✅ Embedding generation (via Auggie cloud API)
✅ Vector storage & management
✅ Semantic retrieval
✅ Metadata management

Our code does NOT need to:
❌ Implement file scanning
❌ Implement chunking algorithms
❌ Manage embeddings or vectors
❌ Set up Qdrant/SQLite storage


---

Integration Options

Option A: Auggie CLI (current implementation)
- Uses `auggie` command-line tool
- Simpler setup, works out of the box
- Requires auggie CLI installed globally

Option B: Auggie SDK (programmatic)
- Uses `@augmentcode/auggie-sdk` npm package
- More control over indexing/search
- DirectContext for explicit file management
- FileSystemContext for automatic directory indexing


---

SDK Usage Examples

// FileSystemContext - automatic directory indexing
import { FileSystemContext } from '@augmentcode/auggie-sdk';

const context = await FileSystemContext.create({
  directory: '/path/to/workspace',
});

const results = await context.search('authentication logic');
await context.close();

// DirectContext - explicit file control
import { DirectContext } from '@augmentcode/auggie-sdk';

const context = await DirectContext.create();
await context.addFiles([
  { path: 'src/main.ts', contents: '...' }
]);
const results = await context.search('query');


---

Engine API (clean contract)

Our serviceClient.ts wraps Auggie SDK with this API:

indexWorkspace(): Promise<void>       // → auggie index
semanticSearch(query, k): Result[]    // → auggie search
getFile(path): FileContent            // → fs.readFileSync
getContextForPrompt(query): Bundle    // → search + formatting

This API never changes, even if the underlying SDK changes.


---

3. Layer 2 — Context Service Layer (Orchestration)

**Location**: src/mcp/serviceClient.ts (✅ IMPLEMENTED)

Purpose

This layer adapts raw retrieval from Auggie SDK into agent-friendly context.
This is OUR custom code that adds value on top of the SDK.

Think of it as the “prompt intelligence” layer.


---

Responsibilities (our custom logic)

✅ Decide how much context to return
✅ Format snippets for agent consumption
✅ Deduplicate results by file path
✅ Enforce token/file limits
✅ Apply heuristics (importance, recency)
✅ Generate context bundles with hints

Must NOT do

❌ Index files (Auggie SDK does this)
❌ Store vectors (Auggie SDK does this)
❌ Talk to agents directly (MCP layer does this)


---

Context Bundle format (example)

{
  "summary": "Data loading pipeline for X",
  "files": [
    {
      "path": "src/loader.ts",
      "snippets": [
        { "text": "...", "lines": "10-40" }
      ]
    }
  ],
  "hints": [
    "Loader is synchronous",
    "TODO mentions batching"
  ]
}

This is what prompt enhancement really is.


---

4. Layer 3 — MCP Interface Layer

**Location**: src/mcp/server.ts + src/mcp/tools/* (✅ IMPLEMENTED)

Purpose

This is the adapter that lets agents talk to you.

MCP is just a wire protocol.
This is OUR custom code that exposes Auggie SDK via MCP.


---

Responsibilities

✅ Expose tools via MCP protocol
✅ Validate input/output schemas
✅ Map tool calls → service layer
✅ Stay stateless
✅ Format responses for agents

Must NOT do

❌ Business logic (service layer does this)
❌ Retrieval logic (Auggie SDK does this)
❌ Context bundling (service layer does this)


---

MCP Tools (✅ ALL IMPLEMENTED)

semantic_search(query, top_k)     → src/mcp/tools/search.ts
get_file(path)                    → src/mcp/tools/file.ts
get_context_for_prompt(query)     → src/mcp/tools/context.ts

Only get_context_for_prompt is required for prompt enhancement.


---

MCP Server Structure (✅ IMPLEMENTED)

src/mcp/
├── server.ts           # MCP server with tool handlers
├── serviceClient.ts    # Context service layer
└── tools/
    ├── search.ts       # semantic_search tool
    ├── file.ts         # get_file tool
    └── context.ts      # get_context_for_prompt tool

This layer can be replaced without touching the SDK.


---

5. Layer 4 — Agent Clients (Codex, Claude, Cursor)

Purpose

Consume context — nothing more.

Agents:

decide when to call tools

decide how to use context

generate final answers


Your system never generates answers.


---

Why this is correct

Keeps LLM-specific logic out of your engine

Lets you swap agents freely

Avoids prompt coupling



---

6. Layer 5 — Storage & Index Backend

**Location**: Auggie Cloud (managed by SDK)

Responsibilities (handled by Auggie SDK)

✅ Persist embeddings in Auggie cloud
✅ Persist metadata
✅ Support fast vector lookup
✅ Handle deduplication

We do NOT need to:
❌ Set up Qdrant or SQLite
❌ Manage vector storage
❌ Handle embedding persistence


---

Trade-off: Cloud Dependency

The Auggie SDK uses cloud storage for embeddings.
This is acceptable because:
- Simplifies deployment (no local DB setup)
- Provides production-grade vector search
- Enables features like searchAndAsk
- Still runs locally (only embeddings API is remote)

Future option: If local-only is critical, could explore
local embedding models + Qdrant.


---

7. Execution Flow (End-to-End)

Indexing (via Auggie SDK)

File system
→ Auggie CLI/SDK scans files
→ Auggie chunks content
→ Auggie API generates embeddings
→ Auggie cloud stores vectors

Prompt Enhancement (our custom flow)

Agent prompt
→ MCP tool call (server.ts)
→ Context Service (serviceClient.ts)
→ Auggie SDK search
→ Our context bundling
→ Formatted response to agent


---

8. Hybrid Deployment Model

[Our MCP Server + Service Layer]
          │
    Auggie SDK/CLI
          │
    Auggie Cloud API
          ↓
   Codex / Claude / Cursor

**Minimal cloud dependency**: Only Auggie API for embeddings
**No exposed ports**: Uses stdio transport
**Code stays local**: Only embeddings sent to cloud


---

9. What Makes This Architecture “Complete”

✅ Clear separation of concerns
✅ Agent-agnostic (works with any MCP client)
✅ LLM-agnostic (no hardcoded prompts)
✅ SDK-based (leverages Auggie infrastructure)
✅ Extensible without rewrites
✅ Hybrid local/cloud approach

This is infrastructure-level design, not a hack.


---

10. What You Can Safely Add Later

These enhancements can be added without architectural changes:

- File watchers (auto-reindex on changes)
- Incremental indexing (faster updates)
- Multi-repo support (multiple workspaces)
- Role-based filtering (security contexts)
- Hybrid search (keyword + vector)
- Response caching (performance)
- Custom context strategies (pluggable bundling)
- Metrics & monitoring (usage tracking)


---

11. Implementation Status

✅ Layer 1: Auggie SDK integration (via CLI)
✅ Layer 2: Context Service (serviceClient.ts)
✅ Layer 3: MCP Server (server.ts + tools/)
✅ Layer 4: Agent configuration (Codex CLI)
✅ Layer 5: Storage (Auggie cloud)

**Status: FULLY IMPLEMENTED**


---

Final One-Sentence Summary

You are building an agent-agnostic context backend with MCP as the protocol
adapter and Auggie SDK as the engine.