# 🚀 Setting Up Context Engine with Gemini CLI

## 📋 Prerequisites

Before you begin, ensure you have:

1. ✅ **Context Engine built** - Server at `D:\GitProjects\context-engine\dist\index.js`
2. ✅ **Node.js 20+** installed
3. ✅ **Gemini CLI** installed (see below if not)
4. ✅ **Provider session ready (if needed for AI-assisted flows)** - Run `codex login`

---

## ⚡ Quick Setup (3 Steps)

### **Step 1: Install Gemini CLI**

If you don't have Gemini CLI installed yet:

```bash
# Option A: Using npm (global installation)
npm install -g @google/gemini-cli

# Option B: Using Homebrew (macOS/Linux)
brew install gemini-cli

# Verify installation
gemini --version
```

### **Step 2: Configure Gemini CLI**

**File Location:** `C:\Users\preda\.gemini\settings.json`

**Create the directory and file:**

```powershell
# Create directory if it doesn't exist
mkdir -Force $env:USERPROFILE\.gemini

# Open in your editor
code $env:USERPROFILE\.gemini\settings.json
```

**Copy the configuration from `examples/mcp-clients/gemini_settings_READY_TO_USE.json` or use this minimal version:**

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "D:\\GitProjects\\context-engine\\dist\\index.js",
        "--workspace",
        "D:\\GitProjects\\YOUR-PROJECT-NAME",
        "--index",
        "--watch"
      ],
      "env": {
        "DEBUG": "true"
      },
      "timeout": 30000,
      "trust": false,
      "description": "Context Engine MCP Server"
    }
  }
}
```

**⚠️ IMPORTANT:** Replace `YOUR-PROJECT-NAME` with your actual project folder name!

**Example:** If your project is at `D:\Projects\my-website`, change the line to:
```json
"D:\\Projects\\my-website",
```

### **Step 3: Optional Provider Login**

Most retrieval/indexing tools run locally and do not need legacy tokens.

If you use AI-assisted tools, log in once:
```bash
codex login
```

---

## ✅ Verification

### **1. List MCP Servers**

```bash
gemini mcp list
```

**Expected output:**
```
✓ context-engine: command: node D:\GitProjects\context-engine\dist\index.js (stdio) - Connected
```

### **2. Check MCP Status in CLI**

```bash
# Start Gemini CLI
gemini

# Inside the CLI, run:
> /mcp
```

**You should see:**
- Server: `context-engine`
- Status: `CONNECTED`
- Available tools:
  - `index_workspace`
  - `semantic_search`
  - `get_context_for_prompt`
  - `create_plan`
  - `get_file`
  - `list_files`
  - And more...

---

## 🎯 Usage Examples

Once configured, you can use Context Engine tools naturally in conversation:

```
> Index my current workspace

> Search for authentication code

> Create a plan to add JWT authentication

> Get context for implementing user login

