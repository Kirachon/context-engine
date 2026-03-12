# Context Engine MCP Server

A local-first, agent-agnostic Model Context Protocol (MCP) server for workspace indexing, retrieval, planning, and review workflows.

> New here? Check out [INDEX.md](INDEX.md) for a complete documentation guide.
>
> Quick Start: [QUICKSTART.md](QUICKSTART.md) -> [GET_STARTED.md](GET_STARTED.md) -> [API_REFERENCE.md](API_REFERENCE.md)
>
> Windows Deployment: [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)
>
> Architecture: [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md) for deep technical dive

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

- Local-first runtime with no Auggie SDK dependency in the active path
- Agent-agnostic MCP interface
- Local-native retrieval provider as the active runtime
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
npm run ci:check:no-legacy-auggie
npm run ci:check:auggie-capability-parity
npm run ci:check:auggie-capability-parity:strict
```

## Documentation Quick Links

- Setup: [QUICKSTART.md](QUICKSTART.md)
- MCP Clients: [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md)
- Getting Started: [GET_STARTED.md](GET_STARTED.md)
- Troubleshooting: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- Testing: [TESTING.md](TESTING.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- All Docs: [INDEX.md](INDEX.md)

## Current Status

- Active runtime is local-native only
- Auggie-era references that remain are historical docs, tests, or migration guardrails
- Removal and parity proof tracking lives in [docs/AUGGIE_ADOPTION_AND_REMOVAL_TRACKER.md](docs/AUGGIE_ADOPTION_AND_REMOVAL_TRACKER.md)
