import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(process.cwd(), 'src', 'index.ts');

interface RunningServer {
  child: ReturnType<typeof spawn>;
  stderr: string;
  stdout: string;
  stop: () => Promise<void>;
}

function seedRepo(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'index.ts'), 'export const smoke = true;\n', 'utf-8');
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
});
