# Testing Guide

How to test the Context Engine MCP Server implementation.

## Automated Testing

```bash
# Run all tests (ESM)
npm test
```

If you see stream/pipe errors or want a quieter run:
```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --silent
```

Phase 2 snapshot baselines are verified separately:
```bash
npx --no-install tsx tests/snapshots/snapshot-harness.ts
```

## Manual Testing

### 1. Test Server Startup

```bash
# Build the project
npm run build

# Test help command
node dist/index.js --help

# Test with current directory
node dist/index.js --workspace .
```

Expected output:
```
================================================================================
Context Engine MCP Server
================================================================================
Workspace: /path/to/current/directory

Starting MCP server...
Context Engine MCP Server running on stdio
```

### 2. Test with MCP Inspector

The MCP Inspector is a debugging tool for MCP servers.

```bash
# Install MCP Inspector globally
npm install -g @modelcontextprotocol/inspector

# Run the inspector with your server
mcp-inspector node dist/index.js --workspace /path/to/project
```

This opens a web interface where you can:
- See all available tools
- Test tool calls interactively
- View request/response payloads
- Debug errors

### 3. Test Individual Tools

#### Test semantic_search

In MCP Inspector or Codex CLI:
```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "authentication logic",
    "top_k": 5
  }
}
```

Expected: List of relevant files with code snippets

#### Test get_file

```json
{
  "name": "get_file",
  "arguments": {
    "path": "src/index.ts"
  }
}
```

Expected: Complete file contents with metadata

#### Test get_context_for_prompt

```json
{
  "name": "get_context_for_prompt",
  "arguments": {
    "query": "database schema",
    "max_files": 3
  }
}
```

Expected: Formatted context bundle with relevant code

## Integration Testing with Codex CLI

### 1. Setup

Follow the Quick Start guide to configure Codex CLI.

### 2. Test Queries

Try these queries in Codex CLI:

**Basic Search:**
- "Search for error handling in the codebase"
- "Find all API endpoints"
- "Show me the configuration files"

**Context Gathering:**
- "Get context about the authentication system"
- "Explain how the database is structured"
- "What are the main entry points of this application?"

**File Retrieval:**
- "Show me the package.json file"
- "Get the contents of the README"

### 3. Verify Tool Usage

After each query, check that Codex:
1. Correctly identifies which tool to use
2. Provides relevant results
3. Formats the response appropriately

### 4. Check MCP Status

In Codex CLI TUI, type `/mcp` to see:
- Connected MCP servers
- Available tools from each server
- Connection status

## Debugging

### Check Codex Logs

```bash
# View codex logs
# Codex writes logs to stderr - capture them when running manually
node dist/index.js --workspace . 2>&1 | tee server.log
```

### Enable Verbose Logging

Modify `src/index.ts` to add more logging:

```typescript
console.error('Tool called:', name);
console.error('Arguments:', JSON.stringify(args, null, 2));
```

### Test Auggie CLI Directly

```bash
# Test authentication
auggie --version

# Test indexing
auggie index /path/to/project

# Test search
auggie search "authentication" --limit 5
```

## Common Issues

### Issue: "No API token found"

**Solution:**
```bash
# Login via CLI
auggie login

# Or set environment variable
export AUGMENT_API_TOKEN="your-token"
```

### Issue: "No results found"

**Solution:**
```bash
# Index the workspace first
node dist/index.js --workspace /path/to/project --index

# Or use auggie CLI
auggie index /path/to/project
```

### Issue: "Failed to execute auggie CLI"

**Solution:**
```bash
# Verify auggie is installed
which auggie  # macOS/Linux
where auggie  # Windows

# Reinstall if needed
npm install -g @augmentcode/auggie
```

### Issue: Tools not showing in Codex CLI (/mcp)

**Solution:**
1. Check config file syntax (`~/.codex/config.toml`)
2. Use absolute paths
3. Restart Codex CLI
4. Run `codex mcp list` to verify configuration

## Performance Testing

### Test Indexing Speed

```bash
# Time the indexing process
time node dist/index.js --workspace /large/project --index
```

### Test Search Performance

Use MCP Inspector to measure response times for different queries.

### Test with Large Codebases

Test with repositories of different sizes:
- Small: < 100 files
- Medium: 100-1000 files
- Large: > 1000 files

## Validation Checklist

- [ ] Server starts without errors
- [ ] All three tools are listed
- [ ] semantic_search returns relevant results
- [ ] get_file retrieves correct content
- [ ] get_context_for_prompt provides useful context
- [ ] Error handling works (invalid paths, bad queries)
- [ ] Authentication works (both CLI and env vars)
- [ ] Works with Codex CLI
- [ ] Logs are helpful for debugging

## Next Steps

After testing:
1. Review any errors or issues
2. Check performance with your specific codebase
3. Customize tool parameters if needed
4. Add additional tools based on your requirements

## Reporting Issues

If you find bugs:
1. Check the logs
2. Try to reproduce with MCP Inspector
3. Document the steps to reproduce
4. Include error messages and stack traces
