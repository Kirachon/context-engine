# 🚀 Quick Setup Instructions for Codex & Antigravity

## ⚡ Super Fast Setup (3 Steps)

### **Step 1: Choose Your Project**
Decide which project you want to index. For example:
- `D:\GitProjects\my-app`
- `D:\Projects\my-website`
- `C:\code\my-project`

### **Step 2: Configure Codex CLI**

**File:** `C:\Users\preda\.codex\config.toml`

**Copy this (replace YOUR-PROJECT-NAME):**
```toml
[mcp_servers.context-engine]
command = "node"
args = [
    "D:\\GitProjects\\context-engine\\dist\\index.js",
    "--workspace",
    "D:\\GitProjects\\YOUR-PROJECT-NAME",
    "--index",
    "--watch"
]
```

### **Step 3: Configure Antigravity**

**File:** `C:\Users\preda\.gemini\antigravity\mcp_config.json`

**Copy this (replace YOUR-PROJECT-NAME):**
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

---

## ✅ That's It!

**Restart both Codex CLI and Antigravity, and you're done!**

---

## 📋 What You Get

- ✅ **Automatic indexing** when server starts
- ✅ **Automatic re-indexing** when you edit files
- ✅ **Zero manual intervention** required
- ✅ **Always up-to-date** search results

---

## 🎯 Example: If Your Project is at `D:\Projects\my-app`

### **Codex config.toml:**
```toml
[mcp_servers.context-engine]
command = "node"
args = [
    "D:\\GitProjects\\context-engine\\dist\\index.js",
    "--workspace",
    "D:\\Projects\\my-app",
    "--index",
    "--watch"
]
```

### **Antigravity mcp_config.json:**
```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": [
        "D:\\GitProjects\\context-engine\\dist\\index.js",
        "--workspace",
        "D:\\Projects\\my-app",
        "--index",
        "--watch"
      ]
    }
  }
}
```

---

## 🔍 Verify It's Working

### **In Codex CLI:**
```bash
codex mcp list
# Should show: context-engine: connected
```

### **In Antigravity:**
Check the MCP servers panel - Context Engine should show as "connected"

### **Check Server Logs:**
You should see:
```
Context Engine MCP Server
================================================================================
Workspace: D:\Projects\my-app
Watcher: enabled    ← This confirms automatic indexing is ON
```

---

## 🎉 Done!

Now both Codex CLI and Antigravity will:
1. Index your project when they start
2. Automatically re-index when you edit files
3. Always give you up-to-date search results

**No manual indexing needed ever again!** 🚀

