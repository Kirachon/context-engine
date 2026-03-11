#!/usr/bin/env node

/**
 * Context Engine MCP Server
 * 
 * A local-first, agent-agnostic MCP server implementation
 * using the legacy retrieval runtime as the core context engine.
 * 
 * Architecture (5 layers):
 * 1. Core Context Engine (legacy retrieval runtime) - indexing, retrieval
 * 2. Context Service Layer (serviceClient.ts) - orchestration
 * 3. MCP Interface Layer (server.ts, tools/) - protocol adapter
 * 4. Agent Clients (Claude, Cursor, etc.) - consumers
 * 5. Storage Backend (legacy runtime internals) - vectors, metadata
 * 
 * Transport Modes:
 * - stdio (default): Standard MCP protocol for Codex, Claude, etc.
 * - http (--http flag): REST API for VS Code extension and HTTP clients
 */

import { ContextEngineMCPServer } from './mcp/server.js';
import { ContextEngineHttpServer } from './http/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Read version from package.json dynamically
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../package.json');
let VERSION = '1.8.0'; // Fallback version
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  VERSION = packageJson.version || VERSION;
} catch (error) {
  console.error('[context-engine] Warning: Could not read package.json, using default version');
}


async function main() {
  // Get workspace path from command line args or use current directory
  const args = process.argv.slice(2);
  let workspacePath = process.cwd();
  let shouldIndex = false;
  let enableWatcher = false;
  let enableHttp = false;
  let httpPort = 3333;
  let httpOnly = false;

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--workspace' || arg === '-w') {
      workspacePath = path.resolve(args[i + 1]);
      i++;
    } else if (arg === '--index' || arg === '-i') {
      shouldIndex = true;
    } else if (arg === '--watch' || arg === '-W') {
      enableWatcher = true;
    } else if (arg === '--http') {
      enableHttp = true;
    } else if (arg === '--http-only') {
      enableHttp = true;
      httpOnly = true;
    } else if (arg === '--port' || arg === '-p') {
      httpPort = parseInt(args[i + 1], 10);
      if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
        console.error('Error: Invalid port number');
        process.exit(1);
      }
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.error(`
Context Engine MCP Server

Usage: context-engine-mcp [options]

Options:
  --workspace, -w <path>   Workspace directory to index (default: current directory)
  --index, -i              Index the workspace before starting server
  --watch, -W              Enable filesystem watcher for incremental indexing
  --http                   Enable HTTP server (in addition to stdio)
  --http-only              Enable HTTP server only (no stdio)
  --port, -p <port>        HTTP server port (default: 3333)
  --help, -h               Show this help message

Environment Variables:
  CE_RETRIEVAL_PROVIDER    Retrieval provider preference: local_native (default) | augment_legacy
  AUGMENT_API_TOKEN        Augment-provider token (only required for augment_legacy)
  AUGMENT_API_URL          Augment-provider URL (default: https://api.augmentcode.com; only used for augment_legacy)
  CE_AI_PROVIDER           AI provider for ask calls: openai_session
  CE_OPENAI_SESSION_CMD    Command for session-based provider (default: codex)

Examples:
  # Start stdio server with current directory
  context-engine-mcp

  # Start stdio server with specific workspace
  context-engine-mcp --workspace /path/to/project

  # Start with both stdio and HTTP servers
  context-engine-mcp --workspace /path/to/project --http

  # Start HTTP server only (for VS Code extension)
  context-engine-mcp --workspace /path/to/project --http-only --port 3333

  # Index workspace before starting
  context-engine-mcp --workspace /path/to/project --index

MCP Configuration (for Codex CLI):
Add to ~/.codex/config.toml:

[mcp_servers.context-engine]
command = "node"
args = ["/absolute/path/to/dist/index.js", "--workspace", "/path/to/your/project"]

Or use the CLI:
codex mcp add context-engine -- node /absolute/path/to/dist/index.js --workspace /path/to/your/project
      `);
      process.exit(0);
    }
  }

  console.error('='.repeat(80));
  console.error('Context Engine MCP Server');
  console.error('='.repeat(80));
  console.error(`Workspace: ${workspacePath}`);
  console.error(`Watcher: ${enableWatcher ? 'enabled' : 'disabled'}`);
  console.error(`HTTP: ${enableHttp ? `enabled (port ${httpPort})` : 'disabled'}`);
  console.error(`Mode: ${httpOnly ? 'HTTP only' : enableHttp ? 'stdio + HTTP' : 'stdio only'}`);
  console.error('');

  try {
    const server = new ContextEngineMCPServer(workspacePath, 'context-engine', {
      enableWatcher,
    });

    // Index workspace if requested
    if (shouldIndex) {
      console.error('Indexing workspace...');
      await server.indexWorkspace();
      console.error('Indexing complete!');
      console.error('');
    }

    // Start HTTP server if enabled
    if (enableHttp) {
      // Get the shared service client from the MCP server
      const httpServer = new ContextEngineHttpServer(
        server.getServiceClient(),
        {
          port: httpPort,
          version: VERSION,
        }
      );

      try {
        await httpServer.start();
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'EADDRINUSE') {
          console.error(`Error: Port ${httpPort} is already in use`);
          console.error('Try using a different port with --port option');
        } else {
          console.error('HTTP server error:', err.message);
        }
        process.exit(1);
      }
    }

    // Start stdio MCP server unless http-only mode
    if (!httpOnly) {
      console.error('Starting MCP server (stdio)...');
      await server.run();
    } else {
      console.error('Running in HTTP-only mode. Press Ctrl+C to stop.');
      // Keep process running with proper signal handling
      await new Promise<void>(resolve => {
        process.on('SIGINT', () => {
          console.error('\nReceived SIGINT, shutting down gracefully...');
          resolve();
        });
        process.on('SIGTERM', () => {
          console.error('\nReceived SIGTERM, shutting down gracefully...');
          resolve();
        });
      });
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
