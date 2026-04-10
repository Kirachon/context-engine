import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { handleToolManifest } from '../src/mcp/tools/manifest.js';

const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(process.cwd(), 'src', 'index.ts');

interface RunningServer {
  child: ReturnType<typeof spawn>;
  stderr: string;
  stdout: string;
  stop: () => Promise<void>;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

interface RunningStdioServer extends RunningServer {
  sendMessage: (message: JsonRpcMessage) => void;
  nextMessage: (
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs?: number
  ) => Promise<JsonRpcMessage>;
}

function seedRepo(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'index.ts'), 'export const smoke = true;\n', 'utf-8');
}

function encodeStdioMessage(message: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf-8');
}

function waitForServerReady(
  child: ReturnType<typeof spawn>,
  stderrRef: { value: string },
  stdoutRef: { value: string },
  matchers: string[],
  timeoutMs = 15000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = (): void => {
      const combined = `${stderrRef.value}\n${stdoutRef.value}`;
      if (matchers.every((matcher) => combined.includes(matcher))) {
        cleanup();
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for startup markers.\nExpected: ${matchers.join(', ')}\nCaptured stderr:\n${stderrRef.value}\nCaptured stdout:\n${stdoutRef.value}`
          )
        );
      }
    };

    const onStdout = (chunk: Buffer | string): void => {
      stdoutRef.value += chunk.toString();
      check();
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderrRef.value += chunk.toString();
      check();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Launcher exited before startup completed (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\nCaptured stderr:\n${stderrRef.value}\nCaptured stdout:\n${stdoutRef.value}`
        )
      );
    };

    const timer = setInterval(check, 50);

    const cleanup = (): void => {
      clearInterval(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    check();
  });
}

