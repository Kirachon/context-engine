type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function normalizeLevel(raw?: string): LogLevel {
  const value = (raw ?? 'info').toLowerCase();
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') {
    return value;
  }
  return 'info';
}

const CURRENT_LEVEL: LogLevel = normalizeLevel(process.env.CONTEXT_ENGINE_LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] <= LEVELS[CURRENT_LEVEL];
}

export function logDebug(...args: unknown[]): void {
  if (shouldLog('debug')) {
    console.error(...args);
  }
}

export function logInfo(...args: unknown[]): void {
  if (shouldLog('info')) {
    console.error(...args);
  }
}

export function logWarn(...args: unknown[]): void {
  if (shouldLog('warn')) {
    console.error(...args);
  }
}

export function logError(...args: unknown[]): void {
  console.error(...args);
}

