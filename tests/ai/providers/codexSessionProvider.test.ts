import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';

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

describe('CodexSessionProvider wrapper args', () => {
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

  it('prefers Windows .cmd defaults for readiness checks', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });

    try {
      jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
      const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

      const provider = new CodexSessionProvider();
      await (provider as any).ensureSessionReady(process.cwd());

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toEqual({
        command: 'cmd',
        args: ['/d', '/s', '/c', 'codex.cmd', 'login', 'status'],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('applies CE_OPENAI_SESSION_ARGS_JSON prefix to readiness login status', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'cmd';
    process.env.CE_OPENAI_SESSION_ARGS_JSON =
      '["/d","/s","/c","D:\\\\npm-global\\\\codex.cmd"]';
    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    await (provider as any).ensureSessionReady(process.cwd());

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      command: 'cmd',
      args: ['/d', '/s', '/c', 'D:\\npm-global\\codex.cmd', 'login', 'status'],
    });
  });

  it('uses wrapper prefix for exec and CE_OPENAI_SESSION_EXEC_ARGS_JSON for exec-only args', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'cmd';
    process.env.CE_OPENAI_SESSION_ARGS_JSON =
      '["/d","/s","/c","D:\\\\npm-global\\\\codex.cmd"]';
    process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON = '["--model","gpt-5-codex"]';

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    spawnPlans.push({
      stdout: '{"ok":true}',
      onSpawn: (args) => {
        const outputIdx = args.indexOf('--output-last-message');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], 'wrapper path output', 'utf-8');
        }
      },
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    const response = await provider.call({
      searchQuery: 'health',
      prompt: 'health',
      timeoutMs: 20_000,
      workspacePath: process.cwd(),
    });

    expect(response.text).toBe('wrapper path output');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).toEqual([
      '/d',
      '/s',
      '/c',
      'D:\\npm-global\\codex.cmd',
      'login',
      'status',
    ]);
    expect(spawnCalls[1]?.args.slice(0, 8)).toEqual([
      '/d',
      '/s',
      '/c',
      'D:\\npm-global\\codex.cmd',
      'exec',
      '--model',
      'gpt-5-codex',
      '--json',
    ]);
  });

  it('keeps backward compatibility: legacy CE_OPENAI_SESSION_ARGS_JSON acts as exec args when not wrapper-shaped', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';
    process.env.CE_OPENAI_SESSION_ARGS_JSON = '["--model","gpt-5-codex"]';
    delete process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON;

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    spawnPlans.push({
      stdout: '{"ok":true}',
      onSpawn: (args) => {
        const outputIdx = args.indexOf('--output-last-message');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], 'legacy exec args output', 'utf-8');
        }
      },
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    const response = await provider.call({
      searchQuery: 'health',
      prompt: 'health',
      timeoutMs: 20_000,
      workspacePath: process.cwd(),
    });

    expect(response.text).toBe('legacy exec args output');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.command).toBe('codex');
    expect(spawnCalls[0]?.args).toEqual(['login', 'status']);
    expect(spawnCalls[1]?.args.slice(0, 4)).toEqual(['exec', '--model', 'gpt-5-codex', '--json']);
  });

  it('treats CE_OPENAI_SESSION_EXEC_ARGS_JSON=[] as explicit override that clears legacy exec args', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';
    process.env.CE_OPENAI_SESSION_ARGS_JSON = '["--model","gpt-5-codex"]';
    process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON = '[]';

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    spawnPlans.push({
      stdout: '{"ok":true}',
      onSpawn: (args) => {
        const outputIdx = args.indexOf('--output-last-message');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], 'explicit empty exec args output', 'utf-8');
        }
      },
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    const response = await provider.call({
      searchQuery: 'health',
      prompt: 'health',
      timeoutMs: 20_000,
      workspacePath: process.cwd(),
    });

    expect(response.text).toBe('explicit empty exec args output');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.command).toBe('codex');
    expect(spawnCalls[0]?.args).toEqual(['login', 'status']);
    expect(spawnCalls[1]?.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(spawnCalls[1]?.args).not.toContain('--model');
    expect(spawnCalls[1]?.args).not.toContain('gpt-5-codex');
  });

  it('surfaces usage limit errors without marking them retryable', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex.cmd';

    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    spawnPlans.push({
      exitCode: 1,
      stdout: `{"type":"error","message":"You've hit your usage limit. Try again later."}`,
      stderr: 'Warning: no last agent message; wrote empty content.',
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    await expect(
      provider.call({
        searchQuery: 'quota check',
        prompt: 'quota check',
        timeoutMs: 20_000,
        workspacePath: process.cwd(),
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/usage limit/i),
      retryable: false,
    });
  });

  it('falls through to exec when readiness check times out', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex.cmd';

    spawnPlans.push({
      stdout: '{"ok":true}',
      onSpawn: (args) => {
        const outputIdx = args.indexOf('--output-last-message');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], 'exec despite readiness timeout', 'utf-8');
        }
      },
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');
    const { AIProviderError } = await import('../../../src/ai/providers/types.js');

    const provider = new CodexSessionProvider();
    jest.spyOn(provider as any, 'ensureSessionReadyWithTimeout').mockRejectedValue(
      new AIProviderError({
        code: 'provider_timeout',
        provider: 'openai_session',
        message: 'Codex login status check timed out after 10000ms.',
        retryable: true,
      })
    );

    const response = await provider.call({
      searchQuery: 'readiness timeout fallback',
      prompt: 'readiness timeout fallback',
      timeoutMs: 20_000,
      workspacePath: process.cwd(),
    });

    expect(response.text).toBe('exec despite readiness timeout');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain('exec');
  });

  it('does not swallow non-readiness failures from ensureSessionReady', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex.cmd';

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');
    const { AIProviderError } = await import('../../../src/ai/providers/types.js');

    const provider = new CodexSessionProvider();
    jest.spyOn(provider as any, 'ensureSessionReadyWithTimeout').mockRejectedValue(
      new AIProviderError({
        code: 'provider_unavailable',
        provider: 'openai_session',
        message: 'provider unavailable',
        retryable: true,
      })
    );

    await expect(
      provider.call({
        searchQuery: 'should fail',
        prompt: 'should fail',
        timeoutMs: 20_000,
        workspacePath: process.cwd(),
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('aborts an in-flight exec request and kills the spawned process', async () => {
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
      const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

      const provider = new CodexSessionProvider();
      const controller = new AbortController();
      const pending = provider.call({
        searchQuery: 'abort me',
        prompt: 'abort me',
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

  it('reports health without throwing when readiness succeeds', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';
    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    await expect(provider.health?.()).resolves.toEqual({ ok: true });
  });

  it('uses the remaining absolute deadline budget for readiness and exec', async () => {
    process.env.CE_OPENAI_SESSION_CMD = 'codex';
    spawnPlans.push({ stdout: 'Logged in via ChatGPT' });
    spawnPlans.push({
      stdout: '{"ok":true}',
      onSpawn: (args) => {
        const outputIdx = args.indexOf('--output-last-message');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], 'deadline budget output', 'utf-8');
        }
      },
    });

    jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
    const { CodexSessionProvider } = await import('../../../src/ai/providers/codexSessionProvider.js');

    const provider = new CodexSessionProvider();
    const runSpy = jest.spyOn(provider as any, 'runWithCommandFallback');
    const deadlineMs = Date.now() + 2_000;

    const response = await provider.call({
      searchQuery: 'deadline budget',
      prompt: 'deadline budget',
      timeoutMs: 20_000,
      deadlineMs,
      workspacePath: process.cwd(),
    });

    expect(response.text).toBe('deadline budget output');
    expect(runSpy).toHaveBeenCalledTimes(2);
    const readinessCall = runSpy.mock.calls[0]?.[0] as { timeoutMs: number } | undefined;
    const execCall = runSpy.mock.calls[1]?.[0] as { timeoutMs: number } | undefined;
    expect(readinessCall?.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(execCall?.timeoutMs).toBeLessThan(20_000);
    expect(execCall?.timeoutMs).toBeGreaterThan(0);
  });
});
