# Troubleshooting Guide

Common issues and solutions for the Context Engine MCP Server.

> Current runtime note: the active retrieval/runtime path is now `local_native`. Any legacy-provider guidance below should be treated as historical unless the section explicitly says it is archival.

## Installation Issues

### "Cannot find module '@modelcontextprotocol/sdk'"

**Cause**: Dependencies not installed

**Solution**:
```bash
npm install
```

### Legacy provider references in older docs

**Cause**: You are following an older document from the legacy-provider migration phase.

**Solution**:
```bash
npm run verify
npm run ci:check:no-legacy-provider
```

### TypeScript compilation errors

**Cause**: TypeScript version mismatch or missing types

**Solution**:
```bash
# Clean and reinstall
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build
```

## Authentication Issues

### "Provider unavailable" or "AI session missing"

**Cause**: The AI provider session is not active for AI-assisted tools.

**Solution**:
```bash
codex login
```

## Server Issues

### Server not starting

**Symptom**: No output or immediate crash

**Debug Steps**:
```bash
# 1. Check if build succeeded
npm run build

# 2. Test with help command
node dist/index.js --help

# 3. Check for errors
node dist/index.js --workspace . 2>&1 | tee server.log
```

### "Provider command failed"

**Cause**: The configured AI provider command is unavailable or session is expired.

**Solution**:
```bash
# Verify Codex CLI
codex --version

# Re-authenticate if needed
codex login
```

## Codex CLI Integration Issues

### Tools not showing up in Codex CLI

**Symptom**: MCP server not listed when running `/mcp` command

**Debug Steps**:

1. **Verify config file syntax**:
   ```bash
   # macOS/Linux
   cat ~/.codex/config.toml

   # Windows
   Get-Content "$env:USERPROFILE\.codex\config.toml"
   ```

2. **Check paths are absolute**:
   ```toml
   [mcp_servers.context-engine]
   command = "node"
   args = [
       "/absolute/path/to/context-engine/dist/index.js",
       "--workspace",
       "/absolute/path/to/your/project"
   ]
   ```

3. **Verify MCP configuration via CLI**:
   ```bash
   codex mcp list
   ```

4. **Restart Codex CLI**:
   - Exit and restart the codex command

5. **Test the server manually**:
   ```bash
   node /path/to/context-engine/dist/index.js --workspace /path/to/project
   ```

### "Server disconnected" or timeout errors

**Cause**: Server taking too long to respond or crashing

**Debug Steps**:

1. **Test server manually**:
   ```bash
   node dist/index.js --workspace /path/to/project
   ```

2. **Check for large workspace**:
   - Large codebases may need indexing first
   ```bash
   node dist/index.js --workspace /path/to/project --index
   ```

3. **Increase timeout** (if supported by client)

4. **Check system resources**:
   - Memory usage
   - CPU usage
   - Disk space

## Search and Indexing Issues

### "No results found" for valid queries

**Cause**: Workspace not indexed

**Solution**:
```bash
# Index the workspace
node dist/index.js --workspace /path/to/project --index

```

### Indexing is very slow

**Cause**: Large codebase or slow disk

**Solutions**:
- Use `.contextignore` (or `.augment-ignore` compatibility file) to exclude unnecessary files
- Exclude `node_modules`, `dist`, `build` directories
- Use SSD instead of HDD

**Create `.contextignore`**:
```
node_modules/
dist/
build/
.git/
*.log
*.tmp
```

### Search returns irrelevant results

**Cause**: Query too vague or index needs updating

**Solutions**:
- Be more specific in queries
- Re-index after major code changes
- Use `get_context_for_prompt` instead of `semantic_search`

### "File not found" errors

**Cause**: File path incorrect or file deleted

**Debug**:
```bash
# Check if file exists
ls -la /path/to/file

# Use relative path from workspace root
# Instead of: /absolute/path/to/file
# Use: relative/path/from/workspace
```

## Performance Issues

### High memory usage

**Cause**: Large context bundles or many concurrent requests

**Solutions**:
- Reduce `max_files` parameter
- Reduce `top_k` parameter
- Index smaller portions of codebase

### Slow response times

**Cause**: Large codebase or complex queries

**Solutions**:
- Pre-index workspace
- Use more specific queries
- Reduce result limits

### `create_plan` times out

**Cause**: Planning is an AI-heavy operation. Timeouts can come from (1) your MCP client tool timeout, or (2) server-side AI/request timeouts.

**Best practice fixes**:
- Make the request cheaper (faster): use smaller `max_context_files` / `context_token_budget`, set `generate_diagrams=false`, and `mvp_only=true`.
- Increase your MCP client tool timeout (`tool_timeout_sec`) for complex planning tasks.
- If needed, increase server-side timeouts:
  - `CE_AI_REQUEST_TIMEOUT_MS` (default AI call timeout)
  - `CE_PLAN_AI_REQUEST_TIMEOUT_MS` (planning-specific AI timeout)
  - `CE_HTTP_PLAN_TIMEOUT_MS` (HTTP-only plan route timeout)

### Metrics endpoint not available

**Symptoms**:
- `GET /metrics` returns 404, or
- You don't see a `[HTTP] Metrics:` line on startup

**Cause**: Metrics are opt-in and only exposed when the HTTP server is enabled.

