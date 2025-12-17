# Learned Facts

This file stores factual information about your project, environment, and codebase that the AI assistant should remember across sessions.

## Project Information

<!-- Add key project facts here. Examples:
- Project uses monorepo structure with pnpm workspaces
- Main application runs on port 3000
- API documentation is auto-generated from OpenAPI spec
-->

- This is the Context Engine MCP Server project
- Uses a 5-layer architecture (Core Engine, Service Layer, MCP Interface, Agents, Storage)
- Built with TypeScript and the Auggie SDK for semantic code search
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

- Uses Auggie SDK (`@augmentcode/auggie-sdk`) for semantic search
- Uses MCP SDK (`@modelcontextprotocol/sdk`) for protocol handling
- State persisted to `.augment-context-state.json`

