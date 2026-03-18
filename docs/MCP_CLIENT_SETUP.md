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

2. Identify paths you will use:
- Server entrypoint: `/absolute/path/to/context-engine/dist/index.js`
- Workspace path: `/path/to/your/project`

Windows example paths:
- `D:\GitProjects\context-engine\dist\index.js`
- `D:\GitProjects\your-project`

## Shared Server Command

All clients should run the same stdio command:

```bash
node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
```

Transport is `stdio` (not HTTP).

## About the CLI Wrapper

The `context-engine-mcp` wrapper is just a small starter that launches the same server for you.

Use the wrapper when you want a shorter command or an easier install path.
Use `node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project` directly when your client already supports a custom command and you want the simplest setup.

The wrapper does not add new features, change search results, or replace the server itself. It is only for convenience.

## Codex CLI

Add server:

```bash
codex mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
```

Windows:

```powershell
codex mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js" --workspace "D:\GitProjects\your-project"
```

Verify:

```bash
codex mcp list
```

## Claude Code

Add server:

```bash
claude mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
```

Windows:

```powershell
claude mcp add context-engine -- node "D:\GitProjects\context-engine\dist\index.js" --workspace "D:\GitProjects\your-project"
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
        "/absolute/path/to/context-engine/dist/index.js",
        "--workspace",
        "/path/to/your/project"
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
        "/absolute/path/to/context-engine/dist/index.js",
        "--workspace",
        "/path/to/your/project"
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
        "/absolute/path/to/context-engine/dist/index.js",
        "--workspace",
        "/path/to/your/project"
      ]
    }
  }
}
```

## Verify Any Client

After setup and restart:
1. Confirm `context-engine` appears in your MCP client.
2. Confirm tool list is visible (current inventory is 42 tools).
3. Run one quick prompt, for example: "use `semantic_search` to find authentication logic".
