# Context Engine MCP Server

A local-first, agent-agnostic Model Context Protocol (MCP) server for workspace indexing, retrieval, planning, and review workflows.

> New here? Start with the beginner quick start below.
>
> If you want client-specific setup help, see [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md).
>
> If you are on Windows, see [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md).
>
> Historical docs live in [docs/archive/INDEX.md](docs/archive/INDEX.md) if you need the old planning and migration notes.

## Beginner Quick Start

If you just want to get Context Engine running locally, follow these steps:

1. Install **Node.js 18+**.
2. Clone this repository and open it in a terminal at the repo root.
3. Install dependencies:

```bash
npm install
```

4. Build the server:

```bash
npm run build
```

5. Run the verification checks:

```bash
npm run verify
```

6. Start the MCP server for the workspace you want it to inspect:

```bash
node dist/index.js --workspace .
```

Replace `.` with the absolute path to the project you want to inspect.

### Connect It To Your MCP Client

The server speaks MCP over `stdio`, so most clients can launch it with the same command.

**Codex CLI**

```bash
codex mcp add context-engine -- node dist/index.js --workspace /path/to/your/project
```

**Windows example**

```powershell
codex mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js" --workspace "D:\GitProjects\your-project"
```

**Claude Code, Claude Desktop, Cursor, Antigravity**

See [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md) for copy-paste config examples for each client.

Ready-to-use sample config files live in [examples/mcp-clients/](examples/mcp-clients/).

### If an AI agent is setting this up

Paste this into the agent if you want it to do the setup for you:

> Set up Context Engine MCP for this workspace.
>
> 1. Run `npm install` and `npm run build`.
> 2. Pick the workspace path I want you to inspect.
> 3. Start the server with `node dist/index.js --workspace <absolute-path-to-workspace>`.
> 4. Register that exact command in the target MCP client.
> 5. Confirm the server appears in the client and that `tool_manifest()` or an equivalent tool list works.
> 6. Run one quick retrieval test, for example `semantic_search`, to confirm the connection is working.
>
> If the client is Codex CLI, use:
>
> `codex mcp add context-engine -- node dist/index.js --workspace <absolute-path-to-workspace>`

## Architecture

This implementation follows a clean 5-layer architecture:

```
┌────────────────────────────┐
│ Coding Agents (Clients)    │  Layer 4: Codex, Claude, Cursor, etc.
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
│ Retrieval + Review Engine  │  Layer 1: local-native runtime
│ (indexing, retrieval)      │
└────────────▲───────────────┘
             │ storage/state
┌────────────┴───────────────┐
│ Local State / Artifacts    │  Layer 5: workspace state + evidence
│ (index, cache, receipts)   │
└────────────────────────────┘
```

### Layer Responsibilities

- Layer 1: local-native indexing, retrieval, review support, and provider orchestration
- Layer 2: context assembly, snippet formatting, deduplication, limits, and caching
- Layer 3: MCP tools, validation, and request/response contracts
- Layer 4: coding agents and MCP clients that consume the tools
- Layer 5: persisted index state, caches, rollout receipts, and generated artifacts

## Features

### MCP Tools

The server exposes tools across these areas:
- Core context and retrieval
- Memory
- Planning and execution
- Plan management
- Code review
- Reactive review

Use `tool_manifest()` in the MCP server to inspect the current tool inventory directly.

### Key Characteristics

- Local-first runtime for indexing and retrieval, with OpenAI-backed planning/review workflows layered on top
- Agent-agnostic MCP interface
- Local-native retrieval provider as the active runtime
- Thin `context-engine-mcp` launcher for convenience; it starts the same server and does not add features
- Persistent state and evidence artifacts for rollout-proof workflows
- Planning, review, and validation workflows built into the server
- Optional benchmarking, parity, and governance gates for safer changes

## Quick Start

```bash
npm install
npm run build
npm run verify
node dist/index.js --workspace .
```

Optional validation commands:

```bash
npm run ci:check:no-legacy-provider
npm run ci:check:legacy-capability-parity
npm run ci:check:legacy-capability-parity:strict
```

## Documentation Quick Links

- Setup: [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md)
- Windows Deployment: [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)
- Troubleshooting: [docs/archive/TROUBLESHOOTING.md](docs/archive/TROUBLESHOOTING.md)
- Testing: [docs/archive/TESTING.md](docs/archive/TESTING.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Memory Operations: [docs/MEMORY_OPERATIONS_RUNBOOK.md](docs/MEMORY_OPERATIONS_RUNBOOK.md)
- All Docs: [docs/archive/INDEX.md](docs/archive/INDEX.md)

## Current Status

- Retrieval is local-native and index-backed
- Planning and review use the OpenAI session path
- Legacy-provider references that remain are historical docs, tests, or migration guardrails
- Current hardening focuses on fast paths, cancellation, and prompt efficiency rather than provider replacement
