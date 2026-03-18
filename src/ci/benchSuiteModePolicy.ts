export type SuiteMode = 'pr' | 'nightly';
export type BenchMode = 'scan' | 'search' | 'retrieve';

export function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

export function resolveScanFallbackAllowed(mode: SuiteMode, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode !== 'pr') {
    return true;
  }
  const parsed = parseBooleanEnv(env.BENCH_SUITE_ALLOW_SCAN_FALLBACK);
  return parsed ?? false;
}

export function resolveModeProbeOrder(mode: SuiteMode, env: NodeJS.ProcessEnv = process.env): BenchMode[] {
  if (resolveScanFallbackAllowed(mode, env)) {
    return ['retrieve', 'search', 'scan'];
  }
  return ['retrieve', 'search'];
}

export function buildProbeFailureMessage(
  mode: SuiteMode,
  probeTimeoutMs: number,
  errors: string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const scanDisabledByPolicy = mode === 'pr' && !resolveScanFallbackAllowed(mode, env);
  const scanDisabledHint = scanDisabledByPolicy
    ? ' Scan fallback is mode-locked for PR KPI runs. Set BENCH_SUITE_ALLOW_SCAN_FALLBACK=true only for local diagnostics.'
    : '';
  return `Unable to run benchmark in any supported mode (probe timeout ${probeTimeoutMs}ms). ${errors.join(' | ')}${scanDisabledHint}`;
}
