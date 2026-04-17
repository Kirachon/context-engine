import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Contract regression fence for the provider cancellation + timeout semantics
 * frozen by commit 393c9ba (OpenAI/Codex hardening). See
 * docs/providers/cancellation.md.
 *
 * These tests intentionally exercise the legacy `openai_session` adapter via
 * its concrete class but mock `node:child_process` so they remain offline and
 * deterministic. They MUST NOT depend on a real Codex CLI being installed.
 */

type SpawnPlan = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
  deferClose?: boolean;
  onSpawn?: (
    args: string[],
    controls: {
      close: (code?: number) => void;
      error: (error: NodeJS.ErrnoException) => void;
      kill: jest.Mock;
    }
  ) => void;
};

type SpawnCall = {
  command: string;
  args: string[];
};

const ORIGINAL_ENV = { ...process.env };

describe('provider cancellation + timeout contract (codex session adapter)', () => {
  const spawnPlans: SpawnPlan[] = [];
  const spawnCalls: SpawnCall[] = [];

  const spawnMock = jest.fn((command: string, args: string[]) => {
    const plan = spawnPlans.shift() ?? {};
    spawnCalls.push({ command, args: [...args] });

    const stdoutHandlers: Array<(chunk: string) => void> = [];
    const stderrHandlers: Array<(chunk: string) => void> = [];
    const processHandlers: Record<string, ((code?: number) => void) | undefined> = {};
    const kill = jest.fn();
    const controls = {
      close: (code?: number) => processHandlers.close?.(code),
      error: (error: NodeJS.ErrnoException) => processHandlers.error?.(error as never),
      kill,
    };
    plan.onSpawn?.(args, controls);

    return {
      pid: 4321,
      stdout: {
        on: (event: string, handler: (chunk: string) => void) => {
          if (event === 'data') stdoutHandlers.push(handler);
        },
      },
      stderr: {
        on: (event: string, handler: (chunk: string) => void) => {
          if (event === 'data') stderrHandlers.push(handler);
        },
      },
      stdin: {
        write: jest.fn(),
        end: jest.fn(() => {
          queueMicrotask(() => {
            if (plan.deferClose) {
              return;
            }
            if (plan.error) {
              controls.error(plan.error);
              return;
            }
            if (plan.stdout) {
              for (const handler of stdoutHandlers) handler(plan.stdout);
            }
            if (plan.stderr) {
              for (const handler of stderrHandlers) handler(plan.stderr);
            }
            controls.close(plan.exitCode ?? 0);
          });
        }),
      },
      on: (event: string, handler: (code?: number) => void) => {
        processHandlers[event] = handler;
      },
      kill,
    };
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_OPENAI_SESSION_CMD;
    delete process.env.CE_OPENAI_SESSION_ARGS_JSON;
    delete process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON;
    jest.resetModules();
    spawnMock.mockClear();
    spawnPlans.length = 0;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('rejects with provider_aborted when the AbortSignal is already aborted at entry', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import(
      '../../../src/ai/providers/codexSessionProvider.js'
    );

    const provider = new CodexSessionProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.call({
        searchQuery: 'pre-aborted',
        prompt: 'pre-aborted',
        timeoutMs: 20_000,
        workspacePath: process.cwd(),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'provider_aborted' });

    // No subprocess should be spawned once the signal is already aborted at
    // the readiness phase.
    expect(spawnCalls).toHaveLength(0);
  });

  it('rejects with provider_aborted when the signal aborts mid-flight and kills the subprocess', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.CE_OPENAI_SESSION_CMD = 'codex';

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    let execControls:
      | {
          close: (code?: number) => void;
          error: (error: NodeJS.ErrnoException) => void;
          kill: jest.Mock;
        }
      | undefined;
    let resolveExecSpawned: (() => void) | undefined;
    const execSpawned = new Promise<void>((resolve) => {
      resolveExecSpawned = resolve;
    });
    spawnPlans.push({
      deferClose: true,
      onSpawn: (_args, controls) => {
        execControls = controls;
        controls.kill.mockImplementation(() => {
          controls.close(1);
        });
        resolveExecSpawned?.();
      },
    });

    try {
      jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
      const { CodexSessionProvider } = await import(
        '../../../src/ai/providers/codexSessionProvider.js'
      );

      const provider = new CodexSessionProvider();
      const controller = new AbortController();
      const pending = provider.call({
        searchQuery: 'mid-flight abort',
        prompt: 'mid-flight abort',
        timeoutMs: 20_000,
        workspacePath: process.cwd(),
        signal: controller.signal,
      });

      await execSpawned;
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: 'provider_aborted' });
      expect(execControls).toBeDefined();
      expect(execControls!.kill).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('rejects with provider_timeout when deadlineMs is already in the past', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import(
      '../../../src/ai/providers/codexSessionProvider.js'
    );

    const provider = new CodexSessionProvider();

    await expect(
      provider.call({
        searchQuery: 'deadline expired',
        prompt: 'deadline expired',
        timeoutMs: 20_000,
        deadlineMs: Date.now() - 1_000,
        workspacePath: process.cwd(),
      })
    ).rejects.toMatchObject({ code: 'provider_timeout' });

    // The provider must short-circuit before spawning anything when the
    // remaining budget is already <= 0.
    expect(spawnCalls).toHaveLength(0);
  });

  it('health() never throws and reports {ok:false, reason} when the CLI is unreachable', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';

    // Cause every spawn attempt to fail with ENOENT to simulate "CLI not
    // installed". The provider must surface this through the health contract
    // without throwing.
    const enoent: NodeJS.ErrnoException = Object.assign(
      new Error('spawn codex ENOENT'),
      { code: 'ENOENT' }
    );
    spawnPlans.push({ error: enoent });
    spawnPlans.push({ error: enoent });
    spawnPlans.push({ error: enoent });
    spawnPlans.push({ error: enoent });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import(
      '../../../src/ai/providers/codexSessionProvider.js'
    );

    const provider = new CodexSessionProvider();
    expect(typeof provider.health).toBe('function');

    const result = await provider.health!();
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(typeof result.reason === 'string' && result.reason.length > 0).toBe(true);
  });

  it('health() also resolves (does not throw) on the happy path', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';
    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import(
      '../../../src/ai/providers/codexSessionProvider.js'
    );

    const provider = new CodexSessionProvider();
    await expect(provider.health!()).resolves.toEqual({ ok: true });
  });

  it('exports the frozen error code strings for abort and timeout', async () => {
    const { ProviderAbortedError, ProviderTimeoutError } = await import(
      '../../../src/ai/providers/errors.js'
    );

    const aborted = new ProviderAbortedError({ provider: 'openai_session' });
    const timedOut = new ProviderTimeoutError({ provider: 'openai_session' });

    expect(aborted.code).toBe('provider_aborted');
    expect(aborted.provider).toBe('openai_session');
    expect(aborted.retryable).toBe(false);

    expect(timedOut.code).toBe('provider_timeout');
    expect(timedOut.provider).toBe('openai_session');
    expect(timedOut.retryable).toBe(true);
  });
});
