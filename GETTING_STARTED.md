# Getting Started with Context Engine

## Welcome! 👋

This guide will help you understand and start using Context Engine, a production-ready MCP server for AI-powered code analysis.

## What is Context Engine?

Context Engine is a **Model Context Protocol (MCP) server** that provides:

- 🔍 **Semantic Code Search**: Find code by meaning, not just keywords
- 🔬 **Enterprise Code Review**: Multi-stage analysis with risk scoring
- 🤖 **AI Planning**: Automated task planning with dependency management
- ⚡ **Reactive Reviews**: Asynchronous reviews for large PRs
- 📊 **Comprehensive Telemetry**: Performance metrics and insights

## Quick Start (5 Minutes)

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Project

```bash
npm run build
```

### 3. Configure Provider (OpenAI Session First)

```bash
export CE_AI_PROVIDER=openai_session
export CE_OPENAI_SESSION_CMD=codex
codex login
codex login status
```

Windows fallback if the server reports `command not found`:
```powershell
$env:CE_OPENAI_SESSION_CMD = "cmd"
$env:CE_OPENAI_SESSION_ARGS_JSON = "[`"/d`",`"/s`",`"/c`",`"D:\\npm-global\\codex.cmd`"]"
```

### 4. Test the Server

```bash
node dist/index.js --help
```

### 5. Configure Your MCP Client

**For Codex CLI** (`~/.codex/config.json`):
```json
{
  "mcpServers": {
    "context-engine": {
      "command": "node",
      "args": ["D:/GitProjects/context-engine/dist/index.js"],
      "env": {
        "CE_AI_PROVIDER": "openai_session",
        "CE_OPENAI_SESSION_CMD": "codex"
      }
    }
  }
}
```

**For VS Code** (use the included extension in `vscode-extension/`)

### 6. Verify Installation

Restart your MCP client and check available tools:
```
/mcp list
```

You should see 20+ tools from Context Engine!

## Core Capabilities

### 1. Semantic Search

Find code by meaning:

```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "authentication logic",
    "top_k": 5
  }
}
```

### 2. Code Review

Review git diffs with multi-stage analysis:

```json
{
  "name": "review_diff",
  "arguments": {
    "diff": "diff --git a/src/auth.ts ...",
    "workspace_path": "/path/to/project",
    "options": {
      "enable_static_analysis": true,
      "static_analyzers": ["tsc"],
      "enable_llm_review": true,
      "confidence_threshold": 0.8
    }
  }
}
```

**Review Pipeline**:
1. ✅ **Deterministic Preflight**: Risk scoring (1-5), hotspot detection
2. ✅ **Invariants**: Custom rule enforcement (`.review-invariants.yml`)
3. ✅ **Static Analysis**: TypeScript (tsc), Semgrep (optional)
4. ✅ **LLM Analysis**: Two-pass semantic review (optional)

### 3. Custom Rules (Invariants)

Create `.review-invariants.yml` in your project:

```yaml
security:
  - id: SEC001
    rule: "If req.user is used, requireAuth() must be present"
    paths: ["src/api/**"]
    severity: CRITICAL
    category: security
    action: when_require
    when:
      regex:
        pattern: "req\\.user"
    require:
      regex:
        pattern: "requireAuth\\("

  - id: SEC002
    rule: "No eval() allowed"
    paths: ["src/**"]
    severity: HIGH
    category: security
    action: deny
    deny:
      regex:
        pattern: "\\beval\\("
```

Then check invariants:

```json
{
  "name": "check_invariants",
  "arguments": {
    "diff": "...",
    "workspace_path": "/path/to/project"
  }
}
```

### 4. Static Analysis

Run TypeScript and Semgrep independently:

```json
{
  "name": "run_static_analysis",
  "arguments": {
    "changed_files": ["src/auth.ts", "src/api.ts"],
    "options": {
      "analyzers": ["tsc", "semgrep"],
      "timeout_ms": 60000
    }
  }
}
```

### 5. AI Planning

Generate execution plans:

```json
{
  "name": "generate_plan",
  "arguments": {
    "goal": "Add user authentication to the API",
    "context": "Express.js API with PostgreSQL database"
  }
}
```

### 6. Reactive Reviews (for Large PRs)

Start asynchronous review session:

```json
{
  "name": "start_reactive_review",
  "arguments": {
    "pr_metadata": {
      "pr_number": 123,
      "title": "Add authentication",
      "base_branch": "main",
      "head_branch": "feature/auth"
    },
    "options": {
      "enable_static_analysis": true,
      "enable_llm_review": true
    }
  }
}
```

Check progress:

```json
{
  "name": "get_reactive_status",
  "arguments": {
    "session_id": "session-uuid"
  }
}
```

## Documentation Guide

### For Users

1. **Start Here**: `QUICKSTART.md` - 5-minute setup
2. **Learn More**: `README.md` - Overview and features
3. **Troubleshooting**: `TROUBLESHOOTING.md` - Common issues
4. **API Reference**: `API_REFERENCE.md` - Complete tool specifications

### For Developers

1. **Architecture**: `TECHNICAL_ARCHITECTURE.md` - Deep technical dive
2. **Testing**: `TESTING.md` - Testing strategies
3. **Contributing**: Follow existing code patterns
4. **Project Status**: `PROJECT_SUMMARY.md` - Implementation status

### For Decision Makers

1. **Discovery Summary**: `DISCOVERY_SUMMARY.md` - Comprehensive analysis
2. **Changelog**: `CHANGELOG.md` - Version history
3. **Architecture Blueprint**: `ARCHITECTURE_ENHANCEMENT_BLUEPRINT.md`

## Common Use Cases

### Use Case 1: CI/CD Integration

**Goal**: Automated code review in CI pipeline

**Setup**:
```yaml
# .github/workflows/review.yml
- name: Review PR
  run: |
    git diff origin/main...HEAD > diff.txt
    node dist/index.js review-diff diff.txt --fail-on-severity HIGH
