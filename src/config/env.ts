export function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return defaultValue;
}

export function envInt(name: string, defaultValue: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  const min = opts?.min;
  const max = opts?.max;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

export function envMs(name: string, defaultValue: number, opts?: { min?: number; max?: number }): number {
  // Alias for envInt for clarity when the unit is milliseconds.
  return envInt(name, defaultValue, opts);
}

export function envString(name: string, defaultValue?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (trimmed === '') return defaultValue;
  return trimmed;
}

export function envCsv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function envEnum<const T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T
): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim() as T;
  if (allowed.includes(normalized)) return normalized;
  throw new Error(
    `Invalid ${name} value "${raw}". Allowed values: ${allowed.join(', ')}`
  );
}

export const PERF_PROFILE_VALUES = ['default', 'fast', 'quality'] as const;
export type ParsedPerfProfile = typeof PERF_PROFILE_VALUES[number];

export function envPerfProfile(
  name: string = 'CE_PERF_PROFILE',
  defaultValue: ParsedPerfProfile = 'default'
): ParsedPerfProfile {
  return envEnum(name, PERF_PROFILE_VALUES, defaultValue);
}