**Solutions**:
- Start with `--http` (or `--http-only`)
- Set both environment variables:
  - `CE_METRICS=true`
  - `CE_HTTP_METRICS=true`
- Verify:
  - `curl http://localhost:3333/metrics`

## Windows-Specific Issues

### Path issues with backslashes

**Solution**: Use forward slashes or double backslashes
```json
{
  "args": [
    "C:/path/to/project/dist/index.js",
    "--workspace",
    "C:/path/to/workspace"
  ]
}
```

### PowerShell execution policy

**Symptom**: Scripts won't run

**Solution**:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## macOS-Specific Issues

### "Operation not permitted" errors

**Cause**: macOS security restrictions

**Solution**:
- Grant Terminal/iTerm full disk access in System Preferences
- System Preferences → Security & Privacy → Privacy → Full Disk Access

## Getting Help

### Enable verbose logging

Prefer enabling debug flags via environment variables (no code changes needed):

```bash
# Verbose indexing + discovery logs
export CE_DEBUG_INDEX=true

# Verbose semantic search parsing/raw output logs
export CE_DEBUG_SEARCH=true

# Tune indexing batch size (default: 10)
export CE_INDEX_BATCH_SIZE=25

# Run full-workspace indexing in a worker thread (default: enabled; set false to force in-process)
export CE_INDEX_USE_WORKER=true

# Also use the worker for large incremental batches (default threshold: 200 paths)
export CE_INDEX_FILES_WORKER_THRESHOLD=200

Note: worker-based indexing requires the built worker file (`dist/worker/IndexWorker.js`). When running from TypeScript sources (dev/tsx),
the worker uses the `tsx` loader if available; if not, indexing falls back to in-process mode to avoid startup failures in some GUI clients.

### CI: `TS5097` / “import path can only end with a '.ts' extension”

If GitHub Actions fails with:

`TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.`

It usually means a file imported another module with a `.ts` suffix (e.g. `./foo.ts`). This project’s `tsconfig.json` does not enable
`allowImportingTsExtensions`, so `.ts`-suffixed import specifiers should be avoided.

Also double-check the workflow run’s `head_sha`: sometimes you’re looking at an older `main` run before the fix was merged.

# Persist semantic search results to disk (default: enabled; disable for privacy/testing)
export CE_PERSIST_SEARCH_CACHE=true

# Persist get_context_for_prompt bundles to disk (default: enabled; disable for privacy/testing)
export CE_PERSIST_CONTEXT_CACHE=true

# Optional: per-file index state store + skip unchanged indexing (default: OFF)
# - Speeds up repeated indexing runs on large repos.
# - Requires `CE_INDEX_STATE_STORE=true`.
export CE_INDEX_STATE_STORE=false
export CE_SKIP_UNCHANGED_INDEXING=false
# Normalize EOL (CRLF vs LF) when hashing (recommended when using the state store across Windows/Linux)
export CE_HASH_NORMALIZE_EOL=false

# Watcher: when enabled, schedule a full reindex if deletions are detected (prevents stale "ghost file" results)
export CE_WATCHER_REINDEX_ON_DELETE=true
# Debounce before triggering reindex after deletions (ms)
export CE_WATCHER_REINDEX_DEBOUNCE_MS=2000
# Minimum time between auto-reindexes (ms)
export CE_WATCHER_REINDEX_COOLDOWN_MS=60000
# If deletes in a short window reach this count, reindex triggers quickly
export CE_WATCHER_DELETE_BURST_THRESHOLD=10
```

Cache files (safe to delete in the workspace when debugging):
- `.augment-search-cache.json` (semantic_search persistent cache)
- `.augment-context-cache.json` (get_context_for_prompt persistent cache)
- `.augment-index-fingerprint.json` (stable index fingerprint for cache keys)

### Benchmark performance

See `docs/BENCHMARKING.md` for `npm run bench` examples.

If you still need ad-hoc debug output, you can temporarily add logs in `src/mcp/server.ts`:

```typescript
console.error('DEBUG: Tool called:', name);
console.error('DEBUG: Arguments:', JSON.stringify(args, null, 2));
console.error('DEBUG: Result:', result);
```

### Collect diagnostic information

```bash
# System info
node --version
npm --version
codex --version

# Check installation
npm list @modelcontextprotocol/sdk
node dist/index.js --help
```

### Use MCP Inspector

```bash
npm install -g @modelcontextprotocol/inspector
mcp-inspector node dist/index.js --workspace /path/to/project
```

This opens a web interface for interactive debugging.

## Still Having Issues?

1. Check the [TESTING.md](TESTING.md) guide
2. Review [ARCHITECTURE.md](ARCHITECTURE.md) for design details
3. Check `~/.codex/config.toml` for syntax errors
4. Test with MCP Inspector
5. Verify provider session is active (`codex login`)
6. Run `codex mcp list` to check configuration

## Common Error Messages

| Error | Likely Cause | Solution |
|-------|--------------|----------|
| `ENOENT: no such file` | File path incorrect | Use absolute paths or check workspace |
| `EACCES: permission denied` | File permissions | Check file/directory permissions |
| `provider unavailable` | Provider command/session not ready | Run `codex login` and retry |
| `Invalid TOML` | Config file syntax | Validate TOML syntax in config.toml |
| `Connection refused` | Server not running | Start server first |
| `Timeout` | Server too slow | Index workspace, reduce limits |
