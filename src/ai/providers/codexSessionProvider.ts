import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { envInt, envMs } from '../../config/env.js';
import { AIProviderError, type AIProvider, type AIProviderRequest, type AIProviderResponse } from './types.js';

const DEFAULT_CODEX_COMMAND = 'codex';
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 10_000;
const DEFAULT_IDENTITY_REFRESH_MODE = 'per_call';
const DEFAULT_IDENTITY_TTL_MS = 30_000;

type SessionRefreshMode = 'per_call' | 'ttl';

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeStderr(stderr: string): string {
  const normalized = stderr.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

function classifyAuthError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes('logged out') ||
    normalized.includes('not logged in') ||
    normalized.includes('login') ||
    normalized.includes('authentication')
  );
}

function classifyUsageLimitError(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('usage limit') ||
    normalized.includes('more access now') ||
    normalized.includes('try again at') ||
    normalized.includes('quota')
  );
}

function parseArgsJson(raw: string | undefined, envName: string): string[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error(`${envName} must be a JSON string array`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${envName}: ${toMessage(error)}`);
  }
}

function isLikelyWindowsWrapperArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  const lowered = args.map((arg) => arg.toLowerCase());
  const hasCmdSwitch = lowered.includes('/c');
  const hasBatchPath = args.some((arg) => /\.(cmd|bat)$/i.test(arg.replace(/^"+|"+$/g, '')));
  return hasCmdSwitch && hasBatchPath;
}

function parseRefreshMode(raw: string | undefined): SessionRefreshMode {
  if (!raw || raw.trim() === '') return DEFAULT_IDENTITY_REFRESH_MODE;
  const normalized = raw.trim();
  if (normalized === 'per_call' || normalized === 'ttl') return normalized;
  throw new Error(
    `Invalid CE_OPENAI_SESSION_REFRESH_MODE value "${raw}". Allowed values: per_call, ttl`
  );
}

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CommandSpec = {
  command: string;
  prefixArgs: string[];
  label: string;
};

function isWindowsBatchCommand(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim());
}

async function runCommand(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  const normalizedCwd =
    process.platform === 'win32' && args.cwd.startsWith('\\\\?\\')
      ? args.cwd.slice(4)
      : args.cwd;

  return new Promise<SpawnResult>((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(
        new AIProviderError({
          code: 'provider_aborted',
          provider: 'openai_session',
          message: 'Codex session request was aborted before the subprocess started.',
        })
      );
      return;
    }

    const proc = spawn(args.command, args.commandArgs, {
      cwd: normalizedCwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const abortMessage = 'Codex session request was aborted.';

    const terminateProcess = (): void => {
      if (process.platform === 'win32' && typeof proc.pid === 'number') {
        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          shell: false,
        });
        killer.on('error', () => {
          proc.kill();
        });
      } else {
        proc.kill();
      }
    };

    const settleAbort = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      args.signal?.removeEventListener('abort', onAbort);
      reject(
        new AIProviderError({
          code: 'provider_aborted',
          provider: 'openai_session',
          message,
        })
      );
    };

    const onAbort = () => {
      aborted = true;
      terminateProcess();
      setTimeout(() => {
        settleAbort(abortMessage);
      }, 3_000);
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminateProcess();

      // Some Windows process trees survive kill signals. Force-settle so callers don't hang.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        args.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: 1,
          stdout,
          stderr,
          timedOut: true,
        });
      }, 3_000);
    }, args.timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('error', (error) => {
      if (settled) return;
      if (aborted) {
        settleAbort(abortMessage);
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      args.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (aborted) {
        settleAbort(abortMessage);
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      args.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (args.signal) {
      args.signal.addEventListener('abort', onAbort, { once: true });
      if (args.signal.aborted) {
        onAbort();
        return;
      }
    }

    if (args.stdin !== undefined) {
      proc.stdin.write(args.stdin);
    }
    proc.stdin.end();
  });
}

export class CodexSessionProvider implements AIProvider {
  readonly id = 'openai_session' as const;
  readonly modelLabel = 'codex-session';

  private readonly commandCandidates: CommandSpec[];
  private readonly commandPrefixArgs: string[];
  private readonly execArgs: string[];
  private readonly healthcheckTimeoutMs: number;
  private readonly refreshMode: SessionRefreshMode;
  private readonly identityTtlMs: number;
  private identityCache: { checkedAt: number; isLoggedIn: boolean } | null = null;
  private selectedCommand: CommandSpec | null = null;
  private lastWorkspacePath: string = process.cwd();

  constructor() {
    this.commandCandidates = this.buildCommandCandidates(process.env.CE_OPENAI_SESSION_CMD);
    const legacyArgs = parseArgsJson(
      process.env.CE_OPENAI_SESSION_ARGS_JSON,
      'CE_OPENAI_SESSION_ARGS_JSON'
    );
    const hasExplicitExecArgs =
      process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON !== undefined;
    const explicitExecArgs = parseArgsJson(
      process.env.CE_OPENAI_SESSION_EXEC_ARGS_JSON,
      'CE_OPENAI_SESSION_EXEC_ARGS_JSON'
    );
    const legacyLooksLikeWrapper = isLikelyWindowsWrapperArgs(legacyArgs);
    // Compatibility policy:
    // - Legacy CE_OPENAI_SESSION_ARGS_JSON historically carried exec args.
    // - If it looks like a Windows wrapper command tuple (e.g. /d /s /c path.cmd),
    //   treat it as wrapper/prefix args for readiness + exec.
    // - If CE_OPENAI_SESSION_EXEC_ARGS_JSON is set, it takes precedence for exec-only args.
    this.commandPrefixArgs = legacyLooksLikeWrapper ? legacyArgs : [];
    this.execArgs = hasExplicitExecArgs
      ? explicitExecArgs
      : legacyLooksLikeWrapper
        ? []
        : legacyArgs;
    this.healthcheckTimeoutMs = envMs(
      'CE_OPENAI_SESSION_HEALTHCHECK_TIMEOUT_MS',
      DEFAULT_HEALTHCHECK_TIMEOUT_MS,
      { min: 1000, max: 120_000 }
    );
    this.refreshMode = parseRefreshMode(process.env.CE_OPENAI_SESSION_REFRESH_MODE);
    this.identityTtlMs = envInt('CE_OPENAI_SESSION_IDENTITY_TTL_MS', DEFAULT_IDENTITY_TTL_MS, {
      min: 1000,
      max: 60 * 60 * 1000,
    });
  }

  private buildCommandCandidates(configuredCommand: string | undefined): CommandSpec[] {
    const explicit = configuredCommand?.trim();
    if (explicit) {
      return [{ command: explicit, prefixArgs: [], label: explicit }];
    }

    if (process.platform === 'win32') {
      return [
        { command: 'codex.cmd', prefixArgs: [], label: 'codex.cmd' },
        { command: DEFAULT_CODEX_COMMAND, prefixArgs: [], label: DEFAULT_CODEX_COMMAND },
        { command: 'npx.cmd', prefixArgs: ['-y', '@openai/codex'], label: 'npx.cmd -y @openai/codex' },
        { command: 'npx', prefixArgs: ['-y', '@openai/codex'], label: 'npx -y @openai/codex' },
      ];
    }

    const defaults: CommandSpec[] = [
      { command: DEFAULT_CODEX_COMMAND, prefixArgs: [], label: DEFAULT_CODEX_COMMAND },
      { command: 'npx', prefixArgs: ['-y', '@openai/codex'], label: 'npx -y @openai/codex' },
    ];

    return defaults;
  }

  private isCommandNotFound(error: unknown): boolean {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    );
  }

  private missingCommandError(cause: unknown): AIProviderError {
    const tried = this.commandCandidates.map((candidate) => candidate.label).join(', ');
    return new AIProviderError({
      code: 'provider_unavailable',
      provider: this.id,
      message: `Codex session CLI command not found. Tried: ${tried}. Install Codex CLI or set CE_OPENAI_SESSION_CMD to an absolute executable path visible to the MCP server process.`,
      retryable: true,
      cause,
    });
  }

  private async runWithCommandFallback(args: {
    commandArgs: string[];
    cwd: string;
    timeoutMs: number;
    stdin?: string;
    signal?: AbortSignal;
  }): Promise<SpawnResult> {
    const candidates = this.selectedCommand ? [this.selectedCommand] : this.commandCandidates;
    let lastNotFoundError: unknown;

    for (const candidate of candidates) {
      try {
        const usesBatchWrapper = isWindowsBatchCommand(candidate.command);
        const effectiveCommand = usesBatchWrapper ? 'cmd' : candidate.command;
        const effectiveArgs = usesBatchWrapper
          ? [
              '/d',
              '/s',
              '/c',
              candidate.command,
              ...candidate.prefixArgs,
              ...this.commandPrefixArgs,
              ...args.commandArgs,
            ]
          : [...candidate.prefixArgs, ...this.commandPrefixArgs, ...args.commandArgs];
        const result = await runCommand({
          command: effectiveCommand,
          commandArgs: effectiveArgs,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs,
          stdin: args.stdin,
          signal: args.signal,
        });
        this.selectedCommand = candidate;
        return result;
      } catch (error) {
        if (this.isCommandNotFound(error)) {
          lastNotFoundError = error;
          continue;
        }
        throw error;
      }
    }

    throw this.missingCommandError(lastNotFoundError);
  }

  private async ensureSessionReady(workspacePath: string, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.healthcheckTimeoutMs;
    return this.ensureSessionReadyWithTimeout(workspacePath, timeoutMs, signal);
  }

  private async ensureSessionReadyWithTimeout(
    workspacePath: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const now = Date.now();
    if (
      this.refreshMode === 'ttl' &&
      this.identityCache &&
      now - this.identityCache.checkedAt < this.identityTtlMs
    ) {
      if (!this.identityCache.isLoggedIn) {
        throw new AIProviderError({
          code: 'provider_auth',
          provider: this.id,
          message:
            'Codex session is not authenticated. Run "codex login" in this environment, then retry.',
        });
      }
      return;
    }

    const statusResult = await this.runWithCommandFallback({
      commandArgs: ['login', 'status'],
      cwd: workspacePath,
      timeoutMs,
      signal,
    });

    if (statusResult.timedOut) {
      throw new AIProviderError({
        code: 'provider_timeout',
        provider: this.id,
        message: `Codex login status check timed out after ${timeoutMs}ms.`,
        retryable: true,
      });
    }

    const statusText = `${statusResult.stdout}\n${statusResult.stderr}`.toLowerCase();
    const isLoggedIn =
      (statusText.includes('logged in') || statusText.includes('chatgpt')) &&
      !statusText.includes('not logged in');

    if (!isLoggedIn) {
      // Do not cache negative auth state. This allows immediate recovery
      // after users re-authenticate without waiting for TTL expiry.
      this.identityCache = null;
      throw new AIProviderError({
        code: 'provider_auth',
        provider: this.id,
        message:
          'Codex session is not authenticated. Run "codex login" in this environment, then retry.',
      });
    }
    this.identityCache = { checkedAt: now, isLoggedIn: true };
  }

  private getRemainingBudgetMs(
    request: Pick<AIProviderRequest, 'timeoutMs' | 'deadlineMs'>,
    operation: string
  ): number {
    const remainingMs =
      typeof request.deadlineMs === 'number'
        ? request.deadlineMs - Date.now()
        : request.timeoutMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new AIProviderError({
        code: 'provider_timeout',
        provider: this.id,
        message: `Codex session ${operation} timed out before execution started.`,
        retryable: true,
      });
    }
    return Math.max(1, Math.floor(remainingMs));
  }

  async call(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.lastWorkspacePath = request.workspacePath;
    const readinessTimeoutMs = Math.min(
      this.healthcheckTimeoutMs,
      this.getRemainingBudgetMs(request, 'request')
    );
    try {
      await this.ensureSessionReadyWithTimeout(
        request.workspacePath,
        readinessTimeoutMs,
        request.signal
      );
    } catch (error) {
      // Some environments report inconsistent `login status` results.
      // Defer auth verdict to the actual `exec` call when readiness checks are inconclusive.
      // `login status` may timeout under shell/process pressure even though `exec` still works.
      if (
        !(error instanceof AIProviderError
          && (error.code === 'provider_auth' || error.code === 'provider_timeout'))
      ) {
        throw error;
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-codex-session-'));
    const outputFile = path.join(tmpDir, `last-message-${randomUUID()}.txt`);
    try {
      const commandArgs = [
        'exec',
        ...this.execArgs,
        '--json',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--output-last-message',
        outputFile,
        '-',
      ];
      const composedPrompt = [
        `Search Query: ${request.searchQuery}`,
        '',
        request.prompt?.trim() || request.searchQuery,
      ].join('\n');
      const execTimeoutMs = this.getRemainingBudgetMs(request, 'request');

      const result = await this.runWithCommandFallback({
        commandArgs,
        cwd: request.workspacePath,
        timeoutMs: execTimeoutMs,
        stdin: composedPrompt,
        signal: request.signal,
      });

      if (result.timedOut) {
        throw new AIProviderError({
          code: 'provider_timeout',
          provider: this.id,
          message: `Codex session request timed out after ${execTimeoutMs}ms.`,
          retryable: true,
        });
      }

      if (result.exitCode !== 0) {
        const authFailure = classifyAuthError(result.stderr);
        const combinedSummary = summarizeStderr([result.stderr, result.stdout].filter(Boolean).join(' '));
        const usageLimitFailure = classifyUsageLimitError(`${result.stdout}\n${result.stderr}`);
        throw new AIProviderError({
          code: authFailure ? 'provider_auth' : 'provider_exec_error',
          provider: this.id,
          message: authFailure
            ? 'Codex session authentication failed. Run "codex login" and retry.'
            : usageLimitFailure
              ? `Codex session usage limit reached${combinedSummary ? `: ${combinedSummary}` : ''}.`
              : `Codex session provider failed with exit code ${result.exitCode}${combinedSummary ? `: ${combinedSummary}` : ''}.`,
          retryable: !authFailure && !usageLimitFailure,
        });
      }

      const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8').trim() : '';
      if (!text) {
        throw new AIProviderError({
          code: 'provider_parse_error',
          provider: this.id,
          message: 'Codex session provider returned an empty response.',
        });
      }

      return { text, model: this.modelLabel };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }
      throw new AIProviderError({
        code: 'provider_unavailable',
        provider: this.id,
        message: `Codex session provider unavailable: ${toMessage(error)}`,
        retryable: true,
        cause: error,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.ensureSessionReady(this.lastWorkspacePath);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
