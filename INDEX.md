# Context Engine MCP Server - Documentation Index

Welcome to the Context Engine MCP Server! This index will help you find the right documentation for your needs.

## 🚀 Getting Started

**New to this project?** Start here:

1. **[QUICKSTART.md](QUICKSTART.md)** - Get running in 5 minutes
   - Installation steps
   - Authentication setup
   - Codex CLI configuration
   - Claude Code / Antigravity client setup
   - First queries

2. **[README.md](README.md)** - Project overview
   - What this project does
   - Key features
   - Architecture diagram
   - Usage examples

3. **[docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)** - Full Windows deployment manual
   - Step-by-step beginner guide
   - Windows-specific commands
   - Troubleshooting and maintenance

## 📚 Core Documentation

### For Users

- **[QUICKSTART.md](QUICKSTART.md)** - Fast setup guide
- **[docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md)** - Client-by-client setup (Codex, Claude Code, Antigravity, Claude Desktop, Cursor)
- **[README.md](README.md)** - Complete user guide
- **[docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md)** - Full Windows deployment manual
- **[docs/MEMORY_OPERATIONS_RUNBOOK.md](docs/MEMORY_OPERATIONS_RUNBOOK.md)** - Memory quality, cleanup, and release health checks
- **[EXAMPLES.md](EXAMPLES.md)** - Real-world usage examples
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Common issues and solutions
- **[TESTING.md](TESTING.md)** - How to test the server

### For Developers

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Detailed architecture documentation
- **[plan.md](plan.md)** - Original architectural plan
- **[PROJECT_SUMMARY.md](PROJECT_SUMMARY.md)** - Implementation summary
- **[CHANGELOG.md](CHANGELOG.md)** - Version history

## 🎯 Quick Navigation

### I want to...

#### Install and Run
→ [QUICKSTART.md](QUICKSTART.md) - Steps 1-4

#### Deploy on Windows (Beginner-Friendly)
→ [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md) - Full walkthrough

#### Configure Codex CLI
→ [QUICKSTART.md](QUICKSTART.md) - Step 5

#### Configure Other MCP Clients (Claude Code, Antigravity, Claude Desktop, Cursor)
→ [QUICKSTART.md](QUICKSTART.md) - Step 5B
→ [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md) - Full client guide

#### Understand the Architecture
→ [ARCHITECTURE.md](ARCHITECTURE.md) - Full details
→ [README.md](README.md) - Quick overview