function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceTimer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);

    const forceTimer = setTimeout(() => {
      if (child.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      }
      finish();
    }, 5000);

    child.once('exit', onExit);
    child.once('error', onError);
    child.kill('SIGTERM');
  });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a TCP port for launcher smoke test.')));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startServer(cwd: string, args: string[] = []): Promise<RunningServer> {
  const port = await getAvailablePort();
  const stderrRef = { value: '' };
  const stdoutRef = { value: '' };
  const child = spawn(process.execPath, [tsxCli, entrypoint, '--http-only', '--port', String(port), ...args], {
    cwd,
    env: {
      ...process.env,
      CE_AUTO_INDEX_ON_STARTUP: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  await waitForServerReady(child, stderrRef, stdoutRef, [
    `Workspace: ${path.resolve(cwd)}`,
    'Running in HTTP-only mode. Press Ctrl+C to stop.',
    '[startup] Startup auto-index disabled via CE_AUTO_INDEX_ON_STARTUP=false.',
  ]);

  return {
    child,
    get stderr() {
      return stderrRef.value;
    },
    get stdout() {
      return stdoutRef.value;
    },
    stop: async () => {
      await stopChildProcess(child);
    },
  };
}

async function startStdioServer(cwd: string): Promise<RunningStdioServer> {
  const stderrRef = { value: '' };
  const stdoutRef = { value: '' };
  const child = spawn(process.execPath, [tsxCli, entrypoint], {
    cwd,
    env: {
      ...process.env,
      CE_AUTO_INDEX_ON_STARTUP: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let frameBuffer = Buffer.alloc(0);
  const queuedMessages: JsonRpcMessage[] = [];
  const pendingResolvers: Array<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const settleMessage = (message: JsonRpcMessage): void => {
    const resolverIndex = pendingResolvers.findIndex((entry) => entry.predicate(message));
    if (resolverIndex >= 0) {
      const [entry] = pendingResolvers.splice(resolverIndex, 1);
      clearTimeout(entry.timer);
      entry.resolve(message);
      return;
    }

    queuedMessages.push(message);
  };

  const rejectPendingResolvers = (reason: string): void => {
    while (pendingResolvers.length > 0) {
      const entry = pendingResolvers.shift();
      if (!entry) {
        continue;
      }
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutRef.value += data.toString('utf-8');
    frameBuffer = Buffer.concat([frameBuffer, data]);

    while (true) {
      const lineEnd = frameBuffer.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }

      const body = frameBuffer.subarray(0, lineEnd).toString('utf-8').replace(/\r$/, '');
      frameBuffer = frameBuffer.subarray(lineEnd + 1);
      if (!body.trim()) {
        continue;
      }

      settleMessage(JSON.parse(body) as JsonRpcMessage);
    }
  });

  child.once('exit', (code, signal) => {
    rejectPendingResolvers(`stdio server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  });

  await waitForServerReady(child, stderrRef, stdoutRef, [
    'Starting MCP server (stdio)...',
    'Transport: stdio',
    'Available tools (42 total):',
    'Server ready. Waiting for requests...',
  ]);

  return {
    child,
    get stderr() {
      return stderrRef.value;
    },
    get stdout() {
      return stdoutRef.value;
    },
    stop: async () => {
      await stopChildProcess(child);
    },
    sendMessage: (message: JsonRpcMessage) => {
      child.stdin?.write(encodeStdioMessage(message));
    },
    nextMessage: (predicate, timeoutMs = 15000) => {
      const queuedIndex = queuedMessages.findIndex((message) => predicate(message));
      if (queuedIndex >= 0) {
        const [message] = queuedMessages.splice(queuedIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const resolverIndex = pendingResolvers.findIndex((entry) => entry.resolve === resolve);
          if (resolverIndex >= 0) {
            pendingResolvers.splice(resolverIndex, 1);
          }
          reject(new Error(`Timed out waiting for stdio message. Captured stderr:\n${stderrRef.value}`));
        }, timeoutMs);

        pendingResolvers.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

describe('repo-aware launcher startup smoke', () => {
  it('advertises repo-aware one-time setup in --help output', () => {
    const result = spawnSync(process.execPath, [tsxCli, entrypoint, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Register once in ~/.codex/config.toml and reuse across repos');
    expect(result.stderr).toContain('CE_AUTO_INDEX_ON_STARTUP');
    expect(result.stderr).not.toContain('args = ["/absolute/path/to/dist/index.js", "--workspace", "/path/to/your/project"]');
  });

  it('starts cleanly from the repo root without requiring --workspace', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-root smoke-'));
    seedRepo(repoRoot);

    const server = await startServer(repoRoot);

    try {
      expect(server.child.exitCode).toBeNull();
      expect(server.stderr).toContain(`Workspace: ${path.resolve(repoRoot)}`);
      expect(server.stderr).toContain('Workspace source: cwd');
      expect(server.stderr).not.toContain('Indexing workspace...');
      expect(server.stderr).not.toContain('Background indexing scheduled');
    } finally {
      await server.stop();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the nearest git root when launched from a nested subfolder', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-nested smoke-'));
    const repoRoot = path.join(tempRoot, 'repo root');
    const nested = path.join(repoRoot, 'apps', 'api');
    fs.mkdirSync(nested, { recursive: true });
    seedRepo(repoRoot);

    const port = await getAvailablePort();
    const stderrRef = { value: '' };
    const stdoutRef = { value: '' };
    const child = spawn(
      process.execPath,
      [tsxCli, entrypoint, '--http-only', '--port', String(port)],
      {
        cwd: nested,
        env: {
          ...process.env,
          CE_AUTO_INDEX_ON_STARTUP: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    try {
      await waitForServerReady(child, stderrRef, stdoutRef, [
        `Workspace: ${path.resolve(repoRoot)}`,
        'Workspace source: git-root-fallback',
        'Running in HTTP-only mode. Press Ctrl+C to stop.',
      ]);
      expect(stderrRef.value).toContain(`Workspace: ${path.resolve(repoRoot)}`);
      expect(stderrRef.value).not.toContain(`Workspace: ${path.resolve(nested)}`);
    } finally {
      await stopChildProcess(child);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('honors an explicit --workspace override over the launch directory', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-explicit smoke-'));
    const repoRoot = path.join(tempRoot, 'repo root');
    const nested = path.join(repoRoot, 'packages', 'web');
    const explicitWorkspace = path.join(tempRoot, 'manual workspace');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(explicitWorkspace, { recursive: true });
    seedRepo(repoRoot);

    const port = await getAvailablePort();
    const stderrRef = { value: '' };
    const stdoutRef = { value: '' };
    const child = spawn(
      process.execPath,
      [tsxCli, entrypoint, '--http-only', '--port', String(port), '--workspace', explicitWorkspace],
      {
        cwd: nested,
        env: {
          ...process.env,
          CE_AUTO_INDEX_ON_STARTUP: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    try {
      await waitForServerReady(child, stderrRef, stdoutRef, [
        `Workspace: ${path.resolve(explicitWorkspace)}`,
        'Workspace source: explicit',
        'Running in HTTP-only mode. Press Ctrl+C to stop.',
      ]);
      expect(stderrRef.value).toContain(`Workspace: ${path.resolve(explicitWorkspace)}`);
      expect(stderrRef.value).not.toContain(`Workspace: ${path.resolve(repoRoot)}`);
    } finally {
      await stopChildProcess(child);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when --workspace is provided without a path', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-missing-workspace-'));
    seedRepo(repoRoot);

    try {
      const result = spawnSync(
        process.execPath,
        [tsxCli, entrypoint, '--workspace', '--http-only'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CE_AUTO_INDEX_ON_STARTUP: 'false',
          },
          encoding: 'utf-8',
          windowsHide: true,
        }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Error: --workspace requires a path argument');
      expect(result.stderr).not.toContain('Starting MCP server (stdio)...');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('fails fast when --workspace points to a missing path', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-missing-path-'));
    seedRepo(repoRoot);
    const missingWorkspace = path.join(repoRoot, 'missing workspace');

    try {
      const result = spawnSync(
        process.execPath,
        [tsxCli, entrypoint, '--http-only', '--workspace', missingWorkspace],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CE_AUTO_INDEX_ON_STARTUP: 'false',
          },
          encoding: 'utf-8',
          windowsHide: true,
        }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Workspace path does not exist');
      expect(result.stderr).not.toContain('Starting MCP server (stdio)...');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('preserves stdio startup markers and tools/list inventory', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-launcher-stdio-smoke-'));
    seedRepo(repoRoot);

    const server = await startStdioServer(repoRoot);

    try {
      server.sendMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {
            name: 'compat-harness',
            version: '1.0.0',
          },
        },
      });

      const initializeResponse = await server.nextMessage((message) => message.id === 1);
      expect((initializeResponse.result as { protocolVersion?: string })?.protocolVersion).toBe('2025-11-25');
      expect(
        (initializeResponse.result as { capabilities?: { tools?: { listChanged?: boolean } } })?.capabilities?.tools
          ?.listChanged
      ).toBe(true);

      server.sendMessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      server.sendMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });

      const listToolsResponse = await server.nextMessage((message) => message.id === 2);
      const runtimeToolNames = (
        (listToolsResponse.result as { tools?: Array<{ name: string }> })?.tools ?? []
      ).map((tool) => tool.name);
      const manifest = JSON.parse(await handleToolManifest({}, {} as never)) as { tools: string[] };

      expect(runtimeToolNames).toEqual(manifest.tools);
      expect(server.stderr).toContain('Starting MCP server (stdio)...');
      expect(server.stderr).toContain('Available tools (42 total):');
      expect(server.stderr).toContain('Server ready. Waiting for requests...');
    } finally {
      await server.stop();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
