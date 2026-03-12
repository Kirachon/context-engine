# Get Started Checklist

Follow this checklist to get the Context Engine MCP Server running with the current local-native runtime.

## Prerequisites Checklist

### System Requirements
- [ ] Node.js 18 or higher installed
  ```bash
  node --version
  ```
- [ ] npm installed
  ```bash
  npm --version
  ```
- [ ] Git installed (optional, for cloning)
  ```bash
  git --version
  ```

## Setup Checklist

### 1. Project Setup
- [ ] Navigate to the project directory
  ```bash
  cd context-engine
  ```
- [ ] Install dependencies
  ```bash
  npm install
  ```
- [ ] Build the project
  ```bash
  npm run build
  ```
- [ ] Verify setup
  ```bash
  npm run verify
  ```

### 2. Optional AI Session Setup
The active retrieval runtime is local-native. Some AI-assisted workflows may still require your configured AI provider or Codex session to be available.

- [ ] Install Codex CLI if you use Codex-backed workflows
  ```bash
  npm install -g @openai/codex
  codex --version
  ```
- [ ] Log in if your chosen AI workflow requires it
  ```bash
  codex login
  ```

### 3. Test the Server
- [ ] Test help command
  ```bash
  node dist/index.js --help
  ```
- [ ] Run with the current directory as workspace
  ```bash
  node dist/index.js --workspace .
  ```
- [ ] Index a workspace (optional)
  ```bash
  node dist/index.js --workspace /path/to/your/project --index
  ```

## Codex CLI Integration Checklist

### 4. Configure Codex CLI

**Option A: Using the CLI**
- [ ] Add MCP server via CLI
  ```bash
  codex mcp add context-engine -- node /ABSOLUTE/PATH/TO/context-engine/dist/index.js --workspace /PATH/TO/YOUR/PROJECT
  ```

**Option B: Edit config.toml directly**

**Windows:**
- [ ] Open config file
  ```powershell
  mkdir -Force $env:USERPROFILE\.codex
  code $env:USERPROFILE\.codex\config.toml
  ```
- [ ] Add this configuration
  ```toml
  [mcp_servers.context-engine]
  command = "node"
  args = [
      "/ABSOLUTE/PATH/TO/context-engine/dist/index.js",
      "--workspace",
      "/PATH/TO/YOUR/PROJECT"
  ]
  ```

### 5. Verify Connection
- [ ] In Codex CLI, type `/mcp`
- [ ] Confirm tools like:
  - `semantic_search`
  - `get_file`
  - `get_context_for_prompt`

## First Usage Checklist

### 6. Try Example Queries
- [ ] Search for authentication logic
- [ ] Read `package.json`
- [ ] Get context about the database schema

### 7. Validate Local Gates
- [ ] No-legacy scan
  ```bash
  npm run ci:check:no-legacy-provider
  ```
- [ ] Parity evidence gate
  ```bash
  npm run ci:check:legacy-capability-parity
  ```
- [ ] Strict parity gate with history proof
  ```bash
  npm run ci:check:legacy-capability-parity:strict
  ```

## Troubleshooting Checklist

If something does not work:
- [ ] Check `npm run verify`
- [ ] Check `npm run build`
- [ ] Confirm MCP configuration
- [ ] Review [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## Success Criteria

You are ready when:
- `npm run verify` passes
- The server starts without errors
- MCP tools appear in Codex CLI
- Example queries return sensible results
- The no-legacy and parity gates pass when needed

