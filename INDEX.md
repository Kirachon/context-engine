# Context Engine MCP Server - Documentation Index

Welcome to the Context Engine MCP Server! This index will help you find the right documentation for your needs.

## 🚀 Getting Started

**New to this project?** Start here:

1. **[QUICKSTART.md](QUICKSTART.md)** - Get running in 5 minutes
   - Installation steps
   - Authentication setup
   - Codex CLI configuration
   - First queries

2. **[README.md](README.md)** - Project overview
   - What this project does
   - Key features
   - Architecture diagram
   - Usage examples

## 📚 Core Documentation

### For Users

- **[QUICKSTART.md](QUICKSTART.md)** - Fast setup guide
- **[README.md](README.md)** - Complete user guide
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

#### Configure Codex CLI
→ [QUICKSTART.md](QUICKSTART.md) - Step 5

#### Configure Other MCP Clients (Antigravity, Claude Desktop, Cursor)
→ [QUICKSTART.md](QUICKSTART.md) - Step 5B

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
        ├── search.ts          # semantic_search tool
        ├── file.ts            # get_file tool
        └── context.ts         # get_context_for_prompt tool
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
auggie login

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

# Test auggie directly
auggie search "test" --limit 1
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
- **Auggie SDK**: https://docs.augmentcode.com/
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
- [ ] Auggie CLI installed (`auggie --version`)
- [ ] Authenticated (`auggie login` or env vars set)
- [ ] Dependencies installed (`npm install`)
- [ ] Project built (`npm run build`)
- [ ] Setup verified (`npm run verify`)

---

**Ready to start?** → [QUICKSTART.md](QUICKSTART.md)

**Need help?** → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

**Want to understand?** → [ARCHITECTURE.md](ARCHITECTURE.md)

