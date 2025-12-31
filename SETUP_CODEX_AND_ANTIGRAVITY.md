# Setup Guide: Codex CLI & Antigravity with Context Engine

This guide shows you **exactly** how to configure both Codex CLI and Antigravity to use the Context Engine MCP Server with automatic file watching.

---

## 📋 Prerequisites

1. ✅ Context Engine is built: `npm run build`
2. ✅ You're authenticated: `auggie login`
3. ✅ You know your workspace path (the project you want to index)

---

## 🔧 Setup 1: Codex CLI Configuration

### **File Location:**
```
C:\Users\preda\.codex\config.toml
```

### **Configuration to Add:**

```toml
# Context Engine MCP Server - Automatic Indexing Enabled
[mcp_servers.context-engine]
command = "node"
args = [
    "D:\\GitProjects\\context-engine\\dist\\index.js",
    "--workspace",
    "D:\\GitProjects\\YOUR-PROJECT-NAME",    # ← Change this to your project path
    "--index",                                # ← Index on startup
    "--watch"                                 # ← Auto-reindex on file changes
]

# Optional: Environment variables (if not using auggie login)
[mcp_servers.context-engine.env]
# AUGMENT_API_TOKEN = "your-token-here"
# AUGMENT_API_URL = "https://api.augmentcode.com"
```

### **Steps:**

1. **Open:** `C:\Users\preda\.codex\config.toml` in a text editor
2. **Add:** The configuration above (replace `YOUR-PROJECT-NAME` with your actual project)
3. **Save:** The file
4. **Restart:** Codex CLI

### **Verify:**
```bash
# In Codex CLI, run:
codex mcp list

# You should see:
# context-engine: connected
```

---

## 🔧 Setup 2: Antigravity Configuration

### **File Location:**
```
C:\Users\preda\.gemini\antigravity\mcp_config.json
```

### **Configuration to Add:**

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
      ]
    }
  }
}
```

### **Steps:**

1. **Open:** `C:\Users\preda\.gemini\antigravity\mcp_config.json` in a text editor
2. **Add/Replace:** The configuration above (replace `YOUR-PROJECT-NAME` with your actual project)
3. **Save:** The file
4. **Restart:** Antigravity

### **Verify:**
Check Antigravity's MCP server status - Context Engine should show as "connected"

---

## 🎯 What Each Flag Does

| Flag | Purpose | Required? |
|------|---------|-----------|
| `--workspace D:\path\to\project` | Specifies which codebase to index | ✅ **Required** |
| `--index` | Indexes all files when server starts | ⭐ **Recommended** |
| `--watch` | Automatically re-indexes when files change | ⭐ **Recommended** |

---

## 📝 Example: Multiple Projects

You can configure different instances for different projects:

### **Codex CLI (config.toml):**
```toml
[mcp_servers.context-engine-frontend]
command = "node"
args = [
    "D:\\GitProjects\\context-engine\\dist\\index.js",
    "--workspace",
    "D:\\Projects\\my-frontend",
    "--index",
    "--watch"
]

[mcp_servers.context-engine-backend]
command = "node"
args = [
    "D:\\GitProjects\\context-engine\\dist\\index.js",
    "--workspace",
    "D:\\Projects\\my-backend",
    "--index",
    "--watch"
]
```

### **Antigravity (mcp_config.json):**
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
      ]
    },
    "context-engine-backend": {
      "command": "node",
      "args": [
        "D:\\GitProjects\\context-engine\\dist\\index.js",
        "--workspace",
        "D:\\Projects\\my-backend",
        "--index",
        "--watch"
      ]
    }
  }
}
```

---

## ✅ Verification Checklist

After configuration, verify everything works:

- [ ] Codex CLI shows context-engine as connected
- [ ] Antigravity shows context-engine as connected
- [ ] Server logs show `Watcher: enabled`
- [ ] Editing a file triggers automatic re-indexing
- [ ] Search results are up-to-date

---

## 🐛 Troubleshooting

### **Server not connecting:**
1. Check paths are absolute (use `D:\\` not `D:/`)
2. Verify `dist/index.js` exists: `dir D:\GitProjects\context-engine\dist\index.js`
3. Check for syntax errors in config files
4. Prefer running the built `dist/index.js` (recommended). Running from TypeScript sources may require the `tsx` loader for worker-based indexing.

### **Watcher not working:**
1. Verify `--watch` flag is present in config
2. Check server logs for `Watcher: enabled`
3. Ensure files aren't in `.gitignore` or `.contextignore`

### **Authentication errors:**
Run `auggie login` or set environment variables in config

---

## 🎉 You're Done!

Both Codex CLI and Antigravity are now configured with:
- ✅ Automatic indexing on startup
- ✅ Automatic re-indexing on file changes
- ✅ Zero manual intervention required

**Just code, and the index stays up-to-date automatically!**