> Show me the package.json file
```

---

## 🔧 Configuration Options

### **Command Line Flags**

| Flag | Purpose | Required? |
|------|---------|-----------|
| `--workspace D:\path\to\project` | Specifies which codebase to index | ✅ **Required** |
| `--index` | Indexes all files when server starts | ⭐ **Recommended** |
| `--watch` | Auto-reindexes when files change | ⭐ **Recommended** |

### **Settings Properties**

| Property | Description | Required? |
|----------|-------------|-----------|
| `command` | Executable to run (`node`) | ✅ Yes |
| `args` | Array of arguments | ✅ Yes |
| `env` | Environment variables | ⭐ Recommended |
| `timeout` | Request timeout in ms (default: 30000) | ❌ Optional |
| `trust` | Bypass tool confirmations | ❌ Optional |
| `description` | Human-readable description | ❌ Optional |

---

## 📝 Multiple Projects

To index multiple projects, add more servers to `mcpServers`:

```json
{
  "mcpServers": {
    "context-engine-frontend": {
      "command": "node",
      "args": [
        "D:\\GitProjects\\context-engine\\dist\\index.js",
        "--workspace",
        "D:\\Projects\\my-frontend",
        "--index",
        "--watch"
      ],
      "env": {
        "DEBUG": "true"
      },
      "timeout": 30000,
      "description": "Context Engine for Frontend"
    },
    "context-engine-backend": {
      "command": "node",
      "args": [
        "D:\\GitProjects\\context-engine\\dist\\index.js",
        "--workspace",
        "D:\\Projects\\my-backend",
        "--index",
        "--watch"
      ],
      "env": {
        "DEBUG": "true"
      },
      "timeout": 30000,
      "description": "Context Engine for Backend"
    }
  }
}
```

---

## 🔍 Troubleshooting

### **Server Won't Connect**

1. **Verify the path is correct:**
   ```bash
   node "D:\GitProjects\context-engine\dist\index.js"
   ```

2. **Check if the server is built:**
   ```bash
   cd D:\GitProjects\context-engine
   npm run build
   ```

3. **Enable debug mode:**
   ```bash
   gemini --debug
   ```

4. **Check server logs** - Look for error messages in the CLI output

### **No Tools Discovered**

1. Verify your server implements MCP protocol correctly
2. Check that tools are registered in your server code
3. Review server stderr output for errors
4. Try running the server standalone to test:
   ```bash
   node dist/index.js --workspace . --index
   ```

### **Tools Not Executing**

1. Check parameter validation - ensure your tools accept expected parameters
2. Verify schema compatibility - ensure input schemas are valid JSON Schema
3. Increase timeout if operations are slow:
   ```json
   {
     "mcpServers": {
       "context-engine": {
         "timeout": 60000
       }
     }
   }
   ```

### **Authentication Errors**

**Error:** `Provider unavailable` or AI-assisted prompt enhancement fails

**Solution:**
```bash
codex login
```

### **No Search Results**

**Cause:** Workspace not indexed

**Solution:**
```bash
# Index your workspace first
node dist/index.js --workspace D:\GitProjects\YOUR-PROJECT --index
```

### **File Watcher Not Working**

1. Ensure you started the server with `--watch` flag
2. Check that the file is not in `.gitignore` or `.contextignore`
3. Wait for the debounce period (default: 500ms) after the last change
4. Check server logs for watcher status messages

---

## 🎯 Tool Confirmation Behavior

By default, Gemini CLI will ask for confirmation before executing tools.

### **Options When Prompted:**

1. **Approve once** - Execute this time only
2. **Always allow this tool** - Add to tool-level allowlist
3. **Always allow this server** - Add to server-level allowlist
4. **Cancel** - Abort execution

### **Bypass All Confirmations (Use Cautiously!)**

Set `trust: true` in your configuration:

```json
{
  "mcpServers": {
    "context-engine": {
      "trust": true
    }
  }
}
```

**⚠️ WARNING:** Only do this for servers you completely control!

---

## 📚 Additional Resources

- [Gemini CLI Documentation](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI MCP Server Integration](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- [Gemini CLI Configuration Guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md)
- [Context Engine Documentation](./README.md)
- [Context Engine Examples](./docs\archive\EXAMPLES.md)

---

## 🔗 Comparison with Other CLIs

| CLI | Config File | Location |
|-----|-------------|----------|
| **Codex CLI** | `config.toml` | `~/.codex/config.toml` |
| **Antigravity** | `mcp_config.json` | `~/.gemini/antigravity/mcp_config.json` |
| **Gemini CLI** | `settings.json` | `~/.gemini/settings.json` |

**Note:** The `mcpServers` structure is very similar between Antigravity and Gemini CLI!

---

## 📋 Quick Reference

### **File Locations**

| Configuration | File Path |
|---------------|-----------|
| **User-level** | `C:\Users\preda\.gemini\settings.json` |
| **Project-level** | `.gemini\settings.json` (in project directory) |

### **Common Commands**

```bash
# List MCP servers
gemini mcp list

# Start Gemini CLI
gemini

# Start with debug mode
gemini --debug

# Check version
gemini --version

# Show help
gemini --help
```

### **In-CLI Commands**

```bash
# Show MCP server status
/mcp

# Show help
/help

# Show memory/context
/memory show

# Refresh memory/context
/memory refresh
```

---

## ✨ Summary

**Quick Setup (3 commands):**

```bash
# 1. Install Gemini CLI
npm install -g @google/gemini-cli

# 2. Create configuration directory
mkdir -Force $env:USERPROFILE\.gemini

# 3. Copy examples/mcp-clients/gemini_settings_READY_TO_USE.json to settings.json
# Then replace YOUR-PROJECT-NAME with your actual project

# 4. Verify and start using
gemini mcp list
gemini
```

Your Context Engine MCP Server is now integrated with Gemini CLI! 🎉

---

## 📝 Next Steps

1. ✅ **Test the connection** - Run `gemini mcp list`
2. ✅ **Start using it** - Run `gemini` and try some queries
3. ✅ **Explore available tools** - Use `/mcp` command in the CLI
4. ✅ **Index your workspace** - Let Context Engine analyze your codebase
5. ✅ **Try semantic search** - Search for code patterns and concepts
6. ✅ **Create plans** - Use the planning tools for complex tasks

Happy coding! 🚀
