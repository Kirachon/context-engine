# Learned Facts

This file stores factual information about your project, environment, and codebase that the AI assistant should remember across sessions.

## Project Information

<!-- Add key project facts here. Examples:
- Project uses monorepo structure with pnpm workspaces
- Main application runs on port 3000
- API documentation is auto-generated from OpenAPI spec
-->

- This is the Context Engine MCP Server project
- Exposes tools via Model Context Protocol (MCP)

## Environment Setup

<!-- Add environment-specific facts here. Examples:
- Requires Node.js 18+
- Uses PostgreSQL for production, SQLite for development
- Environment variables defined in .env.example
-->

## Codebase Structure

<!-- Add structural facts about the codebase. Examples:
- Entry point: src/index.ts
- MCP tools are in src/mcp/tools/
- Tests use Jest and are in tests/
-->

- Entry point: `src/index.ts`
- MCP server: `src/mcp/server.ts`
- Service layer: `src/mcp/serviceClient.ts`
- Tools: `src/mcp/tools/*.ts`
- Tests: `tests/*.test.ts`

## Common Patterns

<!-- Add recurring patterns used in the codebase. Examples:
- Use dependency injection for services
- All async functions return Promises
- Error handling uses custom AppError class
-->

## External Dependencies

<!-- Add notes about external services/dependencies. Examples:
- Uses Stripe for payments (test mode API keys in .env)
- Auth0 for authentication
- AWS S3 for file storage
-->

- Uses MCP SDK (`@modelcontextprotocol/sdk`) for protocol handling

## Archived Facts (Auggie-era, superseded)

<!--
Quarantine note: the entries in this section describe the project's pre-migration
implementation. The project has since migrated to a local-native retrieval runtime (see
ARCHITECTURE.md); these claims no longer describe the current codebase. They are
preserved verbatim below for history/audit (non-destructive quarantine) and are each
marked `priority: archive`. That means they are hard-excluded from default memory
retrieval (getRelevantMemories and handoff ranking, via src/mcp/memoryQuarantine.ts) while
remaining fully readable via explicit archive access (the list_memories tool reads this
file's raw contents directly, and callers may pass includeArchive: true to the underlying
handoff/retrieval helpers). See .memories/README.md for the full retrieval contract.
-->

### [2024-12-17] Auggie-era architecture and SDK description
- Uses a 5-layer architecture (Core Engine, Service Layer, MCP Interface, Agents, Storage)
- Built with TypeScript and the Auggie SDK for semantic code search

- [meta] priority: archive
- [meta] subtype: quarantine
- [meta] tags: auggie-era, stale
- [meta] created_at: 2024-12-17T00:00:00.000Z
- [meta] updated_at: 2026-07-14T11:04:00.000Z

### [2024-12-17] Auggie SDK dependency and state file
- Uses Auggie SDK (`@augmentcode/auggie-sdk`) for semantic search
- State persisted to `.augment-context-state.json`

- [meta] priority: archive
- [meta] subtype: quarantine
- [meta] tags: auggie-era, stale
- [meta] created_at: 2024-12-17T00:00:00.000Z
- [meta] updated_at: 2026-07-14T11:04:00.000Z

