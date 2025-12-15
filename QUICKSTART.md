# Quick Start Guide

Get your Context Engine MCP Server running in 5 minutes!

## Step 1: Install Prerequisites

```bash
# Install Auggie CLI globally
npm install -g @augmentcode/auggie

# Verify installation
auggie --version
```

## Step 2: Authenticate

```bash
# Login to Auggie (creates ~/.augment/session.json)
auggie login

# Or set environment variables
export AUGMENT_API_TOKEN="your-token"
export AUGMENT_API_URL="https://api.augmentcode.com"
```

## Step 3: Build the Server

```bash
# Navigate to the project directory
cd context-engine

# Install dependencies
npm install

# Build the TypeScript code
npm run build
```

## Step 4: Test the Server

```bash
# Test with current directory
node dist/index.js --help

# Index and start server with a specific project
node dist/index.js --workspace /path/to/your/project --index
```

## Step 5: Configure Codex CLI

Codex CLI uses TOML configuration stored in `~/.codex/config.toml`.

### Option A: Using the CLI (Recommended)

```bash
# Add the MCP server using codex mcp add
codex mcp add context-engine -- node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
```

**Important**: Replace paths with your actual paths:
- Get context-engine path by running `pwd` in this directory
- Replace workspace path with your project directory

### Option B: Editing config.toml Directly

1. Open or create the config file:

   **macOS/Linux:**
   ```bash
   mkdir -p ~/.codex
   code ~/.codex/config.toml
   ```

   **Windows:**
   ```powershell
   mkdir -Force $env:USERPROFILE\.codex
   code $env:USERPROFILE\.codex\config.toml
   ```

2. Add the MCP server configuration:

   **macOS/Linux:**
   ```toml
   [mcp_servers.context-engine]
   command = "node"
   args = [
       "/absolute/path/to/context-engine/dist/index.js",
       "--workspace",
       "/path/to/your/project"
   ]
   ```

   **Windows:**
   ```toml
   [mcp_servers.context-engine]
   command = "node"
   args = [
       "D:\\GitProjects\\context-engine\\dist\\index.js",
       "--workspace",
       "D:\\GitProjects\\your-project"
   ]
   ```

## Step 5B: Configure Other MCP Clients (Antigravity, Claude Desktop, Cursor)

If you're using a different MCP client instead of (or in addition to) Codex CLI, follow the instructions below for your specific client.

> **Note:** All MCP clients use the same server command format:
> ```
> node /absolute/path/to/context-engine/dist/index.js --workspace /path/to/your/project
> ```
> The transport type is **stdio** (standard input/output), not HTTP.

---

### Antigravity

Antigravity uses a JSON configuration file for MCP servers.

#### Configuration File Location

| Platform | Path |
|----------|------|
| **macOS** | `~/Library/Application Support/Antigravity/config.json` |
| **Windows** | `%APPDATA%\Antigravity\config.json` |
| **Linux** | `~/.config/antigravity/config.json` |

#### Setup Steps

1. **Open or create the configuration file:**

   **macOS/Linux:**
   ```bash
   mkdir -p ~/Library/Application\ Support/Antigravity  # macOS
   # OR
   mkdir -p ~/.config/antigravity  # Linux

   code ~/Library/Application\ Support/Antigravity/config.json  # macOS
   # OR
   code ~/.config/antigravity/config.json  # Linux
   ```

   **Windows (PowerShell):**
   ```powershell
   mkdir -Force "$env:APPDATA\Antigravity"
   code "$env:APPDATA\Antigravity\config.json"
   ```

2. **Add the MCP server configuration:**

   **macOS/Linux:**
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

   **Windows:**
   ```json
   {
     "mcpServers": {
       "context-engine": {
         "command": "node",
         "args": [
           "D:\\GitProjects\\context-engine\\dist\\index.js",
           "--workspace",
           "D:\\GitProjects\\your-project"
         ]
       }
     }
   }
   ```

3. **Save the file and restart Antigravity**

#### Verify Connection

1. Open Antigravity
2. Check the MCP servers panel or settings
3. Verify `context-engine` appears with these tools:
   - `semantic_search`
   - `get_file`
   - `get_context_for_prompt`
   - `enhance_prompt`
   - `index_workspace`

---

### Claude Desktop

Claude Desktop uses a JSON configuration file for MCP servers.

#### Configuration File Location

| Platform | Path |
|----------|------|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |

#### Setup Steps

