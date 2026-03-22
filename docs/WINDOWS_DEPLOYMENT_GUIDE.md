# Windows Deployment Guide (Beginner-Friendly, Full)

This is a complete, step-by-step Windows deployment manual for the Context Engine MCP Server. It is written for beginners and covers installation, configuration, verification, and maintenance.

> **Shorter references:** `docs/archive/QUICKSTART.md`, `docs/archive/GET_STARTED.md`, and `docs/WINDOWS_SERVER_MANAGEMENT.md`.

---

## 1) What You’re Setting Up (Quick Map)

```
Windows PC
   │
   ├─ Node.js + npm
   ├─ Context Engine (this repo)
   └─ MCP Client (Codex CLI)
          │
          └─ Connects via stdio to:
             C:\path\to\context-engine\dist\index.js
```

You’ll install prerequisites, build the server, register it once with Codex CLI, and then reuse that setup across repos.

---

## 2) Fast Path (If You Want the Shortest Route)

1. Install Node.js 18+
2. `npm install -g @openai/codex`
3. `npm install`
4. `npm run build`
5. Set `CE_AI_PROVIDER=openai_session` and run `codex login`
6. `codex mcp add context-engine -- node "C:\path\to\context-engine\dist\index.js"`
7. Open Codex CLI from the repo you want to inspect
8. Start Codex CLI -> `/mcp` -> run a test query

If any step fails, follow the detailed walkthrough below.

---

## 3) System Requirements (Windows)

- **Windows 10/11** (Windows 7+ may work but is not recommended)
- **Node.js 18+**
- **Internet access** (for installing dependencies and authentication)
- **Disk space**: ~1–2 GB for node_modules + build output

---

## 4) Install Prerequisites (One-Time Setup)

### 4.1 Install Node.js (v18+)
1. Download the **LTS** version from the official Node.js site.
2. During installation, keep “Add to PATH” checked.
3. Verify in PowerShell:
   ```powershell
   node --version
   npm --version
   ```
   **Expected:** Node `v18.x.x` or higher and npm prints a version.

**If `node` isn’t found:** close PowerShell and open a new one.

### 4.2 (Optional) Install Git
```powershell
git --version
```
If Git isn’t installed, you can download the repository as a ZIP file instead.

### 4.3 Install Codex CLI (for MCP integration)
```powershell
npm install -g @openai/codex
codex --version
```

---

## 5) Get the Project

### Option A: Clone with Git (Recommended)
```powershell
cd C:\path\to\projects
git clone <REPO_URL> context-engine
cd context-engine
```

### Option B: Download ZIP
1. Download the repo ZIP.
2. Extract it to: `C:\path\to\context-engine`
3. Open PowerShell:
   ```powershell
   cd C:\path\to\context-engine
   ```

---

## 5.1) Find Your Absolute Path (One-Time)

You’ll need the full path to this folder.

```powershell
pwd
```

**Example output:**
```
Path
----
C:\path\to\context-engine
```

## 6) Install Dependencies

```powershell
npm install
```
**Expected:** Packages install without errors.

---

## 7) Build the Server

```powershell
npm run build
```
**Expected:** A `dist\index.js` file appears.

---

## 8) Configure Retrieval Provider (OpenAI Session First)