#### Fix a Problem
→ [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues
→ [TESTING.md](TESTING.md) - Debugging strategies

#### Add New Features
→ [ARCHITECTURE.md](ARCHITECTURE.md) - Extension points
→ [plan.md](plan.md) - Design principles

#### Test the Server
→ [TESTING.md](TESTING.md) - Testing guide
→ Run `npm run verify` - Setup verification

#### See Usage Examples
→ [EXAMPLES.md](EXAMPLES.md) - Real-world examples
→ [QUICKSTART.md](QUICKSTART.md) - Step 8

## 📖 Documentation Files

| File | Purpose | Audience |
|------|---------|----------|
| [README.md](README.md) | Project overview and usage | Everyone |
| [QUICKSTART.md](QUICKSTART.md) | 5-minute setup guide | New users |
| [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md) | MCP client setup by platform/client | New users |
| [docs/WINDOWS_DEPLOYMENT_GUIDE.md](docs/WINDOWS_DEPLOYMENT_GUIDE.md) | Full Windows deployment manual | Windows users |
| [docs/MEMORY_OPERATIONS_RUNBOOK.md](docs/MEMORY_OPERATIONS_RUNBOOK.md) | Memory governance and maintenance | Operators & Maintainers |
| [EXAMPLES.md](EXAMPLES.md) | Real-world usage examples | Users |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Detailed architecture | Developers |
| [TESTING.md](TESTING.md) | Testing strategies | Users & Developers |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Problem solving | Users |
| [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) | Implementation status | Project managers |
| [CHANGELOG.md](CHANGELOG.md) | Version history | Everyone |
| [plan.md](plan.md) | Original design plan | Architects |

## 🛠️ Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | NPM dependencies and scripts |
| `tsconfig.json` | TypeScript configuration |
| `.gitignore` | Git ignore patterns |
| `.env.example` | Environment variable template |
| `codex_config.example.toml` | Codex CLI config template |
| `verify-setup.js` | Setup verification script |

## 📁 Source Code Structure

```
src/
├── index.ts                    # Entry point
└── mcp/
    ├── server.ts              # MCP server (Layer 3)
    ├── serviceClient.ts       # Context service (Layer 2)
    └── tools/
        ├── codebaseRetrieval.ts # codebase_retrieval tool
        ├── context.ts           # get_context_for_prompt, semantic_search, get_file, enhance_prompt
        ├── index.ts             # index_workspace, index_status
        ├── memory.ts            # add_memory, list_memories
        ├── plan.ts              # create_plan, refine_plan, visualize_plan, execute_plan
        ├── planManagement.ts    # save_plan, load_plan, list_plans, delete_plan, etc. (13 tools)
        ├── codeReview.ts        # review_changes, review_git_diff
        ├── reactiveReview.ts    # reactive_review_pr, get_review_status, etc. (7 tools)
        └── lifecycle.ts         # reindex_workspace, clear_index
```

## 🔍 Common Tasks

### First Time Setup
```bash
# 1. Install dependencies
npm install

# 2. Build project
npm run build

# 3. Verify setup
npm run verify

# 4. Authenticate
codex login

# 5. Test
node dist/index.js --help
```

### Daily Development
```bash
# Watch mode
npm run dev

# Test changes
npm run test

# Debug with inspector
npm run inspector
```

### Troubleshooting
```bash
# Verify setup
npm run verify

# Check MCP configuration
codex mcp list

# Test server directly
node dist/index.js --workspace . --index
```

## 🎓 Learning Path

### Beginner
1. Read [README.md](README.md) - Understand what this does
2. Follow [QUICKSTART.md](QUICKSTART.md) - Get it running
3. Try example queries in Codex CLI
4. Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if issues arise

### Intermediate
1. Read [ARCHITECTURE.md](ARCHITECTURE.md) - Understand the design
2. Review source code in `src/`
3. Read [TESTING.md](TESTING.md) - Learn testing strategies
4. Experiment with MCP Inspector

### Advanced
1. Study [plan.md](plan.md) - Understand design decisions
2. Review [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) - See what's implemented
3. Extend with new tools (see ARCHITECTURE.md - Extension Points)
4. Contribute improvements

## 🔗 External Resources

- **MCP Protocol**: https://modelcontextprotocol.io/
- **MCP Inspector**: https://github.com/modelcontextprotocol/inspector
- **Codex CLI**: https://github.com/openai/codex

## 💡 Tips

- **Start with QUICKSTART.md** - Don't skip the basics
- **Use `npm run verify`** - Check your setup anytime
- **Check logs first** - Most issues show up in logs
- **Test with MCP Inspector** - Debug tool calls interactively
- **Read ARCHITECTURE.md** - Understand before modifying

## 📞 Getting Help

1. Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
2. Review [TESTING.md](TESTING.md) for debugging
3. Run `npm run verify` to check setup
4. Run `codex mcp list` to verify configuration
5. Test with MCP Inspector

## ✅ Quick Checklist

Before asking for help, verify:
- [ ] Node.js 18+ installed (`node --version`)
- [ ] MCP client installed (for example `codex` or `claude`)
- [ ] Authenticated where needed (for example `codex login`)
- [ ] Dependencies installed (`npm install`)
- [ ] Project built (`npm run build`)
- [ ] Setup verified (`npm run verify`)

---

**Ready to start?** → [QUICKSTART.md](QUICKSTART.md)

**Need help?** → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

**Want to understand?** → [ARCHITECTURE.md](ARCHITECTURE.md)