1. **Open or create the configuration file:**

   **macOS:**
   ```bash
   mkdir -p ~/Library/Application\ Support/Claude
   code ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

   **Windows (PowerShell):**
   ```powershell
   mkdir -Force "$env:APPDATA\Claude"
   code "$env:APPDATA\Claude\claude_desktop_config.json"
   ```

2. **Add the MCP server configuration:**

   **macOS:**
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

   **Windows:**
   ```json
   {
     "mcpServers": {
       "context-engine": {
         "command": "node",
         "args": [
           "D:\\GitProjects\\context-engine\\dist\\index.js",
           "--workspace",
           "D:\\GitProjects\\your-project"
         ]
       }
     }
   }
   ```

3. **Save the file and restart Claude Desktop**

#### Verify Connection

1. Open Claude Desktop
2. Look for the MCP icon (hammer/tools icon) in the chat interface
3. Click it to see available tools from `context-engine`
4. Try asking Claude: "Use the semantic_search tool to find authentication code"

---

### Cursor

Cursor IDE supports MCP servers through its settings.

#### Configuration File Location

| Platform | Path |
|----------|------|
| **macOS** | `~/.cursor/mcp.json` |
| **Windows** | `%USERPROFILE%\.cursor\mcp.json` |
| **Linux** | `~/.cursor/mcp.json` |

#### Setup Steps

1. **Open or create the configuration file:**

   **macOS/Linux:**
   ```bash
   mkdir -p ~/.cursor
   code ~/.cursor/mcp.json
   ```

   **Windows (PowerShell):**
   ```powershell
   mkdir -Force "$env:USERPROFILE\.cursor"
   code "$env:USERPROFILE\.cursor\mcp.json"
   ```

2. **Add the MCP server configuration:**

   **macOS/Linux:**
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

   **Windows:**
   ```json
   {
     "mcpServers": {
       "context-engine": {
         "command": "node",
         "args": [
           "D:\\GitProjects\\context-engine\\dist\\index.js",
           "--workspace",
           "D:\\GitProjects\\your-project"
         ]
       }
     }
   }
   ```

3. **Save the file and restart Cursor**

#### Verify Connection

1. Open Cursor IDE
2. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
3. Search for "MCP" to see MCP-related commands
4. Verify `context-engine` tools are available

---

### Generic MCP Client Configuration

For any MCP client not listed above, use this general pattern:

1. **Find your client's MCP configuration file** (check the client's documentation)

2. **Add this server entry** (JSON format):
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

3. **Key requirements:**
   - Use **absolute paths** (not relative)
   - Transport: **stdio** (not HTTP)
   - The server exposes 5 tools: `semantic_search`, `get_file`, `get_context_for_prompt`, `enhance_prompt`, `index_workspace`

4. **Restart your MCP client** after configuration changes

---

## Step 6: Restart Codex CLI

If Codex is running, exit and restart it:

```bash
# Start Codex CLI fresh
codex
```

## Step 7: Verify Connection

1. Launch Codex CLI: `codex`
2. In the TUI, type `/mcp` to see connected MCP servers
3. You should see `context-engine` listed with available tools:
   - `semantic_search`
   - `get_file`
   - `get_context_for_prompt`

## Step 8: Try It Out!

### Basic Context Queries

Ask Codex:

- "Search for authentication logic in the codebase"
- "Get context about the database schema"
- "Show me the main entry point file"
- "Find error handling patterns"

### Planning and Execution (v1.4.0+)

Try the new planning features:

- "Create a plan to implement user authentication"
- "Create a plan to add a new API endpoint for user profiles"
- "Show me the saved plans"
- "Start executing step 1 of plan_abc123"
- "What's the progress on plan_abc123?"

## Troubleshooting

### Tools not showing up in /mcp

```bash
# Verify your config.toml is correct
cat ~/.codex/config.toml

# Verify server builds correctly
npm run build

# Test server manually
node dist/index.js --workspace . --index

# Check for configuration errors
codex mcp list
```

### Authentication errors

```bash
# Re-authenticate
auggie login

# Or check environment variables
echo $AUGMENT_API_TOKEN
```

### No search results

```bash
# Index your workspace first
node dist/index.js --workspace /path/to/project --index

# Or use auggie CLI directly
auggie index /path/to/project
```

## Next Steps

- Read [README.md](README.md) for detailed documentation
- Review [plan.md](plan.md) for architecture details
- Explore the source code in `src/mcp/`

## Common Use Cases

### 1. Code Understanding
"Get context about how authentication works in this codebase"

### 2. Bug Investigation
"Search for error handling in the payment processing module"

### 3. Feature Development
"Show me examples of API endpoint implementations"

### 4. Code Review
"Find all database query patterns in the codebase"

### 5. Implementation Planning (v1.4.0+)
"Create a detailed plan to implement JWT authentication with refresh tokens"

### 6. Execution Tracking (v1.4.0+)
"Start executing the authentication plan step by step and track progress"

## Tips

1. **Be specific** in your queries for better results
2. **Use get_context_for_prompt** for comprehensive context
3. **Index regularly** if your codebase changes frequently
4. **Check logs** if something doesn't work

Happy coding! 🚀

