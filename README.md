# Context Engine MCP Server

A local-first, agent-agnostic Model Context Protocol (MCP) server for workspace indexing, retrieval, planning, and review workflows, with a setup path that works well for Codex and other OpenAI-powered agents.

> New here? Start with the beginner quick start below.
>
> If you want client-specific setup help, see [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md).
>
> If you are on Windows, see [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md).
>
> Historical docs live in [docs/archive/INDEX.md](docs/archive/INDEX.md) if you need the old planning and migration notes.

## OpenAI / Codex Showcase

If you want to see what this project demonstrates for OpenAI-style agent workflows, start here:

- Local workspace indexing and retrieval
- Review and planning workflows layered on top of the same MCP server
- Beginner-friendly install and client setup
- Windows support and copy-paste setup examples
- AI-agent-friendly instructions for self-setup

### Why This Matters

- It shows how an OpenAI-powered agent can connect to a real workspace and start using tools right away.
- It combines retrieval, review, and planning in one MCP server instead of relying on one-off scripts.
- It gives both humans and AI agents a simple, repeatable setup path, which makes demos and onboarding easier.

Fastest demo path:

```bash
npm install
npm run build
codex mcp add context-engine -- node dist/index.js
```

Then in Codex, confirm the tools are visible and try:

```text
use semantic_search to find authentication logic
```

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

6. Start the MCP server:

```bash
node dist/index.js
```

By default, Context Engine now resolves the workspace like this:
- explicit `--workspace` wins
- otherwise it uses the current folder
- if you launched from a nested folder inside a git repo, it falls back to the nearest git root
- if no git root exists, it stays on the current folder and logs a warning

On first run, if the index is missing or stale, startup can kick off background indexing automatically. The server still starts first, but the first query may be slower until indexing finishes.

### Connect It To Your MCP Client

The server speaks MCP over `stdio`, so most clients can launch it with the same command.

### First-Time Setup vs Daily Use

Use this mental model:

1. First-time setup:
   Register the MCP server once in your client.
2. Daily use:
   Open any repo and let the server resolve the workspace automatically.
3. Override only when needed:
   Pass `--workspace <absolute-path>` if the client launches from the wrong folder or you want a different repo on purpose.

**Codex CLI**

```bash
codex mcp add context-engine -- node dist/index.js
```

**Windows example**

```powershell
codex mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js"
```

**Claude Code, Claude Desktop, Cursor, Antigravity**

See [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md) for copy-paste config examples for each client.

Ready-to-use sample config files live in [examples/mcp-clients/](examples/mcp-clients/).
Optional skill packages for AI workflows live in [examples/skills/](examples/skills/).

### If an AI agent is setting this up

Paste this into the agent if you want it to do the setup for you:

> Set up Context Engine MCP for this workspace.
>
> 1. Run `npm install` and `npm run build`.
> 2. Register the MCP server once with `node dist/index.js`.
> 3. Confirm the client launches the MCP server from the repo I am working in.
> 4. If the client launches from the wrong folder, add `--workspace <absolute-path-to-workspace>` as an override.
> 5. Confirm the server appears in the client and that `tool_manifest()` or an equivalent tool list works.
> 6. Run one quick retrieval test, for example `semantic_search`, to confirm the connection is working.
> 7. If startup says the workspace is unindexed or stale, let the background indexing finish or run `index_workspace` manually.
>
> If the client is Codex CLI, use:
>
> `codex mcp add context-engine -- node dist/index.js`

### Startup Behavior

When the server starts without `--workspace`, it tries to be repo-aware:
- repo root launch: uses that repo
- nested repo folder launch: upgrades to the nearest git root
- non-git folder launch: stays on the current folder and warns clearly

If startup auto-index is enabled, missing or stale workspaces start background indexing automatically.

Operator override:
- disable startup auto-index with `CE_AUTO_INDEX_ON_STARTUP=false`
- force a specific workspace with `--workspace "D:\path\to\repo"`

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
node dist/index.js
```

Optional validation commands:

```bash
npm run ci:check:no-legacy-provider
npm run ci:check:legacy-capability-parity
npm run ci:check:legacy-capability-parity:strict
```

## Documentation Quick Links

- Docs Map: [docs/README.md](docs/README.md)
- Setup: [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md)
- Windows Deployment: [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)
- Troubleshooting: [docs/archive/TROUBLESHOOTING.md](docs/archive/TROUBLESHOOTING.md)
- Testing: [docs/archive/TESTING.md](docs/archive/TESTING.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Memory Operations: [docs/MEMORY_OPERATIONS_RUNBOOK.md](docs/MEMORY_OPERATIONS_RUNBOOK.md)
- Archive: [docs/archive/INDEX.md](docs/archive/INDEX.md)

## Current Status

- Retrieval is local-native and index-backed
- Planning and review use the OpenAI session path
- Legacy-provider references that remain are historical docs, tests, or migration guardrails
- Current hardening focuses on fast paths, cancellation, and prompt efficiency rather than provider replacement