```

**Benefits**:
- Deterministic checks (fast, no LLM needed)
- Custom rule enforcement
- SARIF output for GitHub integration

### Use Case 2: Pre-Commit Hook

**Goal**: Catch issues before commit

**Setup**:
```bash
# .git/hooks/pre-commit
#!/bin/bash
git diff --cached > /tmp/staged.diff
node dist/index.js review-diff /tmp/staged.diff --enable-static-analysis
```

**Benefits**:
- Immediate feedback
- TypeScript type checking
- Custom invariant validation

### Use Case 3: Large PR Review

**Goal**: Review 100+ file PR without blocking

**Setup**: Use reactive review tools

**Benefits**:
- Asynchronous execution
- Parallel processing
- Progress tracking
- Pause/resume capability

### Use Case 4: Semantic Code Search

**Goal**: Find relevant code for refactoring

**Setup**: Use `semantic_search` or `codebase_retrieval`

**Benefits**:
- Find by meaning, not keywords
- Relevance scoring
- Context-aware results

## Configuration

### Environment Variables

```bash
# Recommended
CE_AI_PROVIDER=openai_session
CE_OPENAI_SESSION_CMD=codex

# Optional
LOG_LEVEL=info              # debug, info, warn, error
CACHE_ENABLED=true          # Enable caching
CACHE_TTL_MS=300000         # Cache TTL (5 minutes)
```

### Workspace Configuration

Create `.context-engine.json` in your project:

```json
{
  "review": {
    "confidence_threshold": 0.8,
    "fail_on_severity": "HIGH",
    "enable_static_analysis": true,
    "static_analyzers": ["tsc"]
  },
  "search": {
    "max_results": 10,
    "include_tests": false
  },
  "reactive": {
    "max_concurrent_steps": 4,
    "step_timeout_ms": 300000
  }
}
```

## Performance Tips

### 1. Enable Caching

Caching dramatically improves performance:
- **L1 Cache**: In-memory (search results, file contents)
- **L2 Cache**: Commit-keyed (invalidates on git changes)
- **L3 Cache**: Persistent disk (embeddings, LLM responses)

### 2. Use Static Analysis First

Run `tsc` before LLM review:
- Faster (seconds vs minutes)
- Deterministic (consistent results)
- No token costs

### 3. Configure Timeouts

Adjust timeouts for your environment:
```json
{
  "static_analysis_timeout_ms": 60000,
  "step_timeout_ms": 300000,
  "session_timeout_ms": 1800000
}
```

### 4. Use Reactive Reviews for Large PRs

For PRs with 100+ files:
- Use `start_reactive_review` instead of `review_diff`
- Enable parallel execution
- Monitor with `get_reactive_status`

## Troubleshooting

### Issue: "Authentication failed"

**Solution**: Run `codex login` and `codex login status`.

### Issue: "TypeScript analyzer failed"

**Solution**: Ensure `tsc` is available: `npx tsc --version`

### Issue: "Semgrep not found"

**Solution**: Install Semgrep: `pip install semgrep` or disable it

### Issue: "Session appears stalled"

**Solution**: Check `get_reactive_status` for zombie detection

### Issue: "Cache hit rate is low"

**Solution**: Enable commit-keyed caching in configuration

## Next Steps

1. ✅ **Complete Quick Start** (above)
2. 📖 **Read API Reference** (`API_REFERENCE.md`)
3. 🔧 **Configure Invariants** (`.review-invariants.yml`)
4. 🧪 **Run Tests** (`npm test`)
5. 🚀 **Integrate with CI/CD**

## Support & Resources

- **Documentation**: See `docs/` directory
- **Issues**: Check `TROUBLESHOOTING.md`
- **Architecture**: See `TECHNICAL_ARCHITECTURE.md`
- **API**: See `API_REFERENCE.md`

## Success Metrics

After setup, you should see:
- ✅ All 397 tests passing
- ✅ 20+ tools available in MCP client
- ✅ Semantic search returning relevant results
- ✅ Code reviews completing successfully
- ✅ Cache hit rate > 50%

## Feedback

Found an issue? Have a suggestion? Check the documentation or create an issue!

---

**Ready to dive deeper?** Check out `TECHNICAL_ARCHITECTURE.md` for a comprehensive technical overview.

**Want to contribute?** Read `PROJECT_SUMMARY.md` to understand the implementation status.

**Need help?** See `TROUBLESHOOTING.md` for common issues and solutions.
