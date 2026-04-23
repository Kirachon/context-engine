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
import { envBool } from './config/env.js';
import { FEATURE_FLAGS, validateFlagCombinations } from './config/features.js';
import { resolveWorkspacePath, type WorkspaceResolutionResult } from './workspace/resolveWorkspace.js';
import { acquireWorkspaceStartupLock } from './runtime/workspaceLock.js';
import { shutdownObservability, startObservability } from './observability/otel.js';
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
  let explicitWorkspacePath: string | undefined;
  let cliParseError: string | undefined;
  let shouldIndex = false;
  let enableWatcher = false;
  let enableHttp = false;
  let httpPort = 3333;
  let httpOnly = false;
  const autoIndexOnStartup = envBool('CE_AUTO_INDEX_ON_STARTUP', true);

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--workspace' || arg === '-w') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        cliParseError = 'Error: --workspace requires a path argument';
        break;
      }
      explicitWorkspacePath = nextArg;
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
  --workspace, -w <path>   Workspace directory to index (default: current directory with git-root fallback)
  --index, -i              Index the workspace before starting server
  --watch, -W              Enable filesystem watcher for incremental indexing
  --http                   Enable HTTP server (in addition to stdio)
  --http-only              Enable HTTP server only (no stdio)
  --port, -p <port>        HTTP server port (default: 3333)
  --help, -h               Show this help message

Environment Variables:
  CE_RETRIEVAL_PROVIDER    Retrieval provider preference: local_native (default)
  CE_AI_PROVIDER           AI provider for ask calls: openai_session
  CE_OPENAI_SESSION_CMD    Command for session-based provider (default: codex)
  CE_PERF_PROFILE          Feature preset defaults: default | fast | quality (default: default)
  CE_FEATURE_KILL_SWITCHES Comma-separated FeatureFlags keys to force-disable after env/profile resolution
  CE_AUTO_INDEX_ON_STARTUP Automatically background-index missing or stale workspaces on startup (default: true)

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
  Register once in ~/.codex/config.toml and reuse across repos:

  [mcp_servers.context-engine]
  command = "node"
  args = ["/absolute/path/to/dist/index.js"]
  env = { CE_AUTO_INDEX_ON_STARTUP = "true" }

  Or use the CLI once:
  codex mcp add context-engine -- node /absolute/path/to/dist/index.js

  # Override workspace auto-detection only when needed
  context-engine-mcp --workspace /path/to/your/project
      `);
      process.exit(0);
    }
  }

  if (cliParseError) {
    console.error(cliParseError);
    process.exit(1);
  }

  try {
    validateFlagCombinations(FEATURE_FLAGS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  let workspaceResolution: WorkspaceResolutionResult;
  try {
    workspaceResolution = await resolveWorkspacePath({
      explicitWorkspace: explicitWorkspacePath,
      cwd: process.cwd(),
      logWarning: (message) => console.error(message),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
  workspacePath = workspaceResolution.workspacePath;

  console.error('='.repeat(80));
  console.error('Context Engine MCP Server');
  console.error('='.repeat(80));
  console.error(`Workspace: ${workspacePath}`);
  console.error(`Workspace source: ${workspaceResolution.source}`);
  console.error(`Watcher: ${enableWatcher ? 'enabled' : 'disabled'}`);
  console.error(`HTTP: ${enableHttp ? `enabled (port ${httpPort})` : 'disabled'}`);
  console.error(`Mode: ${httpOnly ? 'HTTP only' : enableHttp ? 'stdio + HTTP' : 'stdio only'}`);
  console.error('');

  try {
    await startObservability();
    const startupLock = acquireWorkspaceStartupLock(workspacePath);
    if (startupLock.warning) {
      console.warn(startupLock.warning);
    }
    let server: ContextEngineMCPServer | undefined;
    let httpServer: ContextEngineHttpServer | undefined;
    let shuttingDown = false;
    let shutdownResolve: (() => void) | undefined;
    const waitForShutdown = new Promise<void>((resolve) => {
      shutdownResolve = resolve;
    });

    const shutdown = async (reason: string, exitCode: number = 0): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      console.error(`\nReceived ${reason}, shutting down gracefully...`);

      try {
        if (httpServer?.isRunning()) {
          await httpServer.stop();
        }
        if (server) {
          await server.shutdown(reason);
        }
      } catch (error) {
        exitCode = 1;
        console.error('Error during shutdown:', error);
      } finally {
        startupLock.release();
        await shutdownObservability();
        shutdownResolve?.();
        process.exit(exitCode);
      }
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT', 0);
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM', 0);
    });
    process.once('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      void shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
    });
    if (!httpOnly && process.stdin) {
      process.stdin.once('end', () => {
        void shutdown('stdio_end', 0);
      });
      process.stdin.once('close', () => {
        void shutdown('stdio_closed', 0);
      });
    }

    server = new ContextEngineMCPServer(workspacePath, 'context-engine', {
      enableWatcher,
    });
    const serviceClient = server.getServiceClient();

    const maybeStartAutoIndex = (): void => {
      if (shouldIndex) {
        return;
      }

      const result = serviceClient.startAutoIndexOnStartupIfNeeded({
        enabled: autoIndexOnStartup,
        log: (message) => console.error(message),
      });

      if (result.started) {
        console.error(`[startup] Background indexing scheduled (${result.reason}).`);
        return;
      }

      if (result.reason === 'disabled') {
        console.error('[startup] Startup auto-index disabled via CE_AUTO_INDEX_ON_STARTUP=false.');
        return;
      }

      if (result.reason !== 'healthy') {
        console.error(`[startup] Startup auto-index skipped (${result.reason}).`);
      }
    };

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
      httpServer = new ContextEngineHttpServer(
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
      maybeStartAutoIndex();
    } else {
      maybeStartAutoIndex();
      console.error('Running in HTTP-only mode. Press Ctrl+C to stop.');
    }
    await waitForShutdown;
  } catch (error) {
    await shutdownObservability();
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
