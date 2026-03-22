# Context Engine MCP Server

A local-first, agent-agnostic Model Context Protocol (MCP) server for workspace indexing, retrieval, planning, and review workflows.

> New here? Check out [docs/archive/INDEX.md](docs/archive/INDEX.md) for a complete documentation guide.
>
> Quick Start: [docs/archive/QUICKSTART.md](docs/archive/QUICKSTART.md) -> [docs/archive/GET_STARTED.md](docs/archive/GET_STARTED.md) -> [docs/archive/API_REFERENCE.md](docs/archive/API_REFERENCE.md)
>
> Windows Deployment: [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)
>
> Architecture: [docs/archive/TECHNICAL_ARCHITECTURE.md](docs/archive/TECHNICAL_ARCHITECTURE.md) for deep technical dive

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

- Setup: [docs/archive/QUICKSTART.md](docs/archive/QUICKSTART.md)
- MCP Clients: [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md)
- Getting Started: [docs/archive/GET_STARTED.md](docs/archive/GET_STARTED.md)
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