### Option A (Recommended): OpenAI session provider
```powershell
$env:CE_AI_PROVIDER = "openai_session"
$env:CE_OPENAI_SESSION_CMD = "cmd"
$env:CE_OPENAI_SESSION_ARGS_JSON = "[`"/d`",`"/s`",`"/c`",`"D:\\npm-global\\codex.cmd`"]"
codex login
codex login status
```
Or use `.env`:
```powershell
copy .env.example .env
notepad .env
```
Set values:
```
CE_AI_PROVIDER=openai_session
CE_OPENAI_SESSION_CMD=cmd
CE_OPENAI_SESSION_ARGS_JSON=["/d","/s","/c","D:\\npm-global\\codex.cmd"]
```

> Tip: `.env` is easiest for beginners; environment variables are for advanced setups.

---

## 9) Verify the Server Builds

```powershell
node dist\index.js --help
```
**Expected:** Help output with CLI options.

---

## 10) Repo-Aware Startup

Context Engine now chooses its workspace at startup like this:
- explicit `--workspace` wins
- otherwise it uses the current working directory
- if you launch from a nested folder inside a git repo, it falls back to the nearest git root
- if no git root exists, it stays on the current folder and logs a warning

That means the normal day-to-day flow is:
1. register the MCP server once
2. open the repo you want to work in
3. let the server resolve the workspace automatically

Use `--workspace "C:\path\to\repo"` only when you want to force a specific repo.

If startup auto-index is enabled:
- missing or stale workspaces start background indexing automatically
- the server still starts first
- the first query may be slower until indexing finishes

You can disable startup auto-index with:

```powershell
$env:CE_AUTO_INDEX_ON_STARTUP = "false"
```

---

## 11) Start the Server Manually (Windows Script)

```powershell
.\manage-server.bat start
```

**Expected output (example):**
```
[INFO] Starting Context Engine MCP Server...
[INFO] Workspace: C:\path\to\context-engine\.
[INFO] Indexing: Enabled
[INFO] File watching: Enabled
[INFO] Log file: C:\path\to\context-engine\.server.log
[SUCCESS] Server started with PID: 12345
```

### Check Status
```powershell
.\manage-server.bat status
```

### Stop the Server
```powershell
.\manage-server.bat stop
```

For full script usage and log tips, see `docs/WINDOWS_SERVER_MANAGEMENT.md`.

---

## 12) Configure Codex CLI (MCP Client)

### Option A: Add via CLI (Recommended)
```powershell
codex mcp add context-engine -- node "C:\path\to\context-engine\dist\index.js"
```
This registers Context Engine once. After that, open any repo and let the server resolve the workspace automatically. Use `--workspace "C:\path\to\your-project"` only when you want to force a specific repo.

If startup auto-index feels too heavy on a large repo, add this to the client environment block later:

```toml
CE_AUTO_INDEX_ON_STARTUP = "false"
```

### Option B: Edit config.toml directly
1. Open config:
   ```powershell
   mkdir -Force $env:USERPROFILE\.codex
   notepad $env:USERPROFILE\.codex\config.toml
   ```
2. Add:
   ```toml
   [mcp_servers.context-engine]
   command = "node"
   args = [
       "C:\\path\\to\\context-engine\\dist\\index.js"
   ]
   ```
3. (Optional) Add environment settings under the same block:
   ```toml
   [mcp_servers.context-engine.env]
   # Core indexing + caching
   CE_INDEX_STATE_STORE = "true"
   CE_SKIP_UNCHANGED_INDEXING = "true"
   CE_TOOL_RESPONSE_CACHE = "true"
   CE_INTERNAL_REQUEST_CACHE = "true"
   CE_METRICS = "true"
   CE_HTTP_METRICS = "true"
   # CE_HASH_NORMALIZE_EOL = "true"

   # Auth (replace with real values)
   CE_AI_PROVIDER = "openai_session"
   CE_OPENAI_SESSION_CMD = "codex"

   # Startup behavior
   CE_AUTO_INDEX_ON_STARTUP = "true"

   # Reactive Review Configuration
   REACTIVE_ENABLED = "true"
   REACTIVE_PARALLEL_EXEC = "true"
   REACTIVE_COMMIT_CACHE = "true"
   REACTIVE_SQLITE_BACKEND = "true"
   REACTIVE_GUARDRAILS = "true"
   REACTIVE_USE_AI_AGENT_EXECUTOR = "true"
   REACTIVE_ENABLE_MULTILAYER_CACHE = "true"
   REACTIVE_ENABLE_BATCHING = "true"

   # Tuning Parameters
   REACTIVE_BATCH_SIZE = "5"
   REACTIVE_MAX_WORKERS = "5"
   REACTIVE_OPTIMIZE_WORKERS = "true"
   REACTIVE_TOKEN_BUDGET = "10000"
   REACTIVE_CACHE_TTL = "300000"
   REACTIVE_STEP_TIMEOUT = "60000"
   REACTIVE_MAX_RETRIES = "2"
   REACTIVE_SESSION_TTL = "3600000"
   REACTIVE_MAX_SESSIONS = "100"
   REACTIVE_EXECUTION_TIMEOUT = "600000"
   ```
4. Save the file.
> Note: If you set `CE_HTTP_METRICS = "true"`, you must also start the server with `--http` to expose metrics. See `README.md` for details.

> If you want to force a specific workspace from this one-time setup, add `--workspace "C:\\path\\to\\your-project"` once. Do not create separate per-repo config entries.

### Quick Explanation of the Optional Settings

| Setting | What it does | Beginner note |
|---------|---------------|---------------|
| `CE_INDEX_STATE_STORE` | Stores per-file hashes to speed up reindexing | Good default for larger repos |
| `CE_SKIP_UNCHANGED_INDEXING` | Skips files that haven’t changed | Requires `CE_INDEX_STATE_STORE=true` |
| `CE_TOOL_RESPONSE_CACHE` | Caches tool responses across runs | Faster repeated queries |
| `CE_INTERNAL_REQUEST_CACHE` | Caches work inside a single request | Safe performance boost |
| `CE_METRICS` | Enables internal metrics collection | No effect unless you read metrics |
| `CE_HTTP_METRICS` | Exposes `/metrics` over HTTP | Requires `--http` when starting |
| `CE_HASH_NORMALIZE_EOL` | Normalizes CRLF/LF when hashing | Helpful on mixed Windows/Linux teams |
| `CE_AI_PROVIDER` | Active AI provider | Set to `openai_session` |
| `CE_OPENAI_SESSION_CMD` | Command used for session provider | Default is `codex` |
| `CE_AUTO_INDEX_ON_STARTUP` | Background-index missing or stale workspaces on startup | Set to `false` to opt out |
| `REACTIVE_ENABLED` | Turns on reactive review features | Required for reactive review tools |
| `REACTIVE_PARALLEL_EXEC` | Runs reactive steps in parallel | Faster on multi-core CPUs |
| `REACTIVE_COMMIT_CACHE` | Caches by commit hash | Better cache consistency |
| `REACTIVE_SQLITE_BACKEND` | Persists session state in SQLite | Helps with recovery |
| `REACTIVE_GUARDRAILS` | Adds validation/guardrails | Safer reactive reviews |
| `REACTIVE_USE_AI_AGENT_EXECUTOR` | Use local AI agent execution | Boosts speed if supported |
| `REACTIVE_ENABLE_MULTILAYER_CACHE` | Enables multi-layer caching | Improves repeat performance |
| `REACTIVE_ENABLE_BATCHING` | Batches review work | Faster for large PRs |
| `REACTIVE_BATCH_SIZE` | Number of items per batch | Adjust if reviews are slow |
| `REACTIVE_MAX_WORKERS` | Max parallel workers | Start with 4–6 |
| `REACTIVE_OPTIMIZE_WORKERS` | Auto-tunes worker count | Good default |
| `REACTIVE_TOKEN_BUDGET` | Max tokens per review session | Increase for large reviews |
| `REACTIVE_CACHE_TTL` | Cache time-to-live (ms) | 300000 = 5 minutes |
| `REACTIVE_STEP_TIMEOUT` | Step timeout (ms) | 60000 = 1 minute |
| `REACTIVE_MAX_RETRIES` | Retry count for failed steps | 1–2 recommended |
| `REACTIVE_SESSION_TTL` | Session cleanup TTL (ms) | 3600000 = 1 hour |
| `REACTIVE_MAX_SESSIONS` | Max sessions in memory | Avoids memory bloat |
| `REACTIVE_EXECUTION_TIMEOUT` | Zombie session timeout (ms) | 600000 = 10 minutes |

---

## 13) Verify MCP Connection

1. Start Codex CLI:
   ```powershell
   codex
   ```
2. In the Codex TUI, type:
   ```
   /mcp
   ```
3. Confirm `context-engine` is listed with tools like:
   - `semantic_search`
   - `get_file`
   - `get_context_for_prompt`
4. Open the repo you want to inspect before running queries so the server can resolve the workspace automatically.

---

## 14) First Test Query

In Codex CLI, try:
```
Search for authentication logic in the codebase
```
If startup says indexing is running, wait for it to finish or trigger `index_workspace`. If results appear after that, your deployment works.

---

## 15) Ongoing Use (Updates & Maintenance)

### Update the Project
```powershell
git pull
npm install
npm run build
.\manage-server.bat restart
```

### Rebuild After Code Changes
```powershell
npm run build
.\manage-server.bat restart
```

### Check Logs
```powershell
Get-Content .server.log -Tail 50
```

---

## 16) Uninstall / Cleanup (Optional)

```powershell
.\manage-server.bat stop
```
Then delete the project folder (`C:\path\to\context-engine`).

To remove global tools:
```powershell
npm uninstall -g @openai/codex
```

---

## 17) Troubleshooting (Beginner-Friendly)

### “node” or “npm” not found
```powershell
where node
where npm
```
If nothing appears, reinstall Node.js and reopen PowerShell.

### `npm install` fails
- Try running PowerShell as Administrator.
- If you see proxy or SSL errors, your network may be blocking npm.

### Build files missing
```powershell
dir dist\index.js
```
If missing:
```powershell
npm run build
```

### Authentication errors
```powershell
codex login
codex login status
```

### Server won’t start
Check logs:
```powershell
Get-Content .server.log -Tail 50
```

### Tools don’t show in Codex CLI
1. If you used `codex mcp add`, run:
   ```powershell
   codex mcp list
   ```
2. If you edited `config.toml` manually, verify the paths are correct and absolute.
3. Restart Codex CLI.
4. Run:
   ```powershell
   codex mcp list
   ```

### Server starts but searches are empty
1. Confirm you opened Codex inside the repo you want to inspect.
2. If the repo is large, give startup indexing time to finish.
3. Check whether startup auto-index was disabled with `CE_AUTO_INDEX_ON_STARTUP=false`.
4. Run `index_workspace` manually if you want to force the first build.

### Wrong repo was selected
1. Start Codex from the correct repo folder.
2. If you want a fixed workspace every time, register with:
   ```powershell
   codex mcp add context-engine -- node "C:\path\to\context-engine\dist\index.js" --workspace "C:\path\to\your-project"
   ```
3. Restart Codex CLI.

### Firewall or permission prompts
Allow Node.js when prompted. This server uses **stdio** (no open ports), but Windows may still prompt.

---

## 18) Glossary (Beginner Terms)

- **MCP Server**: A local process that provides tools to your coding assistant.
- **stdio**: Standard input/output; how MCP clients talk to servers.
- **Workspace**: The folder you want Context Engine to index and search.

---

## 19) See Also

- `docs/archive/QUICKSTART.md` — Quick overview
- `docs/archive/GET_STARTED.md` — Full setup checklist
- `docs/WINDOWS_SERVER_MANAGEMENT.md` — Server start/stop/logs
- `docs/archive/TROUBLESHOOTING.md` — Common issues
