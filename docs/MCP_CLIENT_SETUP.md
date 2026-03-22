# MCP Client Setup Guide

This guide shows how to connect Context Engine MCP to common clients:
- Codex CLI
- Claude Code
- Antigravity
- Claude Desktop
- Cursor

## Prerequisites

1. Build the server first:

```bash
npm install
npm run build
```

2. Identify the server entrypoint path:
- Server entrypoint: `/absolute/path/to/context-engine/dist/index.js`

Windows example path:
- `D:\GitProjects\context-engine\dist\index.js`

## Shared Server Command

For repo-aware startup, most clients can use this one-time registration command:

```bash
node /absolute/path/to/context-engine/dist/index.js
```

Transport is `stdio` (not HTTP).

Context Engine resolves the workspace at startup like this:
- explicit `--workspace` override
- current working directory
- nearest parent git root when launched from a nested repo folder
- current working directory with a warning when no git root is found

Use `--workspace /path/to/your/project` only when your client launches MCP servers from the wrong folder or you want to force a different workspace.

## First-Time Setup vs Daily Use

1. First-time setup:
   Register the MCP server once in the MCP client.
2. Daily use:
   Open a repo and let the server resolve the workspace automatically.
3. Override when needed:
   Add `--workspace` for unusual layouts, monorepos, or clients that do not launch from the repo you expect.

## First-Run Indexing

Startup and indexing are now separate states:
- the server can come up first
- if the workspace is missing an index or the index is stale, background indexing starts automatically
- the first query may still be slower until indexing finishes

Operator override:
- disable startup auto-index with `CE_AUTO_INDEX_ON_STARTUP=false`
- run `index_workspace` manually if you prefer explicit control

## About the CLI Wrapper

The `context-engine-mcp` wrapper is just a small starter that launches the same server for you.

Use the wrapper when you want a shorter command or an easier install path.
Use `node /absolute/path/to/context-engine/dist/index.js` directly when your client already supports a custom command and you want the simplest setup.

The wrapper does not add new features, change search results, or replace the server itself. It is only for convenience.

## Codex CLI

Add server once:

```bash
codex mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js
```

Windows:

```powershell
codex mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js"
```

Verify:

```bash
codex mcp list
```

## Claude Code

Add server once:

```bash
claude mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js
```

Windows:

```powershell
claude mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js"
```

Verify:

```bash
claude mcp list
```

If your installed Claude Code version uses slightly different subcommand syntax, check:

```bash
claude mcp --help
```

## Antigravity

Config file locations:
- macOS: `~/Library/Application Support/Antigravity/config.json`
- Windows: `%APPDATA%\Antigravity\config.json`
- Linux: `~/.config/antigravity/config.json`

Config example:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/context-engine/dist/index.js"
      ]
    }
  }
}
```

## Claude Desktop

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Config example:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/context-engine/dist/index.js"
      ]
    }
  }
}
```

## Cursor

Config file locations:
- macOS/Linux: `~/.cursor/mcp.json`
- Windows: `%USERPROFILE%\.cursor\mcp.json`

Config example:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "/absolute/path/to/context-engine/dist/index.js"
      ]
    }
  }
}
```

## When To Keep `--workspace`

Keep the explicit workspace override if:
- your MCP client launches from a fixed home directory instead of the repo
- you want to point one client entry at a specific repo on purpose
- you are working inside a monorepo and want a narrower subtree

Example:

```powershell
codex mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js" --workspace "D:\GitProjects\your-project"
```

## Verify Any Client

After setup and restart:
1. Confirm `context-engine` appears in your MCP client.
2. Confirm tool list is visible.
3. Run one quick prompt, for example: "use `semantic_search` to find authentication logic".
4. If startup says indexing is running, wait for it to finish or trigger `index_workspace` manually.
